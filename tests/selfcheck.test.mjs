// selfcheck 测试：sc-p0b（五类环境自检 + fail-closed 反向变异）+ sc-p2c（--live 接线机器可检）。
// 组结构（变异红集预测依据）：
//   组 A「routing 域」——缺档夹具 exit 2 点名 e2e 且其余三档 PASS（枚举精确性）、
//                       合法夹具 exit 0、无 --routing-file 读 config routingPath、
//                       文件缺失 exit 2 点名路径、JSON 不可解析 exit 2 点名、
//                       agent/effort 越枚举 exit 2 点名
//   组 B「live 域」——--live 两处接线（symlink 指向本仓 + 触发行）输出 PASS
//   组 C「CLI 拒绝」——未知参数 exit 2
// 预测红集：挖掉「档缺失」分支 → 组 A 缺档用例红；挖掉 agent/effort 枚举校验 → 组 A 越枚举两用例红；
//           挖掉解析 try/catch 或文件读取 try/catch → 对应组 A 用例红（崩溃 exit≠2）；
//           挖掉 live-symlink / live-trigger-line 检查 → 组 B 对应断言红。组 C 恒绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'scripts/selfcheck.mjs');
const FIX = {
  missingE2e: join(root, 'tests/fixtures/routing-missing-e2e.json'),
  valid: join(root, 'tests/fixtures/routing-valid.json'),
};

function runSelfcheck(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: 'utf8' });
}
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// 临时注入夹具（JSON 形状合法/非法路由）——仅测试用，用完即清
function withTempRouting(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-routing-'));
  const file = join(dir, 'routing.json');
  try {
    writeFileSync(file, content, 'utf8');
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('组A-1: 缺 e2e 档夹具 → exit 2 且点名 e2e 档缺失、其余三档仍 PASS', () => {
  const r = runSelfcheck(['--routing-file', FIX.missingE2e]);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  const text = out(r);
  assert.ok(text.includes('FAIL: routing-e2e'), `输出应点名 e2e 档，实际:\n${text}`);
  assert.ok(text.includes('档缺失'), `输出应含「档缺失」点名字样，实际:\n${text}`);
  for (const route of ['routing-execute', 'routing-review', 'routing-pr_merge']) {
    assert.ok(text.includes(`PASS: ${route}`), `其余档 ${route} 应保持 PASS，实际:\n${text}`);
  }
});

test('组A-2: 合法夹具 → exit 0', () => {
  const r = runSelfcheck(['--routing-file', FIX.valid]);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes('PASS: routing-e2e'), '合法夹具 e2e 档应 PASS');
});

test('组A-3: 无 --routing-file 时读 config 的 routingPath（真实环境全绿）→ exit 0', () => {
  const r = runSelfcheck([]);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
  const text = out(r);
  assert.ok(text.includes('PASS: routing-execute'), '应消费 config.routingPath 的真实 routing.json');
  assert.ok(text.includes('PASS: orca-fanout-worktree-ledger'), '② orca-fanout worktree-ledger 应 PASS');
  assert.ok(text.includes('PASS: orca-fanout-worktree-reclaim'), '② orca-fanout worktree-reclaim 应 PASS');
  assert.ok(text.includes('PASS: goal-skill-md'), '③ goal SKILL.md 应 PASS');
  assert.ok(text.includes('PASS: run-ledger-dir'), '④ runLedgerDir 应 PASS');
});

test('组A-4: --routing-file 指向不存在文件 → exit 2 且点名路径', () => {
  const missing = '/nonexistent/selfcheck-routing.json';
  const r = runSelfcheck(['--routing-file', missing]);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes(missing), `输出应点名缺失路径，实际:\n${out(r)}`);
});

test('组A-5: routing JSON 不可解析 → exit 2 且点名解析失败', () => {
  withTempRouting('{ "execute": {', (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('解析失败'), `输出应点名解析失败，实际:\n${out(r)}`);
  });
});

test('组A-6: agent 越枚举（不在 {codex, claude-code}）→ exit 2 且点名', () => {
  const body = JSON.stringify({
    execute: { agent: 'cobol', model: 'm', effort: 'max' },
    review: { agent: 'codex', model: 'm', effort: 'xhigh' },
    e2e: { agent: 'codex', model: 'm', effort: 'high' },
    pr_merge: { agent: 'claude-code', model: 'm', effort: 'medium' },
  });
  withTempRouting(body, (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('agent=cobol'), `输出应点名非法 agent 值，实际:\n${out(r)}`);
  });
});

test('组A-7: effort 越六枚举 → exit 2 且点名', () => {
  const body = JSON.stringify({
    execute: { agent: 'claude-code', model: 'm', effort: 'turbo' },
    review: { agent: 'codex', model: 'm', effort: 'xhigh' },
    e2e: { agent: 'codex', model: 'm', effort: 'high' },
    pr_merge: { agent: 'claude-code', model: 'm', effort: 'medium' },
  });
  withTempRouting(body, (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('effort=turbo'), `输出应点名非法 effort 值，实际:\n${out(r)}`);
  });
});

test('组B-1: --live 接线两处（symlink 指向本仓 + 触发行）→ exit 0 且两项 PASS', () => {
  const r = runSelfcheck(['--live', '--routing-file', FIX.valid]);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
  const text = out(r);
  assert.ok(text.includes('PASS: live-symlink'), `live-symlink 应 PASS，实际:\n${text}`);
  assert.ok(text.includes('PASS: live-trigger-line'), `live-trigger-line 应 PASS，实际:\n${text}`);
});

test('组C-1: 未知参数 → exit 2', () => {
  const r = runSelfcheck(['--bogus']);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes('未知参数'), `输出应点名未知参数，实际:\n${out(r)}`);
});
