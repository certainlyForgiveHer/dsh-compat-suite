import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_DEPENDENCY, PACKAGE_NAME, PACKAGE_VERSION } from '../dist/index.js';

test('plugin bootstrap is read-only and points to core', () => {
  assert.equal(PACKAGE_NAME, '@miguel_tu/plugin');
  assert.equal(PACKAGE_VERSION, '0.0.0');
  assert.equal(CORE_DEPENDENCY, '@miguel_tu/core');
});
