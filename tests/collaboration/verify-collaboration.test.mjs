import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTimeline, scopeConflict, validatePR, safePath, checkMaterial, verifyRepository } from '../../scripts/verify-collaboration.mjs';

const base = JSON.parse(readFileSync(new URL('../../fixtures/collaboration/lifecycle.json', import.meta.url)));
const clone = () => structuredClone(base);
const invalid = (record, code) => assert.throws(() => validateTimeline(record), new RegExp(code));

test('normal lifecycle and no runtime authorization', () => {
  assert.deepEqual(validateTimeline(base), { state: 'done', authorization: false });
});
test('unknown events, missing fields, invalid transitions and label mismatch fail closed', () => {
  for (const [mutate, code] of [
    [r => r.events[0].event = 'EXECUTE', 'UNKNOWN_EVENT'],
    [r => delete r.events[1].base_sha, 'BASE_SHA'],
    [r => Object.assign(r.events[2], { event: 'WORK_COMPLETED', coordinator_id: 'coordinator' }), 'TRANSITION'],
    [r => r.label = 'ready', 'LABEL'],
    [r => r.events[1].scope_revision = 0, 'REVISION'],
    [r => r.events[1].agent_id = '', 'AGENT'],
    [r => r.events[1].coordinator_id = '', 'COORDINATOR'],
  ]) { const r = clone(); mutate(r); invalid(r, code); }
});
test('second confirmation is rejected even with a different claim ID', () => {
  const r = clone(); r.events.splice(2, 0, { ...r.events[1], id: 'second', claim_id: 'claim-other' });
  invalid(r, 'ACTIVE_CLAIM');
});
test('release, blocked recovery, abandonment and handoff', () => {
  for (const end of ['CLAIM_RELEASED', 'HANDOFF_READY']) {
    const r = clone(); r.events = r.events.slice(0, 2);
    if (end === 'HANDOFF_READY') r.events.push({ ...r.events[2-1], id: 'handoff-request', event: 'HANDOFF_REQUESTED' });
    r.events.push({ ...base.events[2], id: 'end', event: end,
      branch: 'feat/3-example', head_sha: 'b'.repeat(40), worktree_state: 'clean',
      changed_paths: [], completed: ['baseline'], remaining: ['implementation'],
      verification: ['baseline passed'], known_risks: ['synthetic'], recommended_next_step: 'recheck baseline' });
    if (end === 'CLAIM_RELEASED') { r.label = 'ready'; validateTimeline(r); }
    else {
      r.events.push({ ...base.events[0], id: 'new-request', agent_id: 'agent-b', base_sha: 'b'.repeat(40) },
        { ...base.events[1], id: 'new-confirm', agent_id: 'agent-b', claim_id: 'claim-b', base_sha: 'b'.repeat(40) });
      r.label = 'claimed'; validateTimeline(r);
      r.events.at(-1).claim_id = 'claim-a'; invalid(r, 'DUPLICATE_CLAIM');
    }
  }
  const r = clone(); r.events.splice(3, 0,
    { ...base.events[2], id: 'block', event: 'BLOCKED', reason: 'fixture unavailable' },
    { ...base.events[2], id: 'resume', event: 'BLOCK_CLEARED', coordinator_id: 'coordinator' });
  validateTimeline(r);
  for (const state of ['draft', 'ready', 'blocked']) {
    const a = clone(); a.initial_state = state === 'blocked' ? 'ready' : state;
    a.events = state === 'blocked' ? r.events.slice(0, 4) : []; a.label = 'abandoned';
    a.events.push({ id: 'abandon', decision: 'abandoned', coordinator_id: 'coordinator', reason: 'synthetic cancellation' });
    validateTimeline(a);
  }
  const draft = clone(); draft.initial_state = 'draft';
  draft.events.unshift({ id: 'ready', decision: 'ready', coordinator_id: 'coordinator', reason: 'scope reviewed' });
  validateTimeline(draft);
});
test('race rejection, audited expiry and baseline drift', () => {
  const r = clone();
  r.events.splice(1, 0, { ...base.events[0], id: 'request-b', agent_id: 'agent-b' },
    { id: 'reject-b', event: 'CLAIM_REJECTED', agent_id: 'agent-b', coordinator_id: 'coordinator', reason: 'one implementation owner' });
  validateTimeline(r);
  const e = clone(); e.events = e.events.slice(0, 2); e.label = 'ready';
  e.events.push({ ...base.events[2], id: 'expiry', event: 'CLAIM_EXPIRED', coordinator_id: 'coordinator',
    audit: { no_recoverable_work: true, head_sha: 'a'.repeat(40), worktree_state: 'clean', reason: 'owner released after audit' } });
  validateTimeline(e); delete e.events.at(-1).audit; invalid(e, 'EXPIRY_AUDIT');
  const drift = clone(); drift.events[2].head_sha = 'b'.repeat(40); invalid(drift, 'BASELINE');
  drift.events.splice(2, 0, { ...base.events[2], id: 'recheck', event: 'BASELINE_RECHECKED', head_sha: 'b'.repeat(40), reason: 'unrelated docs only', shared_interfaces_unchanged: true });
  validateTimeline(drift);
});
test('scope revision changes require request and confirmation; deadlines never transfer claims', () => {
  const r = clone(); r.events = r.events.slice(0, 3); r.label = 'in-progress';
  r.events.push({ ...base.events[2], id: 'change', event: 'SCOPE_CHANGE_CONFIRMED',
    scope_revision: 2, write_scope: ['tests/'], coordinator_id: 'coordinator' });
  invalid(r, 'SCOPE_REQUEST');
  r.events.splice(3, 0, { ...base.events[2], id: 'scope-request', event: 'SCOPE_CHANGE_REQUESTED', scope_revision: 2, write_scope: ['tests/'], shared_interfaces: [] });
  r.events.at(-1).shared_interfaces = []; validateTimeline(r);
  r.events.at(-1).scope_revision = 1; invalid(r, 'REVISION');
  const expired = clone(); expired.events = expired.events.slice(0, 2); expired.label = 'claimed';
  expired.events[1].expected_update_at = '2000-01-01T00:00:00Z';
  validateTimeline(expired);
  expired.events.push({ ...base.events[1], id: 'steal', agent_id: 'agent-b', claim_id: 'claim-b' });
  invalid(expired, 'ACTIVE_CLAIM');
});
test('amendments append references, cannot rewrite or authorize', () => {
  const r = clone(); r.events.push({ id: 'amend', event: 'AMENDMENT', target_id: 'request', note: 'Clarification only', agent_id: 'agent-a' });
  validateTimeline(r);
  r.events.at(-1).target_id = 'future'; invalid(r, 'AMENDMENT');
  r.events.at(-1).target_id = 'request'; r.events.at(-1).replacement = {}; invalid(r, 'AMENDMENT');
  r.events.at(-1).id = 'request'; invalid(r, 'EVENT_ID');
});
test('scope paths use component boundaries, reject ambiguous and escaping inputs', () => {
  for (const p of ['../x', '/x', 'a/../x', 'a//b', 'a\\b', '~/x', 'C:/x', '.', 'a/./b', 'a/*', 'a/%2e%2e/b']) assert.throws(() => safePath(p));
  const s = (paths, shared = []) => ({ write_scope: paths, shared_interfaces: shared });
  assert.equal(scopeConflict(s(['tests/']), s(['tests/a.mjs'])), 'path');
  assert.equal(scopeConflict(s(['tests/a']), s(['tests/ab'])), null);
  assert.equal(scopeConflict(s(['a/'], ['report meaning']), s(['b/'], ['report meaning'])), 'shared-interface');
  assert.throws(() => scopeConflict(s([]), s(['a/'])));
});
test('PR fields, exact confirmation binding, scope and independent reviews', () => {
  const claim = base.events[1];
  const pr = { issue: 3, claim_id: 'claim-a', scope_revision: 1, agent_id: 'agent-a',
    confirmation_url: claim.confirmation_url, write_scope: claim.write_scope,
    changed_paths: ['tests/example.mjs'], verification: ['test pass'],
    reviews: [{ kind: 'specification', reviewer: 'reviewer-b', approved: true }] };
  validatePR(pr, claim);
  for (const field of ['issue', 'claim_id', 'confirmation_url', 'write_scope', 'verification']) {
    const p = structuredClone(pr); delete p[field]; assert.throws(() => validatePR(p, claim));
  }
  for (const patch of [{ changed_paths: ['packages/core/a.ts'] }, { reviews: [] },
    { reviews: [{ kind: 'specification', reviewer: 'agent-a', approved: true }] },
    { confirmation_url: 'https://example.com/wrong' }]) assert.throws(() => validatePR({ ...pr, ...patch }, claim));
});
test('sensitive material checks reject representative secrets, runtime files and locks', () => {
  for (const [p, text] of [['fixtures/collaboration/a.json', '/Users/example/profile'],
    ['fixtures/collaboration/a.json', 'ghp_' + 'a'.repeat(30)],
    ['.agents/claims/owner.lock', ''], ['fixtures/collaboration/.pm2/state.json', '{}'],
    ['fixtures/collaboration/claim-daemon.json', '{}']]) assert.throws(() => checkMaterial(p, text));
  checkMaterial('fixtures/collaboration/a.json', '{"synthetic":true}');
});
test('repository gate detects template drift, unsafe files and symlinked fixtures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-g1-test-'));
  try {
    for (const file of ['AGENTS.md', 'docs/06-multi-agent-collaboration.md',
      '.github/ISSUE_TEMPLATE/implementation.yml', '.github/pull_request_template.md',
      'fixtures/collaboration/lifecycle.json']) {
      const target = join(dir, file); mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, readFileSync(new URL('../../' + file, import.meta.url)));
    }
    verifyRepository(dir);
    const form = join(dir, '.github/ISSUE_TEMPLATE/implementation.yml');
    const original = readFileSync(form, 'utf8');
    writeFileSync(form, original.replace('required: true', 'required: false'));
    assert.throws(() => verifyRepository(dir), /FORM_objective/);
    writeFileSync(form, original);
    const unsafe = join(dir, 'fixtures/collaboration/unsafe.json');
    writeFileSync(unsafe, 'npm_' + 'a'.repeat(30));
    assert.throws(() => verifyRepository(dir), /MATERIAL_CONTENT/);
    rmSync(unsafe); symlinkSync('lifecycle.json', unsafe);
    assert.throws(() => verifyRepository(dir), /SYMLINK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
