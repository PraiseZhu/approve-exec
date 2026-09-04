import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wouldCreate, sessionTitle, titlePrefixForRepo, artPinSteps } from '../scripts/session-dispatch.mjs';
import { LedgerError } from '../scripts/run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/session-dispatch.mjs');

test('sessionTitle 与仓前缀', () => {
  assert.equal(sessionTitle({ project: 'MivoPlugin', task: '存图补图修复', mmdd: '0902' }), 'MivoPlugin-存图补图修复丨 0902');
  assert.equal(titlePrefixForRepo('xindong/mivo-canvas-plugin'), 'MivoPlugin');
  assert.equal(titlePrefixForRepo('makecindy/cindy'), 'Cindy');
  assert.equal(titlePrefixForRepo('Project Skills'), 'Skills');
});

test('sessionTitle 任务名必须含汉字，英文 kebab 拒', () => {
  assert.throws(() => sessionTitle({ project: 'MivoPlugin', task: 'verify-copy-461', mmdd: '0904' }), LedgerError);
  assert.throws(() => wouldCreate({ title: 'MivoPlugin-verify-copy-461丨 0904', working_dir: ROOT }), LedgerError);
});

test('wouldCreate dry-run 参数 exact，真派拒', () => {
  const c = wouldCreate({ title: 'Skills-开工闸收据丨 0902', working_dir: '/Users/praise/AI-Agent/Claude/projects/Project Skills/approve-exec' });
  assert.deepEqual(c, {
    title: 'Skills-开工闸收据丨 0902',
    working_dir: '/Users/praise/AI-Agent/Claude/projects/Project Skills/approve-exec',
    agent_kind: 'pi',
    model: 'grok-4.6',
    effort: 'high',
    use_worktree: true,
  });
  assert.throws(() => wouldCreate({ title: 'bad', working_dir: '/tmp' }), LedgerError);
  const steps = artPinSteps('89ed9bf8-6df2-4239-bbff-2b52cc4a8f19');
  assert.equal(steps[1].args.provider_id, 'art');
});

test('CLI --dry-run 写出参数，不调 send_to_session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-dispatch-'));
  const out = join(dir, 'would-create.json');
  const r = spawnSync(process.execPath, [
    SCRIPT, '--dry-run',
    '--title', 'Skills-开工闸收据丨 0902',
    '--working-dir', ROOT,
    '--out', out,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(json.agent_kind, 'pi');
  assert.equal(json.model, 'grok-4.6');
  assert.equal(json.effort, 'high');
  const r2 = spawnSync(process.execPath, [
    SCRIPT, '--title', 'Skills-开工闸收据丨 0902', '--working-dir', ROOT,
  ], { encoding: 'utf8' });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /dry-run|send_to_session/);
  rmSync(dir, { recursive: true, force: true });
});
