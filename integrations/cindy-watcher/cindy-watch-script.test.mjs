import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('python _summary keeps orphanGuards and detail', () => {
  const py = fileURLToPath(new URL('./cindy-watch-script.test.py', import.meta.url));
  const result = spawnSync('python3', [py], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
