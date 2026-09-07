import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic normalized records only. No GitHub access or runtime write authority.
const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.every(text);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function safePath(value) {
  requireThat(text(value) && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..'), 'PATH');
  return value;
}
function scope(record) {
  requireThat(list(record.write_scope) && record.write_scope.length > 0 && list(record.shared_interfaces), 'SCOPE');
  record.write_scope.forEach(safePath);
}
const contains = (parent, child) => parent === child || (parent.endsWith('/') && child.startsWith(parent));
export function scopeConflict(a, b) {
  scope(a); scope(b);
  if (a.write_scope.some(x => b.write_scope.some(y => contains(x, y) || contains(y, x)))) return 'path';
  if (a.shared_interfaces.some(x => b.shared_interfaces.includes(x))) return 'shared-interface';
  return null;
}

export function validatePR(pr, claim) {
  requireThat(pr && claim, 'PR_RECORD');
  for (const field of ['issue', 'claim_id', 'agent_id', 'scope_revision', 'confirmation_url', 'write_scope']) {
    requireThat(claim[field] !== undefined && same(pr[field], claim[field]), `PR_${field}`);
  }
  scope(claim);
  requireThat(list(pr.changed_paths) && pr.changed_paths.length > 0, 'PR_DIFF');
  for (const file of pr.changed_paths) {
    safePath(file);
    requireThat(!file.endsWith('/') && claim.write_scope.some(parent => contains(parent, file)), 'PR_SCOPE');
  }
  requireThat(list(pr.verification) && pr.verification.length > 0, 'PR_VERIFICATION');
  requireThat(list(claim.required_reviews) && Array.isArray(pr.reviews), 'PR_REVIEWS');
  const requiredReviews = new Set(claim.required_reviews);
  if (pr.changed_paths.some(p => /^(schemas\/|rules\/|packages\/core\/)/.test(p))) {
    requiredReviews.add('specification'); requiredReviews.add('security-quality');
  }
  if (pr.changed_paths.some(p => /^\.github\/workflows\/release/.test(p))) requiredReviews.add('release');
  for (const kind of requiredReviews) requireThat(pr.reviews.some(review =>
    review.kind === kind && review.approved === true && text(review.reviewer)
    && review.reviewer !== claim.agent_id), 'PR_INDEPENDENT_REVIEW');
  return true;
}

const events = new Set(['CLAIM_REQUESTED', 'CLAIM_CONFIRMED', 'CLAIM_REJECTED', 'CLAIM_RELEASED',
  'WORK_STARTED', 'PROGRESS_UPDATE', 'BASELINE_RECHECKED', 'SCOPE_CHANGE_REQUESTED',
  'SCOPE_CHANGE_CONFIRMED', 'BLOCKED', 'BLOCK_CLEARED', 'HANDOFF_REQUESTED', 'HANDOFF_READY',
  'CLAIM_EXPIRED', 'COORDINATION_CONFLICT', 'PR_READY', 'WORK_COMPLETED', 'AMENDMENT']);
const coordinatorEvents = new Set(['CLAIM_CONFIRMED', 'CLAIM_REJECTED', 'SCOPE_CHANGE_CONFIRMED',
  'BLOCK_CLEARED', 'CLAIM_EXPIRED', 'WORK_COMPLETED']);

export function validateTimeline(record) {
  requireThat(record?.synthetic === true && Array.isArray(record.events), 'RECORD');
  requireThat(['draft', 'ready', 'abandoned'].includes(record.initial_state), 'INITIAL_STATE');
  let state = record.initial_state, claim = null, pendingScope = null, revision = 0, handoff = null;
  const ids = new Map(), claims = new Set(), requests = new Map();
  for (const event of record.events) {
    if (event?.decision !== undefined) {
      requireThat(text(event.id) && !ids.has(event.id) && text(event.coordinator_id)
        && text(event.reason) && !event.event, 'DECISION');
      requireThat((event.decision === 'ready' && state === 'draft')
        || (event.decision === 'abandoned' && ['draft', 'ready', 'blocked'].includes(state)), 'DECISION_TRANSITION');
      state = event.decision; claim = null; requests.clear(); pendingScope = null;
      ids.set(event.id, event); continue;
    }
    requireThat(event && events.has(event.event), 'UNKNOWN_EVENT');
    requireThat(text(event.id) && !ids.has(event.id), 'EVENT_ID');
    requireThat(!('edited' in event) && !('replacement' in event), 'AMENDMENT_REWRITE');
    if (event.event === 'AMENDMENT') {
      const target = ids.get(event.target_id);
      requireThat(target && text(event.note) && (text(event.coordinator_id)
        || (text(event.agent_id) && event.agent_id === target.agent_id)), 'AMENDMENT');
      requireThat(Object.keys(event).every(k => ['id', 'event', 'target_id', 'note', 'agent_id', 'coordinator_id'].includes(k)), 'AMENDMENT_AUTHORITY');
      ids.set(event.id, event); continue;
    }
    requireThat(text(event.agent_id), 'AGENT');
    if (coordinatorEvents.has(event.event)) requireThat(text(event.coordinator_id), 'COORDINATOR');
    const transition = allowed => requireThat(allowed.includes(state), 'TRANSITION');
    const owner = () => requireThat(claim && claim.claim_id === event.claim_id && claim.agent_id === event.agent_id, 'OWNER');
    switch (event.event) {
      case 'CLAIM_REQUESTED':
        transition(['ready', 'claimed', 'handoff']);
        scope(event);
        requireThat(Number.isInteger(event.issue) && event.issue > 0 && sha(event.base_sha), 'BASE_SHA');
        requireThat(Number.isInteger(event.scope_revision) && event.scope_revision > 0, 'REVISION');
        requireThat(text(event.proposed_branch) && new RegExp(`^(feat|fix|docs|rules|release)/${event.issue}-[a-zA-Z0-9._-]+$`).test(event.proposed_branch), 'BRANCH');
        requests.set(event.agent_id, event); break;
      case 'CLAIM_CONFIRMED': {
        requireThat(!claim, 'ACTIVE_CLAIM'); transition(['ready', 'handoff']);
        if (state === 'handoff') requireThat(handoff, 'HANDOFF');
        scope(event);
        requireThat(sha(event.base_sha), 'BASE_SHA');
        requireThat(Number.isInteger(event.scope_revision) && event.scope_revision > 0 && event.scope_revision >= revision, 'REVISION');
        requireThat(text(event.claim_id) && !claims.has(event.claim_id), 'DUPLICATE_CLAIM');
        requireThat(list(event.required_reviews) && text(event.confirmation_url)
          && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+#issuecomment-\d+$/.test(event.confirmation_url), 'CONFIRMATION');
        requireThat(text(event.expected_update_at) && Number.isFinite(Date.parse(event.expected_update_at)), 'DEADLINE');
        const request = requests.get(event.agent_id);
        requireThat(request && ['issue', 'scope_revision', 'base_sha', 'write_scope', 'shared_interfaces'].every(k => same(request[k], event[k]))
          && request.proposed_branch === event.branch, 'REQUEST_BINDING');
        if (handoff) requireThat(event.base_sha === handoff.head_sha && event.agent_id !== handoff.agent_id, 'HANDOFF_BASE');
        claim = structuredClone(event); revision = event.scope_revision;
        claims.add(event.claim_id); requests.clear(); state = 'claimed'; handoff = null; break;
      }
      case 'CLAIM_REJECTED':
        requireThat(requests.has(event.agent_id) && text(event.reason), 'REQUEST'); requests.delete(event.agent_id); break;
      case 'WORK_STARTED':
        owner(); transition(['claimed']);
        requireThat(sha(event.head_sha) && event.head_sha === claim.base_sha && event.branch === claim.branch
          && text(event.worktree) && event.worktree_state === 'clean', 'BASELINE'); state = 'in-progress'; break;
      case 'CLAIM_RELEASED':
        owner(); transition(['claimed']); claim = null; state = 'ready'; break;
      case 'BLOCKED':
        owner(); transition(['in-progress']); requireThat(text(event.reason), 'BLOCK_REASON'); state = 'blocked'; break;
      case 'BLOCK_CLEARED': owner(); transition(['blocked']); state = 'in-progress'; break;
      case 'HANDOFF_REQUESTED': owner(); transition(['claimed', 'in-progress']); state = 'handoff'; break;
      case 'HANDOFF_READY':
        owner(); transition(['handoff']);
        requireThat(event.branch === claim.branch && sha(event.head_sha) && event.worktree_state === 'clean'
          && list(event.changed_paths) && list(event.completed) && list(event.remaining)
          && list(event.verification) && event.verification.length > 0 && list(event.known_risks)
          && text(event.recommended_next_step), 'HANDOFF');
        event.changed_paths.forEach(p => { safePath(p); requireThat(claim.write_scope.some(s => contains(s, p)), 'HANDOFF_SCOPE'); });
        handoff = { head_sha: event.head_sha, agent_id: claim.agent_id }; claim = null; break;
      case 'CLAIM_EXPIRED':
        owner(); transition(['claimed', 'in-progress', 'blocked']);
        requireThat(event.audit?.no_recoverable_work === true && event.audit.worktree_state === 'clean'
          && sha(event.audit.head_sha) && text(event.audit.reason), 'EXPIRY_AUDIT');
        claim = null; state = 'ready'; break;
      case 'SCOPE_CHANGE_REQUESTED':
        owner(); transition(['claimed', 'in-progress']); scope(event);
        requireThat(Number.isInteger(event.scope_revision) && event.scope_revision > revision, 'REVISION');
        pendingScope = event; break;
      case 'SCOPE_CHANGE_CONFIRMED':
        owner(); transition(['claimed', 'in-progress']); requireThat(pendingScope, 'SCOPE_REQUEST');
        requireThat(event.scope_revision > revision, 'REVISION');
        requireThat(['scope_revision', 'write_scope', 'shared_interfaces'].every(k => same(event[k], pendingScope[k])), 'SCOPE_BINDING');
        scope(event); revision = event.scope_revision;
        claim = { ...claim, scope_revision: revision, write_scope: event.write_scope, shared_interfaces: event.shared_interfaces };
        pendingScope = null; break;
      case 'PR_READY': owner(); transition(['in-progress']); requireThat(!pendingScope, 'SCOPE_PENDING'); validatePR(event.pr, claim); state = 'review'; break;
      case 'WORK_COMPLETED':
        owner(); transition(['review']); requireThat(sha(event.merged_sha) && list(event.acceptance) && event.acceptance.length > 0, 'ACCEPTANCE');
        claim = null; state = 'done'; break;
      case 'COORDINATION_CONFLICT': throw new Error('COORDINATION_CONFLICT');
      case 'BASELINE_RECHECKED':
        owner(); requireThat(sha(event.head_sha) && text(event.reason) && event.shared_interfaces_unchanged === true, 'BASELINE');
        claim.base_sha = event.head_sha; break;
      case 'PROGRESS_UPDATE': owner(); requireThat(sha(event.head_sha) && list(event.verification), 'PROGRESS'); break;
    }
    ids.set(event.id, event);
  }
  requireThat(state === record.label, 'LABEL');
  return { state, authorization: false };
}

export function checkMaterial(file, content) {
  safePath(file);
  requireThat(!/(?:^|\/)(?:\.pm2|DSH_HOME|sessions?|storage|credentials?)(?:\/|\.|$)|claims\/.*\.lock$|claim[^/]*(?:\.lock|daemon)/i.test(file), 'MATERIAL_PATH');
  requireThat(!/(?:\/Users\/|\/home\/|[A-Z]:\\|~\/)|(?:ghp_|github_pat_|npm_)[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[A-Z0-9]{16}/.test(content), 'MATERIAL_CONTENT');
}

export function verifyRepository(root) {
  const read = p => readFileSync(resolve(root, p), 'utf8');
  const protocol = read('docs/06-multi-agent-collaboration.md');
  for (const name of events) requireThat(protocol.includes('`' + name + '`'), `DOCUMENT_EVENT_${name}`);
  const agents = read('AGENTS.md').replace(/\s+/g, ' ');
  requireThat(agents.includes('CLAIM_CONFIRMED') && agents.includes('GitHub Issue 是协调记录，不是锁'), 'DOCUMENT_AUTHORITY');
  const form = read('.github/ISSUE_TEMPLATE/implementation.yml');
  const fields = [...form.matchAll(/^    id: (\w+)$/gm)].map(m => m[1]);
  requireThat(new Set(fields).size === fields.length, 'FORM_DUPLICATE');
  for (const field of ['objective', 'non_goals', 'parent', 'dependencies', 'scope_revision', 'write_scope', 'forbidden_scope', 'shared_interfaces', 'acceptance_criteria', 'verification', 'security_rollback', 'documentation', 'expected_update_interval']) {
    const block = form.split(`    id: ${field}\n`)[1]?.split('\n  - type:')[0];
    requireThat(block && /validations:\s+required: true/.test(block), `FORM_${field}`);
  }
  requireThat(form.includes('"status:draft"') && form.includes('"type:implementation"'), 'FORM_LABEL');
  const template = read('.github/pull_request_template.md');
  for (const token of ['Closes #', 'claim_id', 'confirmation URL', 'write_scope', 'Verification', 'rollback', 'Review requirements']) requireThat(template.includes(token), 'PR_TEMPLATE');
  const walk = dir => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      requireThat(!/claims\/.*\.lock$|claim[^/]*(?:\.lock|daemon)/i.test(file), 'CLAIM_MECHANISM');
      if (entry.isSymbolicLink()) throw new Error('SYMLINK');
      if (entry.isDirectory()) walk(file);
      else if (file.startsWith('fixtures/collaboration/') || file === 'docs/evidence/g1-static-fixtures.md') {
        requireThat(lstatSync(resolve(root, file)).size < 1000000, 'MATERIAL_SIZE');
        checkMaterial(file, read(file));
      }
    }
  };
  walk('');
  validateTimeline(JSON.parse(read('fixtures/collaboration/lifecycle.json')));
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyRepository(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    console.log('G1 static/fixture verification passed. Synthetic evidence only; no write authority or lock. Real rehearsal remains required.');
  } catch (error) { console.error(`G1 verification failed: ${error.message}`); process.exitCode = 1; }
}
