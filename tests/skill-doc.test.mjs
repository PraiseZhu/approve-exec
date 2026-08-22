// SKILL.md 编排守则结构断言测试（sc-p2b / sc-p1b / r4）。
// 目标：lead 换会话/换模型后编排行为不漂移——守则十六段齐全且与实现字面量同步。
//
// 断言口径：
// 1. frontmatter：name=approve-exec、trigger=批准执行、正文含触发词「批准执行」。
// 2. 十六段 marker 逐段齐全（精确段标题，防段落被删/改名漂移）。
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
// 8. 关键段级内容锚：② 输入门三要素 + fail-closed；③ 五步硬定序检查单
//    （archive 非 idle、list_workers 语序、mem-probe 四键提取）；
//    ⑤ 三类停 + --no-budget-pause；⑦ 现读纪律双锚点 + 禁内联等价契约；
//    ⑩ 术语边界；⑬ 四条接受残余；⑭ 保证等级 T1 不夸大；
//    ⑮ 迁移表九行（三新行：--baseline 兼容模式 / --mem-snapshot 四键 / packet_rendered 凭证闸）；
//    ⑯ 防重复纪律段标题在场；三条 owner 硬指令同段共现。
// 9. doc↔实现同步②：--mem-snapshot / staleness / packet_rendered / --baseline
//    四组字面量从 scripts/run-ledger.mjs 源码 grep 出实现值，再断言 SKILL.md 包含
//    （测试内不写死第二份完整字面量，实现侧为唯一权威，改任一侧即红）。
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

// 十六段精确 marker（段标题与 SKILL.md 逐字一致；缺失/改名即红）
// 注：第③段标题保留「每边三动作」历史命名（段落仍以状态机为主题，五步检查单在段内显式声明），
//     MARKERS 继续逐字锚定该标题——改标题需先改 SKILL.md（不在本测试授权面），见 g2 请示项。
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
  '## ⑯ verify 结果复用纪律（防重复纪律）',
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

test('十六段 marker 齐全且顺序固定', () => {
  let pos = -1;
  for (const m of MARKERS) {
    const idx = skillDoc.indexOf(m, pos + 1);
    assert.ok(idx > pos, `marker 缺失或乱序: ${m}`);
    pos = idx;
  }
});

test('doc↔实现同步①：「用 goal skill 执行。」与 run-ledger render-packet 模板逐字一致', () => {
  // 实现侧唯一权威字面量：renderExecPacket 首行 lines.push('…')（736 行，注释明示 g7 文档测试引用比对）
  const pushes = [...ledgerSrc.matchAll(/lines\.push\('([^']+)'\);/g)].map((m) => m[1]);
  const implLiteral = pushes.find((s) => s.includes('goal skill'));
  assert.ok(implLiteral, 'run-ledger.mjs 中应有「用 goal skill 执行。」模板行');
  // SKILL.md 必须包含实现字面量（逐字，含句号）
  assert.ok(skillDoc.includes(implLiteral), `SKILL.md 应包含实现字面量: ${JSON.stringify(implLiteral)}`);
  // 反向：SKILL.md 中每处「用 goal skill 执行」都必须带「。」（不许文档侧漏句号另写一套）
  const occurrences = skillDoc.split('用 goal skill 执行').length - 1;
  assert.ok(occurrences >= 1, 'SKILL.md 应至少出现一次「用 goal skill 执行」');
  assert.equal(skillDoc.split('用 goal skill 执行。').length - 1, occurrences, 'SKILL.md 中每处「用 goal skill 执行」后都必须紧跟句号');
});

test('doc↔实现同步②（sc-p1b）：四组字面量从 run-ledger.mjs 实现派生，SKILL.md 必须包含实现值', () => {
  // 实现侧唯一权威：flag/子命令/事件名字符串从源码 grep 提取，再断言 SKILL.md 含该提取值。
  // 测试内不写死第二份完整字面量（实现侧改名 → 提取失败即红；文档侧改 → includes 即红）。
  const IMPL_PATTERNS = [
    ['--mem-snapshot flag（派发快照）', /--mem-snapshot/],
    ['staleness 子命令（台账新鲜度诊断）', /staleness/],
    ['packet_rendered 事件（出包凭证）', /packet_rendered/],
    ['--baseline flag（init 基线）', /--baseline/],
  ];
  for (const [label, re] of IMPL_PATTERNS) {
    const impl = ledgerSrc.match(re);
    assert.ok(impl, `run-ledger.mjs 中应有 ${label} 实现字面量`);
    assert.ok(skillDoc.includes(impl[0]), `SKILL.md 应包含 run-ledger 实现字面量 ${JSON.stringify(impl[0])}（${label}）`);
  }
});

test('F4: --mem-snapshot 双锚——命令示例处（③段）与迁移表处（⑮段）任一被改即红', () => {
  // 弱锚问题（独立核查变异实测）：同步②只断言「SKILL.md 任意处含 --mem-snapshot」，而该
  // 字面量在 SKILL.md 多处出现（③段检查单命令示例 + ⑮迁移⑧行）——把③段命令示例处改错、
  // 保留迁移表处的变异测试全绿（迁移表残留稀释断言）。对照 --baseline/packet_rendered 的
  // 双锚（同步② + 迁移表段各一），把 --mem-snapshot 补成③段 + ⑮段双锚：任一被改即红。
  // 字面量从实现源码派生（与同步②同一来源，不硬编码第二份）。
  const impl = ledgerSrc.match(/--mem-snapshot/);
  assert.ok(impl, 'run-ledger.mjs 中应有 --mem-snapshot 实现字面量');
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes(impl[0]), `③段检查单命令示例必须含 --mem-snapshot（F4 双锚之命令示例处，防迁移表残留稀释）`);
  const s15 = sectionBetween(MARKERS[14], MARKERS[15]);
  assert.ok(s15.includes(impl[0]), `⑮迁移表段必须含 --mem-snapshot（F4 双锚之迁移表处）`);
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

test('第⑪段：gate ③ 两层内容等值（sc-p2e 修复）描述 + 打包白名单 packaging_paths + 残余声明', () => {
  const s11 = sectionBetween(MARKERS[10], MARKERS[11]);
  assert.ok(s11.includes('两层内容等值'), '第⑪段应声明 gate ③ 两层内容等值（sc-p2e 修复）');
  assert.ok(s11.includes('组路径域内容等值'), '第⑪段应描述 L1 组路径域内容等值');
  assert.ok(s11.includes('全树封闭性'), '第⑪段应描述 L2 全树封闭性');
  assert.ok(s11.includes('packaging_paths'), '第⑪段应点名打包白名单唯一真相源 packaging_paths');
  assert.ok(s11.includes('.pr-intent.md'), '第⑪段应声明打包白名单默认至少含 .pr-intent.md');
  assert.ok(s11.includes('残余声明'), '第⑪段应声明残余');
  assert.ok(s11.includes('submit-pr 三审兜底'), '残余声明应点名交互面语义由 submit-pr 三审兜底');
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
  assert.ok(s2.includes('readManifest'), '输入门段应点名 receipts 在场契约收口于 readManifest（机器闸唯一入口）');
  assert.ok(s2.includes('全部有机器校验'), '输入门段应如实标注 receipts 校验已机器化（不再依赖 lead 手工检查）');
});

test('第⑥段：--resume 是触发词参数而非 run-ledger CLI 子命令（两审查席误读点）', () => {
  const s6 = sectionBetween(MARKERS[5], MARKERS[6]);
  assert.ok(s6.includes('触发词参数'), '断点续跑段应声明 --resume 是 skill 触发词参数');
  assert.ok(s6.includes('未知子命令'), '应写明对 run-ledger.mjs 传 --resume 会得「未知子命令」');
  assert.ok(s6.includes('由 lead 执行'), '恢复动作应声明执行者是 lead');
  assert.ok(s6.includes('writeLedgerAtomic'), 'CAS 乐观锁应点名机器闸 writeLedgerAtomic');
});

test('第⑮段：破坏性变更迁移表——九条迁移项逐条锚定（含三新行）', () => {
  const s15 = sectionBetween(MARKERS[14], MARKERS[15]);
  assert.ok(s15.includes('--ready-check-exit0'), '迁移①应点名已移除 flag --ready-check-exit0');
  assert.ok(s15.includes('--ready-receipt'), '迁移①应给出替代 --ready-receipt');
  assert.ok(s15.includes('--verify-status') && s15.includes('--verify-evidence-ref'), '迁移②应点名两个已移除手工写入口');
  assert.ok(s15.includes('record-delivery'), '迁移②应指向 record-delivery 唯一通道');
  assert.ok(s15.includes('TEST_FILES'), '迁移③应点名 run-tests.mjs 冻结数组 TEST_FILES');
  assert.ok(s15.includes('HASH_MISMATCH'), '迁移④应含 HASH_MISMATCH 退出码名');
  assert.ok(s15.includes('FROZEN'), '迁移⑤应含 FROZEN 冻结退出码名');
  assert.ok(s15.includes('selfcheck.mjs --live'), '迁移⑥应含 selfcheck --live 自检命令');
  assert.ok(s15.includes('实测'), '迁移表应标注退出码为实测（实证而非纸面描述）');
  // 三新行（sc-p1b）：
  assert.ok(s15.includes('--baseline'), '迁移⑦应点名 init --baseline flag');
  assert.ok(s15.includes('兼容模式'), '迁移⑦应声明 CLI 缺省走兼容模式（实测 exit 0，基线闸/快照闸/凭证闸跳过）');
  assert.ok(s15.includes('--mem-snapshot'), '迁移⑧应点名 set-state --mem-snapshot flag');
  assert.ok(s15.includes('used_slots/platform_cap/concurrency/available_bytes'), '迁移⑧应列出四键快照键名');
  assert.ok(s15.includes('packet_rendered'), '迁移⑨应点名 packet_rendered 事件凭证');
  // 用「凭证闸消费」整词而非裸「凭证闸」——迁移⑦行「基线闸/快照闸/凭证闸全部跳过」也含
  // 「凭证闸」二字，裸词锚会被该行稀释：已用变异复现，删掉迁移⑨行「凭证闸消费最近一条该组
  // packet_rendered 事件」整句后，裸词 includes('凭证闸') 仍因迁移⑦行残留命中而通过。
  assert.ok(s15.includes('凭证闸消费'), '迁移⑨应声明凭证闸消费最近一条该组 packet_rendered 事件');
});

test('第③段：四类交卷 + 整波回滚 first_edit 失效（ae-skill-doc-wave0 / ae-false-first-edit-rollback）', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('exec / review / verify / prewalk 四类'), '③段应收四类交卷');
  assert.ok(s3.includes('波 0'), '③段应写波 0=第一波第一组');
  assert.ok(s3.includes('整波'), '③段应把 first_edit 失效定义成整波回滚');
  assert.ok(s3.includes('first_edit 失效'), '③段应锚到 first_edit 失效');
  assert.ok(s3.includes('最新一条'), '③段应写后续执行组出包取全台账最新一条 prewalk');
  assert.ok(s3.includes('archive 全部'), '③段仍须含 archive 全部');
  assert.ok(s3.includes('list_workers 取实数'), '③段仍须含 list_workers 取实数');
});

test('第⑮段：第 10 行可加且不得删改既有九行锚点', () => {
  const s15 = sectionBetween(MARKERS[14], MARKERS[15]);
  assert.ok(s15.includes('| 10 |'), '⑮段可加第 10 行说明旧三类不能冒充 prewalk');
  assert.ok(s15.includes('不能冒充 prewalk'), '第 10 行应写旧三类形状不能冒充 prewalk');
  for (const keep of [
    '--ready-check-exit0', '--ready-receipt', '--verify-status', 'TEST_FILES',
    'HASH_MISMATCH', 'FROZEN', 'selfcheck.mjs --live', '--baseline', '兼容模式',
    '--mem-snapshot', 'used_slots/platform_cap/concurrency/available_bytes',
    'packet_rendered', '凭证闸消费',
  ]) {
    assert.ok(s15.includes(keep), `⑮既有九行锚点仍须在场: ${keep}`);
  }
});

test('第③段：五步硬定序检查单——archive 非 idle（idle 不释放槽位）+ mem-probe 重算', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('archive'), '检查单应含 archive');
  assert.ok(s3.includes('idle'), '检查单应提及 idle');
  assert.ok(/idle\s*只释放进程\s*、\s*\*\*不释放槽位\*\*/.test(s3), '应明示 idle 不释放槽位');
  assert.ok(s3.includes('mem-probe'), '检查单应含 mem-probe 槽位重算');
});

test('第③段：自跑边逻辑派工——不 create_workers 但仍走 dispatched，--worker-label 固定 lead-self', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('--worker-label'), '③段必须出现 --worker-label（自跑边 dispatched 取值来源）');
  assert.ok(s3.includes('lead-self'), '③段必须把 worker-label 钉死为 lead-self');
  assert.ok(s3.includes('不派 Orca worker ≠ 跳过 set-state dispatched'), '③段应显式否定「不派工=跳过 dispatched」');
  assert.ok(!s3.includes('自跑边只走第 1 步入账，不派工'), '禁止保留「只走第 1 步入账，不派工」字面跳过 dispatched');
  const s4 = sectionBetween(MARKERS[3], MARKERS[4]);
  assert.ok(s4.includes('--worker-label lead-self'), 'D1 应写明自跑边 dispatched 用 --worker-label lead-self');
  assert.ok(s4.includes('--mem-snapshot'), 'D2 应声明自跑边严格模式仍要 --mem-snapshot');
});

test('第③段（sc-p1b）：五步检查单语序——archive（步2）先于 list_workers（步3），顺序不可交换', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('五步硬定序检查单'), '③段应声明五步硬定序检查单');
  // 锚点用「archive 全部」「list_workers 取实数」（各检查单条目的开头短语，段内各恰好出现 1 次），
  // 不用裸词 indexOf('archive')/indexOf('list_workers')——段首散文句「顺序不可交换——尤其
  // archive 先于 probe」本身就含 archive 一词且位于两个检查单条目之前，会把 step2 提前钉死在
  // 散文位置：已用变异复现，把检查单第 2/3 条 bullet 内容互换（archive 全部…条目挪到步 3、
  // list_workers 取实数…条目挪到步 2）后，21 个测试仍全绿——旧锚是无效锚。
  const step2 = s3.indexOf('archive 全部');
  const step3 = s3.indexOf('list_workers 取实数');
  assert.ok(step2 >= 0, '检查单应含「archive 全部」条目开头（步2）');
  assert.ok(step3 > step2, '检查单中「archive 全部」（步2）必须出现在「list_workers 取实数」（步3）之前（archive 先于 probe，使腾出的槽位天然计入下一环节）');
  assert.equal(s3.indexOf('archive 全部', step2 + 1), -1, '「archive 全部」应在③段内唯一出现（否则 indexOf 命中的不保证是步骤条目本身）');
  assert.equal(s3.indexOf('list_workers 取实数', step3 + 1), -1, '「list_workers 取实数」应在③段内唯一出现（同上）');
  assert.ok(s3.includes('第 2 步'), '检查单应显式标注 archive 为第 2 步（语序锚定，防仅字样在场）');
});

test('第③段（sc-p1b）：检查单含「从 mem-probe 输出提取四键」转换步骤（四键名从 run-ledger 实现派生）', () => {
  // 四键名唯一权威 = run-ledger.mjs MEM_SNAPSHOT_KEYS（不硬编码第二份；实现改键名即红）
  const keysDecl = ledgerSrc.match(/const MEM_SNAPSHOT_KEYS = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(keysDecl, 'run-ledger.mjs 中应有 MEM_SNAPSHOT_KEYS 定义');
  const snapshotKeys = [...keysDecl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(snapshotKeys.length, 4, `MEM_SNAPSHOT_KEYS 应为四键，实际: ${JSON.stringify(snapshotKeys)}`);
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  for (const k of snapshotKeys) {
    assert.ok(s3.includes(k), `③段检查单应含快照键 ${k}`);
  }
  // 转换步骤在场：从 mem-probe --json 的 9 键输出中提取构造，原样直喂被拒
  assert.ok(s3.includes('mem-probe --json'), '检查单应点名从 mem-probe --json 输出提取');
  assert.ok(s3.includes('9 键'), '检查单应声明 mem-probe 输出为 9 键（提取步骤的前提）');
  assert.ok(s3.includes('提取'), '检查单应声明提取构造步骤（lead 转换动作在场）');
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

test('第⑬段：四条接受残余并声明（批次序列 / build SC 不代补 / 版本 bump / dispatch 无运行时消费者）', () => {
  const s13 = sectionBetween(MARKERS[12], MARKERS[13]);
  assert.ok(s13.includes('3,3,1'), '残余①应含批次收缩序列示例（如 3,3,1）');
  assert.ok(s13.includes('满载合规'), '残余①应声明满载判据以派发时刻 mem-probe 输出为准');
  assert.ok(s13.includes('不代补'), '残余②应声明 build/typecheck SC 不代补');
  assert.ok(s13.includes('typecheck-merged'), '残余②应指向 submit-pr P1 typecheck-merged 兜底');
  assert.ok(s13.includes('版本 bump'), '残余③应声明版本 bump 无核对');
  assert.ok(s13.includes('dispatch'), '残余④应声明 graph.json dispatch 无运行时消费者');
  assert.ok(s13.includes('pre_command'), '残余④应声明 pre_command 无运行时消费者');
  assert.ok(s13.includes('无运行时'), '残余④应点名无运行时消费');
  assert.ok(s13.includes('independence'), '残余④应声明 V.independence 无运行时消费者');
});

test('第⑭段：保证等级如实（T1 防疏忽/漂移，不防恶意伪造，不夸大）', () => {
  const s14 = sectionBetween(MARKERS[13], MARKERS[14]);
  assert.ok(s14.includes('T1'), '保证等级段应声明 T1');
  assert.ok(s14.includes('疏忽'), '应声明防疏忽');
  assert.ok(s14.includes('漂移'), '应声明防漂移');
  assert.ok(s14.includes('伪造'), '应如实声明不防恶意 worker 伪造交卷');
  assert.ok(s14.includes('submit-pr 三审'), '兜底应含 submit-pr 三审');
  assert.ok(s14.includes('同会话、非独立 agent'), '兜底应写明 V 是同会话复验，不是独立 agent');
  assert.ok(s14.includes('不派作者 worker') || s14.includes('V 不派'), '兜底应写明 V 不派作者 worker');
  assert.ok(!s14.includes('防篡改'), '不得写「防篡改」类夸大措辞');
});

test('sc-p1b-①：新段标题在场——五步硬定序检查单所在段 + 防重复纪律段（⑯）', () => {
  // 五步检查单所在段 = 第③段（段内显式声明「五步硬定序检查单」；段落标题为历史锚点见 MARKERS 注释）
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('五步硬定序检查单'), '③段应声明五步硬定序检查单（检查单所在段）');
  assert.ok(skillDoc.includes('## ⑯ verify 结果复用纪律（防重复纪律）'), '⑯ 防重复纪律段标题应在场');
  const s16 = sectionBetween(MARKERS[15], undefined);
  assert.ok(s16.includes('复用'), '⑯ 防重复纪律段应含复用语义内容');
});

test('sc-p1b-⑥：三条 owner 硬指令在场——「硬指令」≥3 处，且分别与三个语义锚点同段共现', () => {
  // 「硬指令」字样计数（>=3：硬指令(一)⑦段 / 硬指令(二)③段 / 硬指令(三)④段）
  const hardInstCount = skillDoc.split('硬指令').length - 1;
  assert.ok(hardInstCount >= 3, `「硬指令」字样应至少出现 3 处，实际 ${hardInstCount}`);

  // 锚点一（⑦段，硬指令(一) 现读模型说明书）：双锚点同段共现——
  // 「四席（E/V/T/P）现读 routing.json」与「R 席例外（graph.json 席位表钉死、不从 routing）」
  const s7 = sectionBetween(MARKERS[6], MARKERS[7]);
  assert.ok(s7.includes('硬指令'), '⑦段应含「硬指令」字样（硬指令(一)）');
  assert.ok(/E\/V\/T\/P[\s\S]{0,120}routing\.json/.test(s7), '⑦段应含「四席（E/V/T/P）现读 routing.json」锚点');
  assert.ok(/R 席例外[\s\S]{0,120}graph\.json[\s\S]{0,120}不从 routing/.test(s7), '⑦段应含「R 席例外（graph.json 席位表钉死，不从 routing 取值）」锚点——单锚点正匹配检测不到 R 席不走 routing 的例外语义，双锚点锁死两义同段共现');

  // 锚点二（③段，硬指令(二) 汇报即 archive）：「硬指令」与「汇报即清理」同段共现
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(/硬指令[\s\S]{0,80}汇报即清理/.test(s3) || /汇报即清理[\s\S]{0,80}硬指令/.test(s3), '③段应「硬指令」与「汇报即清理」同段共现（硬指令(二)）');

  // 锚点三（④段，硬指令(三) lead 自跑 E/V/P）：「硬指令」与「亲手执行」同段共现
  const s4 = sectionBetween(MARKERS[3], MARKERS[4]);
  assert.ok(/硬指令[\s\S]{0,120}亲手执行/.test(s4) || /亲手执行[\s\S]{0,120}硬指令/.test(s4), '④段应「硬指令」与「lead 亲手执行」同段共现（硬指令(三)，2026-08-22 改钉为 lead 自跑 E/V/P）');
  assert.ok(s4.includes('只用在'), '④段 D1 应声明 worker 只用在 T');
  assert.ok(s4.includes('不派'), '④段 D1 应声明 E/R/V/P 不派 worker');
  assert.ok(s4.includes('slash 在 worker 会话不可用') || s4.includes('禁止派 Orca worker 跑斜杠'), '④段应写明 R 不在 worker 里跑 /code-review');
  assert.ok(s4.includes('simplify'), '④段 D3 应声明 R 席 simplify 前置');
  assert.ok(s4.includes('不走 `/rc`') || s4.includes('不走 /rc'), '④段应禁止把 R 写成 /rc');
  assert.ok(s4.includes('allowed_paths'), '④段应把 simplify 范围锁在 allowed_paths');
});
