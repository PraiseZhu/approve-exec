// SKILL.md 编排守则结构断言测试（sc-p2b）。
// 目标：lead 换会话/换模型后编排行为不漂移——守则十五段齐全且与实现字面量同步。
//
// 断言口径：
// 1. frontmatter：name=approve-exec、trigger=批准执行、正文含触发词「批准执行」。
// 2. 十五段 marker 逐段齐全（精确段标题，防段落被删/改名漂移）。
// 3. doc↔实现同步①：「用 goal skill 执行。」字面量必须与 scripts/run-ledger.mjs
//    render-packet 模板（renderExecPacket 首行 lines.push）逐字一致——
//    提取实现侧字面量断言 SKILL.md 包含，且 SKILL.md 中每处「用 goal skill 执行」
//    后都必须紧跟「。」（不许文档侧各写各的、漏句号）。
// 4. config 键名比对：SKILL.md 中 backtick 包裹的 camelCase token 必须全部真实存在
//    于 config/defaults.json 键集（文档引用编造键名即红）；另断言 SC 明示的关键键
//    （workerTimeoutMinutes/reviewMaxRounds/budgetPauseUsd/routingPath/runLedgerDir）
//    确被文档引用。
// 5. 批量派工段（第⑨段）：必须出现 create_workers 字面量（批量工具名），
//    且含「≥2 worker 禁连续 create_worker 单发」的批量纪律表达。
// 6. .pr-intent.md 职责段（第⑪段）：创建责任在本 skill P 阶段。
// 7. 预算计量声明段（第⑫段）：如实声明计量方式（粗估/标注）。
// 8. 关键段级内容锚：② 输入门三要素 + fail-closed；③ archive 非 idle；
//    ⑤ 三类停 + --no-budget-pause；⑦ 禁内联等价契约；⑩ 术语边界；
//    ⑬ 三条接受残余；⑭ 保证等级 T1 不夸大。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const skillDoc = readFileSync(join(root, 'SKILL.md'), 'utf8');
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));
const defaultsKeys = Object.keys(defaults);

// 十五段精确 marker（段标题与 SKILL.md 逐字一致；缺失/改名即红）
const MARKERS = [
  '## ① 身份与触发',
  '## ② 输入门：只消费 task-priority final manifest',
  '## ③ 五阶段状态机与每边三动作',
  '## ④ 设计决策 D0–D4',
  '## ⑤ 不停机条款（仅三类停）',
  '## ⑥ 断点续跑：--resume <run_id>',
  '## ⑦ 模型现读纪律',
  '## ⑧ pr-submit-gate 传导',
  '## ⑨ 批量派工与槽位纪律',
  '## ⑩ 术语边界：V 阶段验收组 ≠ orca-fanout verify 组',
  '## ⑪ P 阶段职责：.pr-intent.md workfile',
  '## ⑫ 预算告警如实声明',
  '## ⑬ 已知残余声明',
  '## ⑭ 保证等级声明',
  '## ⑮ 破坏性变更迁移表（旧用法 → 现在 → 替代）',
];

// 取第 N 段（marker N 到 marker N+1）之间的文本
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

test('十五段 marker 齐全且顺序固定', () => {
  let pos = -1;
  for (const m of MARKERS) {
    const idx = skillDoc.indexOf(m, pos + 1);
    assert.ok(idx > pos, `marker 缺失或乱序: ${m}`);
    pos = idx;
  }
});


test('config 键名比对：SKILL.md 引用的 camelCase 键全部真实存在于 defaults.json', () => {
  const backtickTokens = [...skillDoc.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const camelCaseTokens = backtickTokens.filter((t) => /^[a-z][a-zA-Z0-9]*$/.test(t) && /[A-Z]/.test(t));
  const unknown = camelCaseTokens.filter((t) => !defaultsKeys.includes(t));
  assert.deepEqual(unknown, [], `SKILL.md 引用了 defaults.json 中不存在的键: ${unknown.join(', ')}`);
  // SC 明示的关键键必须确被文档引用（防文档删引用而实现键还在）
  const requiredKeys = ['workerTimeoutMinutes', 'reviewMaxRounds', 'budgetPauseUsd', 'routingPath', 'runLedgerDir'];
  for (const k of requiredKeys) {
    assert.ok(defaultsKeys.includes(k), `defaults.json 缺键 ${k}（文档已引用）`);
    assert.ok(skillDoc.includes(k), `SKILL.md 应引用配置键 ${k}`);
  }
});

test('第⑨段：批量派工 create_workers 字面量 + ≥2 worker 禁连续 create_worker', () => {
  const s9 = sectionBetween(MARKERS[8], MARKERS[9]);
  assert.ok(s9.includes('create_workers'), '批量派工段必须出现 create_workers 字面量（批量工具名）');
  // 纪律链按序断言（防「只出现 create_worker 一词即过」的空转：把禁连续改成允许语也能过旧断言）
  assert.ok(
    /≥2 worker[\s\S]*?禁连续[\s\S]*?create_worker[\s\S]*?单发/.test(s9),
    '批量派工段应含「≥2 worker 禁连续 create_worker 单发」纪律链（仅出现 create_worker 一词不通过）'
  );
});

test('第⑪段：.pr-intent.md workfile 创建责任在本 skill P 阶段', () => {
  const s11 = sectionBetween(MARKERS[10], MARKERS[11]);
  assert.ok(s11.includes('.pr-intent.md'), 'P 阶段段应提及 .pr-intent.md workfile');
  assert.ok(s11.includes('创建责任在本 skill 的 P 阶段'), '应声明 .pr-intent.md 创建责任在本 skill P 阶段（非 submit-pr）');
  assert.ok(s11.includes('intent-check'), 'P 阶段段应提及 intent-check');
});

test('第⑫段：预算告警如实声明（计量方式 + 粗估标注）', () => {
  const s12 = sectionBetween(MARKERS[11], MARKERS[12]);
  assert.ok(s12.includes('budgetPauseUsd'), '预算段应引用 budgetPauseUsd 键');
  assert.ok(s12.includes('计量方式'), '暂停消息应标注计量方式');
  assert.ok(s12.includes('粗估'), '应如实声明粗估计量（不可见时的估算路径）');
  assert.ok(s12.includes('--no-budget-pause'), '预算段应提及 --no-budget-pause 关闭第三类停');
});

test('第②段：输入门三要素 + fail-closed 指路 task-priority', () => {
  const s2 = sectionBetween(MARKERS[1], MARKERS[2]);
  for (const key of ['waves', 'dispatch', 'receipts']) {
    assert.ok(s2.includes(key), `输入门段应提及 manifest 要素 ${key}`);
  }
  assert.ok(s2.includes('fail-closed'), '输入门段应声明 fail-closed');
  assert.ok(s2.includes('task-priority'), '输入门段应指路 task-priority');
  assert.ok(s2.includes('不开跑'), '输入门段应声明缺要素时不开跑（fail-closed 行为，非仅标签）');
  assert.ok(s2.includes('无机器校验'), '输入门段应如实标注 receipts 顶层键无机器校验（诚实标注优先于假装有强制）');
});

test('第⑥段：--resume 是触发词参数而非 run-ledger CLI 子命令（两审查席误读点）', () => {
  const s6 = sectionBetween(MARKERS[5], MARKERS[6]);
  assert.ok(s6.includes('触发词参数'), '断点续跑段应声明 --resume 是 skill 触发词参数');
  assert.ok(s6.includes('未知子命令'), '应写明对 run-ledger.mjs 传 --resume 会得「未知子命令」');
  assert.ok(s6.includes('由 lead 执行'), '恢复动作应声明执行者是 lead');
  assert.ok(s6.includes('writeLedgerAtomic'), 'CAS 乐观锁应点名机器闸 writeLedgerAtomic');
});

test('第⑮段：破坏性变更迁移表——六条迁移项逐条锚定', () => {
  const s15 = sectionBetween(MARKERS[14], undefined);
  assert.ok(s15.includes('--ready-check-exit0'), '迁移①应点名已移除 flag --ready-check-exit0');
  assert.ok(s15.includes('--ready-receipt'), '迁移①应给出替代 --ready-receipt');
  assert.ok(s15.includes('--verify-status') && s15.includes('--verify-evidence-ref'), '迁移②应点名两个已移除手工写入口');
  assert.ok(s15.includes('record-delivery'), '迁移②应指向 record-delivery 唯一通道');
  assert.ok(s15.includes('TEST_FILES'), '迁移③应点名 run-tests.mjs 冻结数组 TEST_FILES');
  assert.ok(s15.includes('HASH_MISMATCH'), '迁移④应含 HASH_MISMATCH 退出码名');
  assert.ok(s15.includes('FROZEN'), '迁移⑤应含 FROZEN 冻结退出码名');
  assert.ok(s15.includes('selfcheck.mjs --live'), '迁移⑥应含 selfcheck --live 自检命令');
  assert.ok(s15.includes('实测'), '迁移表应标注退出码为实测（实证而非纸面描述）');
});

test('第③段：每边三动作——archive 非 idle（idle 不释放槽位）+ mem-probe 重算', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('archive'), '三动作段应含 archive');
  assert.ok(s3.includes('idle'), '三动作段应提及 idle');
  assert.ok(/idle\s*只释放进程\s*、\s*\*\*不释放槽位\*\*/.test(s3), '应明示 idle 不释放槽位');
  assert.ok(s3.includes('mem-probe'), '三动作段应含 mem-probe 槽位重算');
});

test('第⑤段：仅三类停 + 禁确认句式 + --no-budget-pause 关第三类', () => {
  const s5 = sectionBetween(MARKERS[4], MARKERS[5]);
  assert.ok(s5.includes('autonomous-execution'), '三类停应含 autonomous-execution 硬停清单');
  assert.ok(s5.includes('A 类'), '三类停应含 A 类配置 fail-closed');
  assert.ok(s5.includes('--no-budget-pause'), '应声明 --no-budget-pause 关闭预算暂停');
  assert.ok(s5.includes('AskUserQuestion'), '应声明禁确认句式');
  assert.ok(s5.includes('3 轮零增量'), '应声明 3 轮零增量自报卡死');
});

test('第⑦段：模型现读纪律——禁内联等价契约给 codex', () => {
  const s7 = sectionBetween(MARKERS[6], MARKERS[7]);
  assert.ok(s7.includes('routing.json'), '现读纪律段应提及 routing.json');
  assert.ok(s7.includes('claude-code'), 'E/R 席 agent 钉应提及 claude-code');
  assert.ok(s7.includes('A 类 fail-closed'), '候选耗尽应落 A 类 fail-closed');
  assert.ok(s7.includes('内联等价契约'), '应禁「内联等价契约给 codex」变通');
});

test('第⑩段：术语边界——V 阶段验收组 ≠ orca-fanout verify 组', () => {
  const s10 = sectionBetween(MARKERS[9], MARKERS[10]);
  assert.ok(s10.includes('零代码修改'), '验收组应声明零代码修改');
  assert.ok(s10.includes('orca-fanout'), '应显式对照 orca-fanout verify 组');
  assert.ok(s10.includes('禁互套'), '应声明模板禁互套');
});

test('第⑬段：三条接受残余并声明（批次序列 / build SC 不代补 / 版本 bump）', () => {
  const s13 = sectionBetween(MARKERS[12], MARKERS[13]);
  assert.ok(s13.includes('3,3,1'), '残余①应含批次收缩序列示例（如 3,3,1）');
  assert.ok(s13.includes('满载合规'), '残余①应声明满载判据以派发时刻 mem-probe 输出为准');
  assert.ok(s13.includes('不代补'), '残余②应声明 build/typecheck SC 不代补');
  assert.ok(s13.includes('typecheck-merged'), '残余②应指向 submit-pr P1 typecheck-merged 兜底');
  assert.ok(s13.includes('版本 bump'), '残余③应声明版本 bump 无核对');
});

test('第⑭段：保证等级如实（T1 防疏忽/漂移，不防恶意伪造，不夸大）', () => {
  const s14 = sectionBetween(MARKERS[13], undefined);
  assert.ok(s14.includes('T1'), '保证等级段应声明 T1');
  assert.ok(s14.includes('疏忽'), '应声明防疏忽');
  assert.ok(s14.includes('漂移'), '应声明防漂移');
  assert.ok(s14.includes('伪造'), '应如实声明不防恶意 worker 伪造交卷');
  assert.ok(s14.includes('submit-pr 三审'), '兜底应含 submit-pr 三审');
  assert.ok(s14.includes('独立 verify 席'), '兜底应含独立 verify 席');
  assert.ok(!s14.includes('防篡改'), '不得写「防篡改」类夸大措辞');
});

