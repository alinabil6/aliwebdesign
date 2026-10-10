import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('repository contains CI workflow and README', () => {
  assert.equal(fs.existsSync(new URL('../../.github/workflows/ci.yml', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../../README.md', import.meta.url)), true);
});
