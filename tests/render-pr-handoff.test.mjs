import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderPrHandoff, renderPrHandoffFromLedger } from '../scripts/render-pr-handoff.mjs';
import { LedgerError, initLedger, setState } from '../scripts/run-ledger.mjs';

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
  assert.match(out, /Mini Cindy 常驻程序按 PR 唯一修复 session/);
  assert.match(out, /lead 验收后立即清本地并归档该 owner/);
});

test('render-pr-handoff: SC 阶段结束后的收尾说明保留授权与硬停边界', () => {
  const out = renderPrHandoff(baseArgs());
  const afterSc = out.split('## 8. 做完之后（自动，不要问 lead）\n')[1].split('\n## 9. 禁做')[0];
  assert.match(afterSc, /SC PASS 只是子阶段完成，不是 owner 整体任务完成/);
  assert.match(afterSc, /所有 SC 都有 PASS 证据且没有 hard_stop、预算暂停或 blocked/);
  assert.match(afterSc, /正常返回同一 owner 继续本地 e2e 和 PR Ready 收尾/);
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

test('render-pr-handoff: 决策三层 + Jev 约定 + 连带策略 + 来源标注写进包里（Pi owner 不读 ~/.claude/rules）', () => {
  const journal = '/abs/run/jev/g4.jsonl';
  const out = renderPrHandoff(baseArgs({ jevJournal: journal }));
  const section = (name, next) => out.split(`## ${name}\n`)[1].split(`\n## ${next}`)[0];
  const s1 = section('1. 身份', '2. 为什么改');
  const s5 = section('5. allowed_paths', '6. SC 全文');
  const s8 = section('8. 做完之后（自动，不要问 lead）', '9. 禁做');
  const s10 = out.split('## 10. 回报格式\n')[1];
  assert.match(s1, /任务来源=task-priority final manifest/);
  assert.match(s5, /连带文件（包内预授权，逐条申报；上限 10 个文件、200 行/);
  assert.match(s5, /cindyplugin\/design-inventory\.md/);
  for (const needle of ['D0 事实题', 'D1 域内判断（可自决）', 'D2 必须停', 'keel', 'tool=jev', 'cindy_mcp_call_tool', 'mcp__cindy__ghost_call', 'confidence ≥ 0.75', 'JEV_UNAVAILABLE', 'JEV_DECISION_REQUEST', 'waiting-ci', 'gh pr checks', 'gh run rerun']) {
    assert.ok(s8.includes(needle), `第 8 段缺: ${needle}`);
  }
  assert.ok(s8.includes(journal), '第 8 段必须给 Jev 留痕绝对路径');
  assert.match(s8, /不给 Jev「上报 lead」选项/);
  assert.match(s8, /连带文件改动必须有 Jev 结论，没有就按 D2 必须停/);
  assert.match(s8, /不得以 waiting-ci 或「在等 CI」结束本轮/);
  assert.doesNotMatch(s8, /写 --phase waiting-ci 的 checkpoint 再结束本轮/);
  assert.doesNotMatch(s8, /owner-checkpoint\.py/);
  assert.match(s10, /collateral_used\[\{path, class, sc_id, reason, jev_ref\}\]/);
  assert.match(s10, /Jev 选项排序与留痕行号/);
  const ctx = renderPrHandoff(baseArgs({ provenance: { kind: 'context-brief', brief_sha256: 'f'.repeat(64) } }));
  assert.match(ctx, /任务来源=上下文方案（brief sha256=f{64}；未经 task-priority 七面覆盖与对抗质询/);
  assert.throws(() => renderPrHandoff(baseArgs({ jevJournal: 'rel/jev.jsonl' })), LedgerError);
});

test('render-pr-handoff: PR 状态用 KEEL 查，nextAction 只作参考、不加停点', () => {
  for (const out of [renderPrHandoff(baseArgs()), renderPrHandoff(baseArgs({ continuation: { command: 'python3 owner-checkpoint.py --phase x' } }))]) {
    const s8 = out.split('## 8. 做完之后（自动，不要问 lead）\n')[1].split('\n## 9. 禁做')[0];
    for (const needle of ['pr_status', 'pr_wait', 'KEEL_UNAVAILABLE', 'record-delivery', 'confirm-pr-open', 'agent-verify']) {
      assert.ok(s8.includes(needle), `第 8 段缺: ${needle}`);
    }
    // 评审线程归 Mini、Ready 后不追反馈：KEEL 的 nextAction 不得成为五类停之外的停点。
    assert.match(s8, /KEEL 的 nextAction 只作参考，不构成新停点：转 Ready、pr_ready、confirm-pr-open、goal_report 仍按本包原有规则与五类停判断，评审线程照旧归 Mini/);
    assert.doesNotMatch(s8, /不得转 Ready|不得收尾|pr_threads/);
    // 等 CI 不另立规则，沿用 continuation v1/v2 的 CI 等待规则。
    assert.match(s8, /等 CI 按上面的 CI 等待规则（未启用 continuation v2 时用 pr_wait）/);
    assert.doesNotMatch(s8, /pstack_start\(/);
  }
  assert.match(renderPrHandoff(baseArgs()), /用 KEEL 的 pr_wait 轮询[^。]*KEEL 不可用时降级为 gh pr checks <PR> --watch --interval 60/);
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

test('render-pr-handoff: 回归 mivo PR3——lead 补充在五类停外加停点即拒', () => {
  const cases = [
    { how: '【lead 补充，优先于第 8 段】先改 A', rule: /override-section-8/ },
    { how: '本 PR 必须由你派 GPT 单审 reviewer + e2e tester', rule: /local-review/ },
    { how: '写 decision checkpoint accept-PR3 并停下等 lead「开 PR」', rule: /wait-for-lead/ },
    { forbiddenExtra: ['lead 验收通过并下达「开 PR」指令之前 git push 或 gh pr create'], rule: /wait-for-lead|forbid-authorized-push/ },
    { forbiddenExtra: ['验收前不得 push'], rule: /forbid-authorized-push/ },
  ];
  for (const { rule, ...overrides } of cases) {
    assert.throws(() => renderPrHandoff(baseArgs(overrides)), (err) => err instanceof LedgerError
      && err.code === 'PACKET_EXTRA_STOP' && rule.test(err.message), JSON.stringify(overrides));
  }
});

test('render-pr-handoff: 合法禁令与否定式不误拦', () => {
  const out = renderPrHandoff(baseArgs({
    how: '本地禁止派 reviewer，不要 GPT 单审；按第 5 段连带策略改测试。',
    forbiddenExtra: ['合并 PR、启用 auto-merge、gh pr merge、force push', '直接 push main', 'git push --force'],
  }));
  assert.ok(out.includes('## 9. 禁做'));
});

function continuationLedger(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-cont-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, 'manifest.json');
  copyFileSync(FIXTURE, manifestPath);
  const ledgerPath = join(dir, 'ledger.json');
  initLedger({ ledgerPath, manifestPath, runId: 'cont-render', now: '2026-09-27T00:00:00Z', baseline: SHA3 });
  setState({
    ledgerPath,
    group: 'g4',
    now: '2026-09-27T00:00:00Z',
    identity: { worktree: ROOT, branch: 'feat/g4', base: SHA3, title: 'MivoPlugin-存图补图修复丨 0902' },
  });
  if (config !== undefined) writeFileSync(join(dir, 'lead-continuation.json'), JSON.stringify(config));
  const out = renderPrHandoffFromLedger({
    ledgerPath,
    group: 'g4',
    leadSessionId: 'lead-1',
    seq: 1,
    repo: 'xindong/mivo-canvas-plugin',
    title: 'MivoPlugin-存图补图修复丨 0902',
    why: 'Copy as PNG 失败时仍报已复制。',
    how: 'imageNodeClipboard.ts 走 libraryClipboardPort.write，失败走 copyPngFailed。',
    excerpts: [{ file: 'scripts/render-pr-handoff.mjs', line: 1, behavior: 'renderPrHandoff 入口' }],
  });
  return out;
}

function assertV1ContinuationHandoff(out) {
  assert.doesNotMatch(out, /owner-checkpoint\.py/);
  assert.doesNotMatch(out, /写 waiting-ci checkpoint 再结束本轮/);
  assert.doesNotMatch(out, /写 --phase waiting-ci 的 checkpoint 再结束本轮/);
  assert.match(out, /本包未启用 continuation v2，续跑调度只唤醒 lead、不会唤醒你/);
  assert.match(out, /gh pr checks <PR> --watch --interval 60/);
}

function assertV2ContinuationHandoff(out) {
  assert.match(out, /owner-checkpoint\.py/);
  assert.match(out, /启用 continuation v2 时，绑定完成后先写 checkpoint/);
  assert.match(out, /写 --phase waiting-ci 的 checkpoint 再结束本轮/);
  assert.doesNotMatch(out, /本包未启用 continuation v2/);
}

test('render-pr-handoff: 台账同目录 v1 配置不渲染 owner checkpoint', (t) => {
  assertV1ContinuationHandoff(continuationLedger(t, { lead_session_id: 'lead-1', ledger_paths: ['/abs/ledger.json'], stalled_after_sec: 1800 }));
});

test('render-pr-handoff: 台账同目录缺 lead-continuation.json 按 v1 口径写', (t) => {
  assertV1ContinuationHandoff(continuationLedger(t, undefined));
});

test('render-pr-handoff: schemaVersion 2 保持 checkpoint 命令与 waiting-ci 文案', (t) => {
  assertV2ContinuationHandoff(continuationLedger(t, { schemaVersion: 2, lead_session_id: 'lead-1', ledger_paths: ['/abs/ledger.json'] }));
});

test('render-pr-handoff: 直接传入 continuation 仍按 v2 渲染', () => {
  const out = renderPrHandoff(baseArgs({
    continuation: { command: "python3 '/abs/scripts/owner-checkpoint.py' --phase 'executing'" },
  }));
  assertV2ContinuationHandoff(out);
});
