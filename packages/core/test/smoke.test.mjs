import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../dist/index.js';

test('core bootstrap exports stable package metadata', () => {
  assert.equal(PACKAGE_NAME, '@miguel_tu/core');
  assert.equal(PACKAGE_VERSION, '0.0.0');
});
