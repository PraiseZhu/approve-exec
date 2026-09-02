import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/evolution-note.mjs');

function run(dir, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, APPROVE_EXEC_SKILL_ROOT: dir },
  });
}

test('evolution-note: add 去重 + 默认不碰 git + list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-evo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let r = run(dir, ['add', '--fingerprint', 'split-wrong-helper', '--tier', 'auto', '--title', '拆错：共用 helper']);
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(r.stdout);
  assert.equal(first.isNew, true);
  assert.equal(first.sync.skipped, 'no-sync-default');
  r = run(dir, ['add', '--fingerprint', 'split-wrong-helper', '--tier', 'auto', '--title', '拆错：共用 helper']);
  assert.equal(r.status, 0, r.stderr);
  const second = JSON.parse(r.stdout);
  assert.equal(second.isNew, false);
  assert.equal(second.entry.occurrences, 2);
  r = run(dir, ['list']);
  const listed = JSON.parse(r.stdout);
  assert.equal(listed.count, 1);
  const md = readFileSync(join(dir, 'EVOLUTION.md'), 'utf8');
  assert.match(md, /approve-exec 自进化台账/);
  assert.match(md, /split-wrong-helper/);
});

test('evolution-note: 非法 fingerprint / 扩权 proposal 不降档', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-evo-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let r = run(dir, ['add', '--fingerprint', 'NO', '--tier', 'auto', '--title', 'x']);
  assert.equal(r.status, 1);
  r = run(dir, ['add', '--fingerprint', 'priv-expand', '--tier', 'proposal', '--title', '扩权']);
  assert.equal(r.status, 0, r.stderr);
  r = run(dir, ['add', '--fingerprint', 'priv-expand', '--tier', 'auto', '--title', '扩权']);
  const again = JSON.parse(r.stdout);
  assert.equal(again.entry.tier, 'proposal');
});
