import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderPrHandoff } from '../scripts/render-pr-handoff.mjs';
import { LedgerError } from '../scripts/run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/render-pr-handoff.mjs');
const FIXTURE = join(ROOT, 'tests/fixtures/sample-manifest.json');
const SHA3 = 'c'.repeat(40);

function packet() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')).dispatch.packets[0];
}

function baseArgs(overrides = {}) {
  return {
    packet: packet(),
    identity: { worktree: ROOT, branch: 'feat/g4', base: SHA3 },
    leadSessionId: 'lead-1',
    seq: 1,
    repo: 'xindong/mivo-canvas-plugin',
    title: 'MivoPlugin-存图补图修复丨 0902',
    snapshot: '渲染当时快照，派工时再读',
    why: 'Copy as PNG 失败时仍报已复制。',
    how: 'imageNodeClipboard.ts 走 libraryClipboardPort.write，失败走 copyPngFailed。',
    excerpts: [{ file: 'scripts/render-pr-handoff.mjs', line: 1, behavior: 'renderPrHandoff 入口' }],
    ...overrides,
  };
}

test('render-pr-handoff: 0–10 段齐全，含开工闸与绝对路径', () => {
  const out = renderPrHandoff(baseArgs());
  assert.equal(out.startsWith('用 goal skill 执行。\n'), true);
  for (const t of ['0. 开工闸', '1. 身份', '5. allowed_paths', '6. SC 全文', '8. 做完之后（自动，不要问 lead）', '10. 回报格式']) {
    assert.ok(out.includes(`## ${t}`), `缺段 ${t}`);
  }
  assert.ok(out.includes('/Users/praise/.agents/skills/goal/SKILL.md'));
  assert.ok(out.includes('/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json'));
  assert.ok(out.includes('丨 0902'));
  assert.ok(out.includes('model-route show'));
  assert.ok(out.includes('子 session 不合入'), '开工包第 8 段应禁止子 session 合入');
  assert.ok(out.includes('PR Ready') || out.includes('PR_READY'), '开工包应声明责任终点是 PR Ready');
  assert.ok(out.includes('检查点'), '开工包应声明 candidate 只是检查点');
  assert.ok(out.includes('可自决') && out.includes('必须停'), '开工包应含可自决/必须停');
  assert.ok(out.includes('429') && out.includes('fallbacks'), '开工包应声明 429 走 fallbacks');
  assert.ok(out.includes('fallbacks_tried'), '开工包交卷字段必须是 fallbacks_tried');
  assert.ok(!out.includes('tried_fallbacks'), '开工包禁止混用 tried_fallbacks');
  assert.ok(out.includes('崩溃') || out.includes('异常终止'), '开工包应声明 worker 崩溃走 fallbacks');
  assert.ok(out.includes('不换代次'), '开工包降级只换 provider 不换代次');
  assert.ok(out.includes('假设破裂必须 blocked 上报'), '开工包第 9 段应禁就地改方案');
  assert.ok(out.includes('不得改总表'), '开工包第 9 段应禁改总表');
  assert.match(out, /start_team\(\{ worker_permission_mode: "bypassPermissions" \}\)/);
  assert.match(out, /返回 auto 不得创建/);
  assert.match(out, /只有 NO_PROVIDER_FOR_AGENT/);
  assert.match(out, /Retry-After/);
  assert.match(out, /必要门禁和远端 head 均已确认/);
  assert.match(out, /Mini 仅在 owner 挂起、预算暂停、硬停或外部接管时接手/);
});

test('render-pr-handoff: SC 阶段结束后的收尾说明保留授权与硬停边界', () => {
  const out = renderPrHandoff(baseArgs());
  const afterSc = out.split('## 8. 做完之后（自动，不要问 lead）\n')[1].split('\n## 9. 禁做')[0];
  assert.match(afterSc, /SC PASS 只是子阶段完成，不是 owner 整体任务完成/);
  assert.match(afterSc, /所有 SC 都有 PASS 证据且没有 hard_stop、预算暂停或 blocked/);
  assert.match(afterSc, /正常返回同一 owner 继续审查和 PR Ready 收尾/);
  assert.match(afterSc, /不得通过切换阶段绕过停止条件/);
  assert.match(afterSc, /已明确授权的提交、推送、创建\/更新目标 PR 直接执行，不重复请示/);
  assert.match(afterSc, /只有对应动作确实未获授权时才停下请求决定/);
  assert.match(afterSc, /PR Ready 终点本身不产生新增授权/);
  assert.match(afterSc, /不授权创建 PR 或 merge/);
  assert.match(afterSc, /这段说明不是授权声明，不得自行补造声明/);
  // 空白包不能因说明文字变成 goal 可消费的常设授权；既有合入边界也不能丢失。
  assert.doesNotMatch(out, /^\s*OWNER_STANDING_AUTH:\s*PR_PUSH_AND_REPLY\s*$/m);
  assert.match(afterSc, /子 session 不合入/);
});

test('render-pr-handoff: 缺摘录或第 4 段复制第 2 段拒', () => {
  assert.throws(() => renderPrHandoff(baseArgs({ excerpts: [] })), LedgerError);
  assert.throws(() => renderPrHandoff(baseArgs({ excerpts: ['（本包未附摘录：子 session 仍须按 allowed_paths 开工，禁止 Grep 整模块。）'] })), LedgerError);
  assert.throws(() => renderPrHandoff(baseArgs({ why: '同一段', how: '同一段' })), LedgerError);
  const p = packet();
  p.verify_cmds = ['gh pr diff 461 --repo xindong/mivo-canvas-plugin'];
  assert.throws(() => renderPrHandoff(baseArgs({ packet: p })), LedgerError);
});

test('render-pr-handoff: 缺 allowed_paths 或乱序身份拒', () => {
  const p = packet();
  p.allowed_paths = ['scripts/'];
  assert.throws(() => renderPrHandoff(baseArgs({ packet: p })), LedgerError);
  assert.throws(() => renderPrHandoff(baseArgs({ identity: { worktree: 'rel', branch: 'b', base: SHA3 } })), LedgerError);
  assert.throws(() => renderPrHandoff(baseArgs({ title: 'no-sep 0902' })), LedgerError);
});

test('render-pr-handoff: packet.excerpts/how 可走 ledger 回退，缺则拒', () => {
  const p = packet();
  p.excerpts = [{ file: 'scripts/render-pr-handoff.mjs', line: 1, behavior: 'renderPrHandoff 入口' }];
  p.how = 'ledger 路由必须带真摘录与改法。';
  p.why = '缺 excerpts 不得出包。';
  const out = renderPrHandoff(baseArgs({ packet: p, excerpts: undefined, how: undefined, why: undefined }));
  assert.match(out, /scripts\/render-pr-handoff\.mjs:1/);
  const p2 = packet();
  assert.throws(() => renderPrHandoff(baseArgs({ packet: p2, excerpts: undefined, how: undefined })), LedgerError);
});

test('render-pr-handoff CLI: --packet + --identity 出包', () => {
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--packet', JSON.stringify(packet()),
    '--identity', JSON.stringify({ worktree: ROOT, branch: 'feat/g4', base: SHA3 }),
    '--lead-session-id', 'lead-1',
    '--seq', '1',
    '--repo', 'Skills',
    '--title', 'Skills-开工闸收据丨 0902',
    '--why', '夹具：开工包缺摘录不得派。',
    '--how', '补 render-pr-handoff 校验，缺 excerpts 即拒。',
    '--excerpts', JSON.stringify([{ file: 'scripts/render-pr-handoff.mjs', line: 1, behavior: 'renderPrHandoff 入口' }]),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /用 goal skill 执行。/);
  assert.match(r.stdout, /## 0\. 开工闸/);
});
