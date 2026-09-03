// SKILL.md 编排守则结构断言测试。
// 目标：lead 换会话后编排不漂回 D1（亲手执行 / lead 自跑 E/R / /code-review）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const skillDoc = readFileSync(join(root, 'SKILL.md'), 'utf8');
const ledgerSrc = readFileSync(join(root, 'scripts/run-ledger.mjs'), 'utf8');
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));
const defaultsKeys = Object.keys(defaults);
const gateBlock0 = readFileSync(join(root, '_tmp/handoff-gate-block-0.md'), 'utf8');

const MARKERS = [
  '## ① 身份与触发',
  '## ② 输入门：只消费 task-priority final manifest',
  '## ③ 总流程与席位',
  '## ④ 拆 PR、并行与合并顺序',
  '## ⑤ 开工包',
  '## ⑥ 独立 session 怎么派',
  '## ⑦ 模型现读纪律',
  '## ⑧ 子 session 闭环与 lead 指挥',
  '## ⑨ 台账与状态机',
  '## ⑩ 交卷 schema',
  '## ⑪ 预算告警如实声明',
  '## ⑫ `--dry-run`',
  '## ⑬ 不停机条款（仅五类停）',
  '## ⑭ 与提交 PR 的边界',
  '## ⑮ 保证等级声明',
  '## ⑯ 防越域与验收',
  '## ⑰ Fable 决策 sidecar（非第六席）',
  '## ⑱ 偏航补救与自进化',
];

function sectionBetween(marker, nextMarker) {
  const start = skillDoc.indexOf(marker);
  assert.ok(start >= 0, `marker 缺失: ${marker}`);
  const end = nextMarker ? skillDoc.indexOf(nextMarker, start) : skillDoc.length;
  assert.ok(end > start, `marker 越界: ${marker}`);
  return skillDoc.slice(start + marker.length, end);
}

test('frontmatter：name=approve-exec、trigger=批准执行', () => {
  const fm = skillDoc.slice(0, skillDoc.indexOf('---', 3));
  assert.match(fm, /name:\s*approve-exec/);
  assert.match(fm, /trigger:\s*批准执行/);
  assert.ok(skillDoc.includes('批准执行'), '正文应含触发词「批准执行」');
});

test('十八段 marker 齐全且顺序固定', () => {
  let pos = -1;
  for (const m of MARKERS) {
    const idx = skillDoc.indexOf(m, pos + 1);
    assert.ok(idx > pos, `marker 缺失或乱序: ${m}`);
    pos = idx;
  }
});

test('不得漂回 D1：禁止「亲手执行」与 lead 自跑 E/R', () => {
  assert.equal(skillDoc.includes('亲手执行'), false, 'SKILL.md 不得再写「亲手执行」');
  assert.equal(skillDoc.includes('lead 自跑 E/R'), false, 'SKILL.md 不得再写 lead 自跑 E/R');
  assert.equal(skillDoc.includes('/code-review high --fix'), false, 'SKILL.md 不得再钉 lead /code-review');
  assert.equal(skillDoc.includes('## ③ 五阶段状态机'), false, '不得保留 D1 段标题「五阶段状态机」');
  assert.equal(skillDoc.includes('## ④ 设计决策 D0–D4'), false, '不得保留 D1 段标题「设计决策 D0–D4」');
});

test('doc↔实现：「用 goal skill 执行。」带句号，且与开工闸原文一致', () => {
  const occurrences = skillDoc.split('用 goal skill 执行').length - 1;
  assert.ok(occurrences >= 1, 'SKILL.md 应至少出现一次「用 goal skill 执行」');
  assert.equal(
    skillDoc.split('用 goal skill 执行。').length - 1,
    occurrences,
    'SKILL.md 中每处「用 goal skill 执行」后都必须紧跟句号',
  );
  const pushes = [...ledgerSrc.matchAll(/lines\.push\('([^']+)'\);/g)].map((m) => m[1]);
  const implLiteral = pushes.find((s) => s.includes('goal skill'));
  if (implLiteral) {
    assert.ok(skillDoc.includes(implLiteral), `SKILL.md 应包含实现字面量: ${JSON.stringify(implLiteral)}`);
  }
});

test('第①段：开工闸代码块与 _tmp/handoff-gate-block-0.md 逐字一致', () => {
  const s1 = sectionBetween(MARKERS[0], MARKERS[1]);
  const fence = s1.match(/```\n([\s\S]*?)\n```/);
  assert.ok(fence, '①段应有开工闸 fenced code block');
  const expected = gateBlock0.replace(/^# 开工闸[^\n]*\n+/, '').trimEnd();
  assert.equal(fence[1].trimEnd(), expected, '①段开工闸代码块必须与 _tmp/handoff-gate-block-0.md 正文逐字一致');
  assert.ok(s1.includes('gate_goal'), '①段应点名 gate_goal');
  assert.ok(s1.includes('gate_routing'), '①段应点名 gate_routing');
  assert.ok(s1.includes('不得开工'), '①段应声明不得开工');
});

test('第②段：输入门三要素 + fail-closed 指路 task-priority，缺则不开跑', () => {
  const s2 = sectionBetween(MARKERS[1], MARKERS[2]);
  for (const key of ['waves', 'dispatch', 'receipts']) {
    assert.ok(s2.includes(key), `输入门段应提及 manifest 要素 ${key}`);
  }
  assert.ok(s2.includes('fail-closed'), '输入门段应声明 fail-closed');
  assert.ok(s2.includes('task-priority'), '输入门段应指路 task-priority');
  assert.ok(s2.includes('不开跑'), '输入门段应声明缺要素时不开跑');
});

test('第③段：DISPATCH_MODES 含 session；E=session；LEAD_SELF=V/P；WORKER=R/T', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('session'), '③段应声明 session 派工模式');
  assert.ok(s3.includes('DISPATCH_MODES'), '③段应点名 DISPATCH_MODES');
  assert.ok(/E[\s\S]{0,80}`session`/.test(s3) || s3.includes('E 席 `dispatch=session`') || s3.includes('| E | `session`'),
    '③段应声明 E.dispatch=session');
  assert.ok(s3.includes('LEAD_SELF_SEATS') && s3.includes('V') && s3.includes('P'),
    '③段应声明 LEAD_SELF_SEATS = V、P');
  assert.ok(s3.includes('WORKER_SEATS') && /R/.test(s3) && /T/.test(s3),
    '③段应声明 WORKER_SEATS = R、T');
  assert.ok(s3.includes('不准把 PI 写进路由档') || s3.includes('不准把 PI 写进'),
    '③段应禁止把 PI 写进 routing.json');
  assert.ok(s3.includes('0.7') && s3.includes('SiteScout'), '③段流程应含 0.7 SiteScout');
  const flow = s3.slice(s3.indexOf('→ 6.'), s3.indexOf('席位真相源'));
  const registerAt = flow.indexOf('register.mjs');
  const wrapupAt = flow.indexOf('wrapup-cleanup.mjs');
  const archiveAt = flow.indexOf('archive_sessions');
  assert.ok(registerAt >= 0 && wrapupAt >= 0 && archiveAt >= 0, '③段收尾应含 register / wrapup / archive');
  assert.ok(registerAt < wrapupAt && wrapupAt < archiveAt, '③段必须先 Mini 名册、再清本地、最后归档 PI');
});

test('第⑥段：send_to_session create + Art 钉 + 标题正则', () => {
  const s6 = sectionBetween(MARKERS[5], MARKERS[6]);
  assert.ok(s6.includes('send_to_session'), '⑥段应点名 send_to_session');
  assert.ok(s6.includes('agent_kind'), '⑥段应钉 agent_kind=pi');
  assert.ok(s6.includes('grok-4.6'), '⑥段应钉 model=grok-4.6');
  assert.ok(s6.includes('provider_id'), '⑥段应说明 create 无 provider_id');
  assert.ok(s6.includes('art'), '⑥段应钉 Art');
  assert.ok(s6.includes('丨'), '⑥段标题分隔符必须是 丨');
  assert.ok(s6.includes('{项目名}-{任务名}丨 {MMDD}'), '⑥段应给出标题格式');
});

test('第⑦段：现读同一份 routing.json，禁止把 luna/sol 当唯一派工值', () => {
  const s7 = sectionBetween(MARKERS[6], MARKERS[7]);
  assert.ok(s7.includes('routing.json'), '现读纪律段应提及 routing.json');
  assert.ok(s7.includes('/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json'),
    '⑦段应给出 routing.json 绝对路径');
  assert.ok(s7.includes('model-route show'), '⑦段应允许 model-route show');
  assert.ok(s7.includes('luna') && s7.includes('sol'), '⑦段应点名禁止抄 luna/sol');
  assert.ok(s7.includes('不要做的') || s7.includes('禁止把 luna'), '⑦段应写禁止事项');
});

test('第⑧段：create_workers ≥2 禁连续 create_worker 单发', () => {
  const s8 = sectionBetween(MARKERS[7], MARKERS[8]);
  assert.ok(s8.includes('create_workers'), '⑧段必须出现 create_workers 字面量');
  assert.ok(
    /≥2 worker[\s\S]*?禁连续[\s\S]*?create_worker[\s\S]*?单发/.test(s8),
    '⑧段应含「≥2 worker 禁连续 create_worker 单发」纪律链',
  );
  assert.ok(s8.includes('mem-probe'), '⑧段应要求派 tester/reviewer 前跑 mem-probe');
  assert.ok(s8.includes('这五种情况'), '⑧段应声明五类停');
  assert.ok(s8.includes('假设破裂'), '⑧段应含第 5 类停：假设破裂');
});

test('第⑨段：新组状态机 + identity 五段 + PR_RECEIPT_KEYS', () => {
  const s9 = sectionBetween(MARKERS[8], MARKERS[9]);
  for (const st of ['pending', 'dispatched', 'executing', 'blocked', 'e2e', 'review', 'accepted', 'pr-open', 'local-cleaned', 'archived', 'failed']) {
    assert.ok(s9.includes(st), `⑨段 GROUP_STATES 应含 ${st}`);
  }
  if (s9.includes('review_pass')) {
    assert.ok(s9.includes('删除'), '⑨段若提及 review_pass 必须是删除旧状态，不得当现行 GROUP_STATES');
  }
  if (s9.includes('verified')) {
    assert.ok(s9.includes('删除'), '⑨段若提及 verified 必须是删除旧状态，不得当现行组状态');
  }
  assert.ok(s9.includes('session_id') && s9.includes('title') && s9.includes('pr_url') && s9.includes('provider_id'),
    '⑨段 GROUP_KEYS 应新增 session_id/title/pr_url/provider_id');
  assert.ok(s9.includes('seq → worktree → branch → base → session_id'),
    '⑨段 identityDigest 顺序必须含 session_id');
  assert.ok(s9.includes('PR_RECEIPT_KEYS'), '⑨段应点名 PR_RECEIPT_KEYS');
  assert.ok(s9.includes('site_report') && s9.includes('replan_note'), '⑨段 EVENT_TYPES 应含 site_report/replan_note');
  assert.ok(s9.includes('note-event'), '⑨段应声明 note-event 入账通道');
  assert.ok(s9.includes('watch_registered'), '⑨段应点名 watch_registered');
  assert.ok(s9.includes('phase=ready') && s9.includes('仍可在 ready 之后写入'),
    '⑨段应声明验收后收尾不受 run 级 ready 冻结挡住');
  assert.ok(s9.includes('Mini 名册先于清场') || s9.includes('watch_registered'),
    '⑨段应声明 Mini 名册先于清场');
  assert.ok(s9.includes('pr-open-receipt') && s9.includes('cleanup-receipt') && s9.includes('archive-receipt'),
    '⑨段应收口开 PR / 清本地 / 归档的真实回执');
  assert.ok(s9.includes('register.mjs') && s9.includes('ledger_version') && s9.includes('assignment_seq'),
    '⑨段 Mini 名册应吃 register 回执，并绑定 ledger_version/assignment_seq');
  assert.ok(s9.includes('READY_FOR_LATER_SUBMIT_PR_SKILL'), '⑨段 run 级 ready 文案应保留 READY_FOR_LATER_SUBMIT_PR_SKILL 作为验收许可信号');
  assert.ok(s9.includes('archive_sessions') || skillDoc.includes('archive_sessions'),
    '正文应点名 archive_sessions 归档 PI session');
  assert.ok(s9.includes('splitting') && s9.includes('dispatching') && s9.includes('running') && s9.includes('accepting'),
    '⑨段 PHASE_ORDER 应为 splitting/dispatching/running/accepting/ready');
});

test('第⑩段：开工闸收据 + 终态交卷 exact schema', () => {
  const s10 = sectionBetween(MARKERS[9], MARKERS[10]);
  assert.ok(s10.includes('gate_goal') && s10.includes('gate_routing'), '⑩段应给出两类开工闸收据');
  assert.ok(s10.includes('goal_skill_sha256') && s10.includes('routing_sha256'), '⑩段收据必须含 sha256');
  for (const key of ['branch', 'tip_sha', 'scs', 'goal_skill_path', 'e2e', 'review', 'size_gate']) {
    assert.ok(s10.includes(key), `candidate 交卷应含键 ${key}`);
  }
  assert.ok(s10.includes('不得含 pr_url'), '⑩段应禁止 candidate 交卷带 pr_url');
  assert.ok(s10.includes('/Users/praise/.agents/skills/goal/SKILL.md'), 'goal_skill_path 必须钉 PI 自己的 goal');
});

test('第⑪段：budgetPauseUsd 不再被 lead 当机器闸 + --no-budget-pause', () => {
  const s11 = sectionBetween(MARKERS[10], MARKERS[11]);
  assert.ok(s11.includes('budgetPauseUsd'), '预算段应引用 budgetPauseUsd');
  assert.ok(s11.includes('--no-budget-pause'), '预算段应提及 --no-budget-pause');
  assert.ok(s11.includes('不再被 lead 当机器闸') || s11.includes('不跨 session 加总'),
    '⑪段应声明 lead 不跨 session 加总账单');
});

test('第⑫段：--dry-run 不调 send_to_session', () => {
  const s12 = sectionBetween(MARKERS[11], MARKERS[12]);
  assert.ok(s12.includes('--dry-run'), '⑫段应点名 --dry-run');
  assert.ok(s12.includes('不') && s12.includes('send_to_session'), '⑫段应声明不调 send_to_session');
});

test('第⑤段：开工包第 8 步禁止子 session 合入', () => {
  const s5 = sectionBetween(MARKERS[4], MARKERS[5]);
  assert.ok(s5.includes('子 session 不合入'), '⑤段应写明子 session 不合入');
});

test('第⑭段：本 skill 不合入、不跑三机同步，不改 submit-pr', () => {
  const s14 = sectionBetween(MARKERS[13], MARKERS[14]);
  assert.ok(s14.includes('三审'), '⑭段应声明三审不在本 skill');
  assert.ok(s14.includes('submit-pr') || s14.includes('提交 PR'), '⑭段应点名提交 PR skill');
  assert.ok(s14.includes('本 skill 不合入'), '⑭段应声明本 skill 不合入');
  assert.ok(s14.includes('不跑三机同步') || s14.includes('不跑三机'), '⑭段应声明不跑三机同步');
  assert.ok(s14.includes('子 session 不得自行 merge'), '⑭段应禁止子 session 自行 merge');
  assert.ok(s14.includes('archive_sessions'), '⑭段应点名归档 PI session');
});

test('第⑯段：lead 允许验收后开远端并归档 PI，禁止改产品代码', () => {
  const s16 = sectionBetween(MARKERS[15], MARKERS[16]);
  assert.ok(s16.includes('archive_sessions'), '⑯段应允许归档 PI session');
  assert.ok(s16.includes('不允许：改产品代码'), '⑯段仍禁止改产品代码');
  assert.ok(s16.includes('git merge') || s16.includes('不合入'), '⑯段应禁止 lead git merge');
  assert.ok(s16.includes('Mini 名册未写就清本地') || s16.includes('先注册 Mini'),
    '⑯段应禁止 Mini 名册未写就清本地');
});

test('第⑮段：保证等级 T1，不夸大成宿主拦截', () => {
  const s15 = sectionBetween(MARKERS[14], MARKERS[15]);
  assert.ok(s15.includes('T1'), '保证等级段应声明 T1');
  assert.ok(s15.includes('疏忽') || s15.includes('漂移'), '应声明防疏忽/漂移');
  assert.equal(s15.includes('防篡改'), false, '不得写「防篡改」类夸大措辞');
});

test('config 键名比对：SKILL.md 引用的 camelCase 键全部真实存在于 defaults.json', () => {
  const backtickTokens = [...skillDoc.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const camelCaseTokens = backtickTokens.filter((t) => /^[a-z][a-zA-Z0-9]*$/.test(t) && /[A-Z]/.test(t));
  const unknown = camelCaseTokens.filter((t) => !defaultsKeys.includes(t));
  assert.deepEqual(unknown, [], `SKILL.md 引用了 defaults.json 中不存在的键: ${unknown.join(', ')}`);
  const requiredKeys = ['budgetPauseUsd', 'routingPath'];
  for (const k of requiredKeys) {
    assert.ok(defaultsKeys.includes(k), `defaults.json 缺键 ${k}`);
    assert.ok(skillDoc.includes(k), `SKILL.md 应引用配置键 ${k}`);
  }
});

test('第⑰段：Fable sidecar 非第六席 + 禁止 create_worker 调 Fable', () => {
  const s17 = sectionBetween(MARKERS[16], MARKERS[17]);
  assert.ok(s17.includes('不进 `graph.json`'), '⑰段应声明不进 graph.json');
  assert.ok(s17.includes('routing.json'), '⑰段应声明 routing 不加 decision 档');
  assert.ok(s17.includes('fable-decision.json'), '⑰段应点名独立配置');
  assert.ok(s17.includes('decision-broker.mjs'), '⑰段应点名 broker');
  assert.ok(s17.includes('若无代理，grok 将停下来问用户的原句'), '⑰段应钉死唯一入场条件');
  assert.ok(s17.includes('human_exclusive'), '⑰段应含人独占布尔');
  assert.ok(s17.includes('handoff_hash'), '⑰段应含 handoff_hash');
  assert.ok(s17.includes('context_hash'), '⑰段应含 context_hash');
  assert.ok(s17.includes('decision_key'), '⑰段应含 decision_key');
  assert.ok(s17.includes('tools_used'), '⑰段应含 T1 闸一 tools_used');
  assert.ok(s17.includes('porcelain'), '⑰段应含 worktree 零 diff');
  assert.ok(s17.includes('非空字符串或非空对象'), '⑰段应钉死 handoff 非空');
  assert.ok(s17.includes('必传 worktree'), '⑰段应钉死 resolve 必传 worktree');
  assert.ok(s17.includes('bundle_hash'), '⑰段应钉死 bundle_hash 绑定 items');
  assert.ok(s17.includes('REQUEST_RECORD_KEYS'), '⑰段应声明 journal requests exact 校验');
  assert.ok(s17.includes('T1 纪律级，不是强制级'), '⑰段应如实声明隔离等级');
  assert.ok(s17.includes('decision_opened'), '⑰段应声明配额只在 opened 计数');
  assert.ok(s17.includes('DECISION_SUPERSEDED'), '⑰段应声明晚到不覆盖');
  assert.ok(s17.includes('禁止 `create_worker` 调 Fable') || s17.includes('禁止 create_worker 调 Fable'),
    '⑰段必须写明禁止 create_worker 调 Fable');
  assert.ok(s17.includes('claude-fable-5'), '⑰段应钉死 Fable 模型 id');
  assert.ok(s17.includes('Fable 只判断（强制）'), '⑰段应强制 Fable 只判断');
  assert.ok(s17.includes('任何落盘') && s17.includes('必须派 sub'), '⑰段应强制产出也派 sub');
});

test('第⑱段：replan 四类 + 自进化台账', () => {
  const s18 = sectionBetween(MARKERS[17], undefined);
  for (const a of ['repack', 'resplit', 'land-first', 'split-new']) {
    assert.ok(s18.includes(a), `⑱段应含处置 ${a}`);
  }
  assert.ok(s18.includes('evolution-note.mjs'), '⑱段应点名 evolution-note.mjs');
  assert.ok(s18.includes('ledger-triage.mjs'), '⑱段应点名每周自进化登记');
  assert.ok(s18.includes('扩权'), '⑱段应声明扩权永不自动落地');
});
