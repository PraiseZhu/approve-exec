// SKILL.md 编排守则结构断言测试（sc-p2b / sc-p1b / r4）。
// 目标：lead 换会话/换模型后编排行为不漂移——守则十七段齐全且与实现字面量同步。
//
// 断言口径：
// 1. frontmatter：name=approve-exec、trigger=批准执行、正文含触发词「批准执行」。
// 2. 十七段 marker 逐段齐全（精确段标题，防段落被删/改名漂移）。
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
//    ⑩ 术语边界；⑬ 三条接受残余；⑭ 保证等级 T1 不夸大；
//    ⑮ 迁移表九行（三新行：--baseline 兼容模式 / --mem-snapshot 四键 / packet_rendered 凭证闸）；
//    ⑯ 防重复纪律段、⑰ 看门狗段标题在场；三条 owner 硬指令同段共现。
// 9. doc↔实现同步②：--mem-snapshot / staleness / packet_rendered / --baseline
//    四组字面量从 scripts/run-ledger.mjs 源码 grep 出实现值，再断言 SKILL.md 包含
//    （测试内不写死第二份完整字面量，实现侧为唯一权威，改任一侧即红）。
// 10.（r4 P1-1）⑰ 段 prompt payload 断言：payload = 起止标记之间、剥掉 blockquote
//     「> 」前缀后的文本（接手会话实际会拿到的内容）。A1 观察协议、A2 互斥动作表、
//     resume 入口、P1-2 按组判定、P1-3 暂停保护全部断言作用在 payload 上，
//     不锁「段内出现」（段内出现 ≠ 进入 prompt，GPT 终审 P1-1 实证）。
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

// 十七段精确 marker（段标题与 SKILL.md 逐字一致；缺失/改名即红）
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
  '## ⑰ 看门狗（每小时自检，防 lead 停摆）',
];

// 取第 N 段（marker N 到 marker N+1）之间的文本
function sectionBetween(marker, nextMarker) {
  const start = skillDoc.indexOf(marker);
  assert.ok(start >= 0, `marker 缺失: ${marker}`);
  const end = nextMarker ? skillDoc.indexOf(nextMarker, start) : skillDoc.length;
  assert.ok(end > start, `marker 越界: ${marker}`);
  return skillDoc.slice(start + marker.length, end);
}

// r4 P1-1：从 ⑰ 段精确抽取 prompt payload 块。
// 边界 = 起止标记（<!-- approve-exec:watchdog-payload:start --> / :end -->），
// 抽取后剥掉每行 blockquote 前缀「> 」（与 SKILL.md「复制时去掉起止标记与 > 前缀」对齐）。
// 断言作用对象 = payload（接手会话实际会拿到的文本）——段内出现 ≠ 进入 prompt。
function extractWatchdogPayload() {
  const startMarker = '<!-- approve-exec:watchdog-payload:start -->';
  const endMarker = '<!-- approve-exec:watchdog-payload:end -->';
  const start = skillDoc.indexOf(startMarker);
  const end = skillDoc.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, '⑰ 段应含 watchdog payload 起止标记（start/end 成对且 start 在前）');
  const raw = skillDoc.slice(start + startMarker.length, end);
  const lines = raw.split('\n').map((l) => l.replace(/^\s*> ?/, ''));
  const payload = lines.join('\n').trim();
  assert.ok(payload.length > 0, 'watchdog payload 不应为空');
  return payload;
}

test('frontmatter：name=approve-exec、trigger=批准执行', () => {
  const fm = skillDoc.slice(0, skillDoc.indexOf('---', 3));
  assert.match(fm, /name:\s*approve-exec/);
  assert.match(fm, /trigger:\s*批准执行/);
  assert.ok(skillDoc.includes('批准执行'), '正文应含触发词「批准执行」');
});

test('十七段 marker 齐全且顺序固定', () => {
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
    ['staleness 子命令（看门狗读数）', /staleness/],
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

test('第③段：五步硬定序检查单——archive 非 idle（idle 不释放槽位）+ mem-probe 重算', () => {
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('archive'), '检查单应含 archive');
  assert.ok(s3.includes('idle'), '检查单应提及 idle');
  assert.ok(/idle\s*只释放进程\s*、\s*\*\*不释放槽位\*\*/.test(s3), '应明示 idle 不释放槽位');
  assert.ok(s3.includes('mem-probe'), '检查单应含 mem-probe 槽位重算');
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

test('第⑬段：三条接受残余并声明（批次序列 / build SC 不代补 / 版本 bump）', () => {
  const s13 = sectionBetween(MARKERS[12], MARKERS[13]);
  assert.ok(s13.includes('3,3,1'), '残余①应含批次收缩序列示例（如 3,3,1）');
  assert.ok(s13.includes('满载合规'), '残余①应声明满载判据以派发时刻 mem-probe 输出为准');
  assert.ok(s13.includes('不代补'), '残余②应声明 build/typecheck SC 不代补');
  assert.ok(s13.includes('typecheck-merged'), '残余②应指向 submit-pr P1 typecheck-merged 兜底');
  assert.ok(s13.includes('版本 bump'), '残余③应声明版本 bump 无核对');
});

test('第⑭段：保证等级如实（T1 防疏忽/漂移，不防恶意伪造，不夸大）', () => {
  const s14 = sectionBetween(MARKERS[13], MARKERS[14]);
  assert.ok(s14.includes('T1'), '保证等级段应声明 T1');
  assert.ok(s14.includes('疏忽'), '应声明防疏忽');
  assert.ok(s14.includes('漂移'), '应声明防漂移');
  assert.ok(s14.includes('伪造'), '应如实声明不防恶意 worker 伪造交卷');
  assert.ok(s14.includes('submit-pr 三审'), '兜底应含 submit-pr 三审');
  assert.ok(s14.includes('独立 verify 席'), '兜底应含独立 verify 席');
  assert.ok(!s14.includes('防篡改'), '不得写「防篡改」类夸大措辞');
});

test('sc-p1b-①：新段标题在场——五步硬定序检查单所在段 + 防重复纪律段（⑯）+ 看门狗段（⑰）', () => {
  // 五步检查单所在段 = 第③段（段内显式声明「五步硬定序检查单」；段落标题为历史锚点见 MARKERS 注释）
  const s3 = sectionBetween(MARKERS[2], MARKERS[3]);
  assert.ok(s3.includes('五步硬定序检查单'), '③段应声明五步硬定序检查单（检查单所在段）');
  // 防重复纪律段（⑯）与看门狗段（⑰）：标题逐字在场（MARKERS 已锚定，此处显式复核防引用漂移）
  assert.ok(skillDoc.includes('## ⑯ verify 结果复用纪律（防重复纪律）'), '⑯ 防重复纪律段标题应在场');
  assert.ok(skillDoc.includes('## ⑰ 看门狗（每小时自检，防 lead 停摆）'), '⑰ 看门狗段标题应在场');
  // ⑯ 段内容存在性（标题在场且非空段）
  const s16 = sectionBetween(MARKERS[15], MARKERS[16]);
  assert.ok(s16.includes('复用'), '⑯ 防重复纪律段应含复用语义内容');
  // r4 P1-1：⑰ 看门狗提示词 = payload 块——读数命令必须是 payload 的自包含起手
  // （接手会话只读 payload 即可执行，段内出现不算数）
  const payload = extractWatchdogPayload();
  assert.ok(payload.includes('run-ledger staleness <ledger>'), '⑰ payload 应含 staleness 读数命令（与 run-ledger 实现子命令名逐字一致，payload 自包含起手）');
  assert.ok(payload.includes('staleness'), '⑰ payload 应含 staleness 读数语义内容');
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

  // 锚点三（④段，硬指令(三) lead 不亲手执行）：「硬指令」与「不亲手执行」同段共现
  const s4 = sectionBetween(MARKERS[3], MARKERS[4]);
  assert.ok(/硬指令[\s\S]{0,100}不亲手执行/.test(s4) || /不亲手执行[\s\S]{0,100}硬指令/.test(s4), '④段应「硬指令」与「lead 不亲手执行」同段共现（硬指令(三)）');
});

test('sc-p1b-⑦：看门狗心跳模式参数在场——bindToCurrentSession 与 persistentSession 必传且为 true（防退回每轮新建会话）', () => {
  // 看门狗必须是心跳模式：schedule 触发把提示注入 lead 当前会话，不新建会话。
  // 两参数（挂载时必传、值必须为 true）是宿主导航行为的开关——缺 bindToCurrentSession
  // 退回「每轮新建会话」模式；只设它不设 persistentSession，lead 会话死亡时宿主会直接
  // pause 整条 schedule 且不自动恢复（看门狗在最该起作用时失效）。
  // 断言带 `: true` 形态、作用在 ⑰ 段内（非全文）：裸词在「六项必填参数」行亦有出现，
  // 只锁裸词会在参数被改回非心跳模式时假绿（反向变异已证）；`: true` 形态仅「挂载」行持有。
  // 注：这是挂载参数（lead 建 schedule 时用），不是载荷内容，保留段级断言。
  const s17 = sectionBetween(MARKERS[16], undefined);
  assert.ok(s17.includes('bindToCurrentSession: true'), '⑰ 看门狗段应含 bindToCurrentSession: true——看门狗必须是心跳模式（注入 lead 当前会话，不新建会话），缺该参数即退回每轮新建会话模式');
  assert.ok(s17.includes('persistentSession: true'), '⑰ 看门狗段应含 persistentSession: true——lead 会话归档/删除时宿主自动新建会话接手，缺该参数宿主会直接 pause 整条 schedule 且不自动恢复');
});

test('sc-p1b-⑧（r4 改 payload）：payload 必须含接手触发词「批准执行 --resume <run_id>」（persistentSession 接手会话的恢复入口）', () => {
  // F1 实证：⑰ 段此前只声称会话死亡后新会话「走 --resume <run_id> 读台账重建」，但注入的
  // prompt 里没有这句触发词——接手会话既没进入本 skill、也不知道 run_id，容错承诺是空的。
  // r4 改造：断言作用在 payload（接手会话实际拿到的文本）上——段内出现（如①段/说明块）
  // 不等于进入 prompt。
  const payload = extractWatchdogPayload();
  assert.ok(
    payload.includes('批准执行 --resume <run_id>'),
    '⑰ payload 应含接手触发词「批准执行 --resume <run_id>」——persistentSession 新建的接手会话没有本 skill 上下文，只能靠 prompt 里的完整触发词进入 skill 恢复（与第⑥段唯一正确用法逐字一致，不得写成 run-ledger 子命令形态）'
  );
});

test('sc-p1b-⑨（r4 改 payload）：payload 判据必须覆盖 minutes_since_last_event 为 null（台账无事件时的停摆盲区）', () => {
  // F2 实证：run-ledger staleness 无事件时 last_event_at 为 null，null>=60 为 false——init 后
  // 立即停摆（活已派出去、首个事件未落）时恢复分支永不命中，最该救的场景反而是盲区。
  // 断言一锁判据行「为 null 或 >=60」组合短语（null 分支是追加不是替换，>=60 字面量保留）；
  // 断言二锁 null 与「刚 init 正常态」的区分佐证短语（in_flight_groups 非空 = 活已派出去）。
  // r4 改造：断言作用在 payload 上。
  const payload = extractWatchdogPayload();
  assert.ok(payload.includes('为 null 或 >=60'), '⑰ payload 判据应含「为 null 或 >=60」——minutes_since_last_event 为 null（台账无事件，如 init 后立即停摆）时 null>=60 为 false、恢复分支永不命中，判据必须覆盖 null 分支（追加不是替换）');
  assert.ok(payload.includes('活已派出去'), 'payload 应给出与「刚 init 正常态」的区分佐证（in_flight_groups 非空 = 活已派出去、该落事件却没落，按疑似停摆处理）');
});

test('sc-p1b-⑩（r4 改 payload）：payload 必须含「先交叉核实再动手」缓解判据 + 两个核实对象（in_flight_groups / list_workers）', () => {
  // F3(a) 是「误判 → 打断正在干活的 lead → 提前 archive worker / 重复派工」的唯一行为层屏障：
  // 心跳模式下误判会向正在干活的 lead 会话注入「清槽重派」指令，payload 的交叉核实判据是唯一缓解。
  // r4 改造：断言作用在 payload 上；串形态随 payload 重构更新（「**（查」→「——查」）。
  // 说明块（确认门答辩）只复述「先交叉核实再动手」不带核实对象组合，payload 断言不受稀释。
  const payload = extractWatchdogPayload();
  assert.ok(
    payload.includes('先交叉核实再动手——查 in_flight_groups 状态与 list_workers 存活情况'),
    '⑰ payload 应含「先交叉核实再动手」缓解判据及其两个核实对象（in_flight_groups / list_workers）——这是挡住「误判 → 打断正在干活的 lead → 提前 archive worker / 重复派工」的唯一行为层屏障；删掉它会让残余声明的「已由 payload 判据缓解」变成空头支票'
  );
});

test('sc-p1b-⑪（F4）：第五个失败时间点 (e) 在场——标题字面量「五个失败时间点」与 (e) 绑定会话死亡 pause 语义成对锁定', () => {
  // F4：心跳模式特有失败面——只设 bindToCurrentSession 不设 persistentSession 时 lead 会话死亡
  // 宿主直接 pause 整条 schedule 且不自动恢复；(a)-(d) 覆盖不到（setup 不可用 / READY 自删 /
  // 被删停用 / 服务停机均不涉及绑定会话死亡）。标题字面量与 (e) 行成对锁定——只锁其一，
  // 另一个被改不红（反向变异已证：删 (e) 行而标题保留，只锁标题的断言仍绿；改回「四个」
  // 而 (e) 保留，只锁 (e) 的断言仍绿）。
  // 注：失败时间点是设计说明（说明块），不是载荷内容，保留段级断言。
  const s17 = sectionBetween(MARKERS[16], undefined);
  assert.ok(s17.includes('五个失败时间点'), '⑰ 段应声明「五个失败时间点」（标题字面量，与 (e) 成对——只锁 (e) 不锁标题，标题被改回「四个」不红）');
  assert.ok(
    s17.includes('(e) **绑定会话死亡导致 schedule 被 pause'),
    '⑰ 段应含第五个失败时间点 (e)「绑定会话死亡导致 schedule 被 pause」——心跳模式特有的失败面，(a)-(d) 覆盖不到，缺失即回检动作无对应失败面'
  );
});

test('sc-p2b-A1（r4 改 payload）：payload 必须含 A1 观察协议——version 连续 3 轮不变 → 判定停摆；观察文件缺失/损坏 → 报告并重计', () => {
  // F2 实证（lead 2026-08-11 独立复现）：init 产出 phase=executing + 全部组 pending + events=[]，
  // staleness 输出 (null, in_flight=[], version 不变)；旧文「为空（刚 init 正常态）不动作，等下一轮」
  // = 永久静默死循环（每小时读到完全相同数据，lead 永远不会被救）。
  // 逃逸判据 = staleness 输出的 version 字段（台账每次写操作递增的单调量，run-ledger.mjs
  // writeLedgerAtomic 的 buildNext 一律 expected+1，init 起 version=0）：连续 N 轮同一 version =
  // 台账 N 小时完全没被写过 = 真停摆。N=3（3 轮 = 3 小时）。
  // 假绿教训（2026-08-11 变异 I 实测）：分开 includes「连续 3 轮」与「同一 version」两个裸词，
  // 会被执行方式句的复述「连续 3 轮同一 version」残留命中——删掉判据核心句后旧断言仍全绿。
  // r4 改造：断言作用在 payload 上（A1 是载荷内容，必须进 prompt；移到说明块即红）。
  const payload = extractWatchdogPayload();
  assert.ok(
    payload.includes('**连续 3 轮**（看门狗每小时触发一次，3 轮 = 3 小时）观察到同一 version'),
    '⑰ payload 逃逸判据核心句必须在场：「连续 3 轮」与「同一 version」绑定且 N=3（3 轮=3 小时）——判据字段被换错（如 phase）、N 值被改、或核心句被掏空（只留裸词）都会破坏该串，即红'
  );
  assert.ok(payload.includes('watchdog.json'), 'payload A1 观察协议必须点名观察文件 <ledger>.watchdog.json（version 观察的落盘对象）');
  assert.ok(payload.includes('从本轮重新计数'), 'payload 必须声明观察文件缺失/损坏 → 报告 owner 并从当前轮重新计数（P2-4 fail-safe 方向：宁可多等，不可误动）');
  assert.ok(payload.includes('计数清零重计'), 'payload 必须声明 version 变化 → 计数清零重新计时（期间任何写操作即推翻停摆判据）');
});

test('sc-p2b-A2（r4 改 payload）：payload 必须含交叉核实互斥动作表——P1-2 按组判定三行语义 + 「仅报告 owner」安全兜底', () => {
  // F3 批评（GPT 复审）：只写「查 in_flight_groups 状态与 list_workers 存活情况」无动作映射，
  // 低配会话无从下手、且可能误动作（如 worker 已归档但台账未落账时误判「该重派」）。
  // r4 P1-2：正常完工的组（delivered/review_pass）交付后已按纪律 archive，仍在 in_flight 里但
  // list_workers 查无对应 worker——这是正常态不是 timeout，不得重派；只有 state=dispatched +
  // 满 workerTimeoutMinutes(40min) + 确证 worker 已 terminal 才允许超时收束。
  // r4 改造：断言作用在 payload 上（A2 是载荷内容，必须进 prompt；表格移到说明块即红）。
  const payload = extractWatchdogPayload();
  assert.ok(payload.includes('互斥动作表'), 'payload 应含「互斥动作表」标题（交叉核实结果 → 动作的明确映射，非仅核实对象清单）');
  assert.ok(payload.includes('running/active'), '动作表第 1 行状态：对应 worker 存活（running/active）');
  assert.ok(payload.includes('正常在跑'), '动作表第 1 行动作：存活 → 不动（正常在跑，只记录观察）');
  assert.ok(
    payload.includes('state=dispatched 且 dispatched_at+40min<=now 且该 worker 已 terminal'),
    'P1-2 超时判定：只有 state=dispatched + dispatched_at+40min<=now（workerTimeoutMinutes=40，第⑤段）+ 确证 worker 已 terminal 才允许超时收束——放宽成任意 in_flight 态即红（会把正常完工的组误判成超时重派）'
  );
  assert.ok(payload.includes('超时/失败收束'), '动作表超时行动作：按第⑤段「worker 超时重派」纪律超时/失败收束并落账（归档该 worker、重建重派，台账 timeout_redispatch）');
  assert.ok(
    payload.includes('state=delivered/review_pass 且该 worker 不存在/已 terminal'),
    'P1-2 正常态判定：delivered/review_pass 但无存活 worker 是正常态（交付后已按纪律 archive），不是 timeout——走 resume 从台账恢复后续，不重派'
  );
  assert.ok(payload.includes('正常态'), '动作表应标注 delivered/review_pass 行为正常态（≠ 超时）');
  assert.ok(payload.includes('不重派'), '正常态行必须声明不重派（已完成的工作不得重复派工）');
  assert.ok(payload.includes('仅报告 owner，不清槽不重派'), '动作表第 4 行安全兜底：映射缺失/多重/混合 → 仅报告 owner，不清槽不重派（宁可少动作，不可误清仍在跑的 worker）');
});

test('sc-r4-P1-3：payload 第 1 步必须含暂停保护——「允许停」路径下不得 resume/重派，仅报告 owner', () => {
  // P1-3（GPT 终审，lead 实证）：PHASE_ORDER 无 paused/blocked 态——预算暂停等 owner 确认期间
  // 台账 phase 仍是 executing、无写操作、version 不变 → 三小时后 A1 判定「真停摆」→ resume/重派，
  // 直接违背用户的暂停授权。保护 = 进入「允许停」路径时 lead 停用/删除 schedule（选 (a)，见
  // 说明块「暂停保护（P1-3，选 (a)）」）；payload 第 1 步是 lead 忘记停时的兜底闸。
  // 断言作用在 payload 上：暂停保护必须进 prompt（移出 payload 即红）。
  const payload = extractWatchdogPayload();
  assert.ok(payload.includes('暂停保护'), 'payload 第 1 步必须含「暂停保护」步骤（进入允许停路径后的兜底闸）');
  assert.ok(payload.includes('不得 resume/重派'), '暂停保护必须禁止 resume/重派——不得越过用户已授权的暂停自作主张继续跑');
  assert.ok(payload.includes('仅报告 owner，不动作'), '暂停保护兜底动作：仅报告 owner，不动作（不清槽、不重派、不 resume）');
});

test('sc-⑫（GPT 终审唯一必修）：schedule_id 必须进展开清单与 payload 第 2/5 步——载荷要求的动作必须有输入', () => {
  // GPT 终审实证：payload 第 2 步（READY 自删）与恢复入口步（暂停后重重挂）都要求用 schedule id，
  // 但模板说明行只要求展开 ledger 路径与 run_id——persistentSession 新建的接手会话不知道
  // schedule id：READY 时无法自删（孤儿 schedule 永远每小时跑下去，⑰ 段自列「自删是双保险」，
  // 这个保险是空的），暂停后无法去重重挂（盲挂重复创建，schedule_create 无 upsert/无去重键）。
  // 断言一锁展开清单：作用在「**提示词模板**」到 payload start marker 的区间——裸词段级断言会被
  // 「schedule_create 六项必填参数」行的「schedule id」残留稀释（反向变异已复现），必须锁区间。
  // 断言二锁 payload 第 2 步行：作用在具体行（含「**终态」）——全 payload includes 会被恢复
  // 入口步的 <schedule_id> 残留稀释（反向变异已复现），必须按行锁定。
  const s17 = sectionBetween(MARKERS[16], undefined);
  const tmplStart = s17.indexOf('**提示词模板**');
  assert.ok(tmplStart >= 0, '⑰ 段应含「**提示词模板**」说明行');
  const payloadStart = s17.indexOf('<!-- approve-exec:watchdog-payload:start -->');
  assert.ok(payloadStart > tmplStart, 'payload 起止标记应位于模板说明行之后');
  const tmplBlock = s17.slice(tmplStart, payloadStart);
  // 锁完整短语而非裸词 schedule_id：模板说明行内「payload 是接手方拿到 run_id 与 schedule_id
  // 的唯一通道」「用 schedule_update 把 <schedule_id> 回填」等处也含 schedule_id 字样——
  // 只删展开清单处的变异会被残留命中假绿（变异实测已复现），必须锁「…与 schedule_id 三者
  // 都展开写进 prompt」整串。
  assert.ok(tmplBlock.includes('与 schedule_id 三者都展开写进 prompt'), '模板说明行必须要求把 schedule_id 展开写进 prompt（payload 第 2/5 步动作的输入）——只展开 ledger/run_id 时接手会话不知道 schedule id，READY 自删与恢复重重挂都无从执行');
  assert.ok(tmplBlock.includes('schedule_update'), '模板说明行必须写明两步时序：schedule_create 返回 id 后再用 schedule_update 把 id 回填进 prompt（创建时 prompt 已随提交、拿不到 id，回填是唯一可行路径）');

  const payload = extractWatchdogPayload();
  const lines = payload.split('\n');
  const step2 = lines.find((l) => l.includes('**终态'));
  assert.ok(step2, 'payload 应含第 2 步「终态/心跳」行');
  assert.ok(step2.includes('<schedule_id>'), 'payload 第 2 步（phase=ready 自删）必须使用已给定的 <schedule_id>——写「持久化的 schedule id」这类指向不明说法即红（载荷里应是一个具体的、已被展开的值，接手会话才删得掉 schedule）');
  const restoreStep = lines.find((l) => l.includes('**恢复入口'));
  assert.ok(restoreStep, 'payload 应含恢复入口步');
  assert.ok(restoreStep.includes('<schedule_id>'), '恢复入口步必须使用已给定的 <schedule_id>，与第 2 步同一展开值（resume 按 id 定位，写「持久化的 schedule id」这类指向不明说法即红）');
});

test('sc-收尾-①（GPT 阻断 1 确认）：payload 第 5 步恢复入口必须为 resume 语义且含 <schedule_id>（反向变异：改回「重重挂」恰红 1 条）', () => {
  // 收尾轮（GPT 阻断 1，lead 实测工具契约确认）：schedule_delete 不可逆且 schedule_create 无
  // id 参数——删掉的 schedule 无法用原 id 重建，payload 原「若 schedule 曾被停用或删除 → 用
  // <schedule_id> 重重挂」是不可执行分支。修复 = 消除 deleted 分支本身：暂停路径只
  // schedule_pause，恢复 = schedule_resume(<schedule_id>)，零新增参数。
  // 断言作用在 payload 上（接手会话实际拿到的文本）；正向表述锁定 resume 语义（不加全文否定
  // 断言「不得含重重挂」——否则反向变异改回「重重挂」会双红，破坏「恰红 1 条」验收口径）。
  // 反向变异（实测）：把恢复动作改回「重重挂」→ 本测试红恰 1 条，其余全绿。
  const payload = extractWatchdogPayload();
  const lines = payload.split('\n');
  const restoreStep = lines.find((l) => l.includes('**恢复入口'));
  assert.ok(restoreStep, 'payload 应含恢复入口步');
  assert.ok(
    restoreStep.includes('<schedule_id>'),
    '恢复入口步必须使用已给定的 <schedule_id>（resume 按 id 定位，与第 2 步同一展开值）'
  );
  assert.ok(
    restoreStep.includes('schedule_resume'),
    '恢复入口步必须是 resume 语义（schedule_resume(<schedule_id>) 恢复 paused 的 schedule）——「重重挂/重建」不可执行：schedule_create 无 id 参数，删了就再也拿不回同一 id'
  );
  assert.ok(
    restoreStep.includes('处于 paused'),
    '恢复入口步必须按 paused 态判据恢复（若本 schedule 处于 paused → resume）——「曾被停用或删除」是 deleted 分支残留说法'
  );
});

test('sc-收尾-②（GPT 阻断 2 确认）：挂载说明必须含四步挂载流程 create → pause → update → resume（反向变异：删 pause 步恰红 1 条）', () => {
  // 收尾轮（GPT 阻断 2，lead 实测确认）：schedule_create 返回后、schedule_update 回填前若撞上
  // hourly tick，首轮 prompt 仍是 <schedule_id> 占位符——竞态窗口真实存在（create 无原子
  // update 选项、无 status 参数）。修复 = 四步挂载：create → pause → update → resume，
  // 窗口内 schedule 处于 paused 不触发，撞 tick 也不会跑占位符。
  // 断言作用在模板说明区间（「**提示词模板**」→ payload start 之间），正则锁
  // create→pause→update→resume 顺序（顺序不可换：pause 必须在 update 前才关得住窗口）。
  // 反向变异（实测）：从挂载流程删掉 pause 步（退回两步 create→update）→ 本测试红恰 1 条。
  const s17 = sectionBetween(MARKERS[16], undefined);
  const tmplStart = s17.indexOf('**提示词模板**');
  assert.ok(tmplStart >= 0, '⑰ 段应含「**提示词模板**」说明行');
  const payloadStart = s17.indexOf('<!-- approve-exec:watchdog-payload:start -->');
  assert.ok(payloadStart > tmplStart, 'payload 起止标记应位于模板说明行之后');
  const tmplBlock = s17.slice(tmplStart, payloadStart);
  assert.match(
    tmplBlock,
    /schedule_create[\s\S]{0,400}schedule_pause[\s\S]{0,400}schedule_update[\s\S]{0,400}schedule_resume/,
    '模板说明行必须写明四步挂载流程（create → pause → update → resume，顺序不可换）——先 pause 把竞态窗口关死（create 后、update 回填前撞 tick 会跑 <schedule_id> 占位符 prompt），update 回填真实 id 后再 resume 放行'
  );
});

test('sc-收尾-③：⑰ 段暂停路径必须声明只 pause 不 delete，delete 仅限 READY 终态（正向表述锁定）', () => {
  // 收尾轮（GPT 阻断 1 的段级落实）：deleted 分支整体消除——挂载行「进入允许停路径 → 删除本
  // schedule；恢复时重重挂」与暂停保护块「停用或删除本 run 的 schedule」都是不可执行分支
  // （delete 不可逆、create 无 id 参数）。修复 = 只 pause；delete 只保留在 READY 终态
  // （payload 第 2 步，那时不需要再挂回来）。
  // 用正向表述锁定（lead 明示可用「锁 pause/resume 正向表述」替代否定断言——全文否定断言
  // 会在「改回重重挂」反向变异时与 sc-收尾-① 双红，破坏「恰红 1 条」口径）。
  const s17 = sectionBetween(MARKERS[16], undefined);
  assert.ok(
    s17.includes('只暂停本 schedule'),
    '⑰ 段必须声明暂停路径只 pause 本 schedule（明确不 delete）——delete 不可逆且 schedule_create 无 id 参数，删了就再也挂不回同一 id'
  );
  assert.ok(
    s17.includes('不 delete'),
    '挂载行/暂停保护块必须显式声明「不 delete」边界（防只写 pause 不提 delete 边界的半修）'
  );
});

test('sc-收尾-④（GPT 终审文字债①）：挂载时序必须承认毫秒级残余窗口 + fresh-init 前提限制（反向变异：改回「关死/杜绝」绝对表述恰红 1 条）', () => {
  // GPT 终审文字债①：原「四步挂载，关死竞态窗口」「杜绝…竞态窗口」「窗口内 schedule 处于
  // paused，撞 tick 也不会跑占位符 prompt」是绝对表述，暗示窗口被彻底消灭——实际
  // schedule_create 返回即 active 且 nextFireAt 已设，create 成功返回到 pause 成功返回之间
  // 仍有毫秒级残余窗口，撞 tick 仍可能触发一次占位符 prompt。修复 = 如实承认残余窗口
  // （pause 成功后窗口才关死），并声明该残余的安全性依赖 fresh-init invariants（新 run 刚
  // init 时 phase=executing / minutes=null / in_flight 为空 / 观察文件不存在 → 占位符 prompt
  // 只写观察文件，不会走到 resume / archive / 重派）；非 fresh-init 的既有 run 上重新 create
  // 会带真实 run_id 进入 --resume 并可能 archive+重派，故挂载只允许在 init 后的 fresh run 上做。
  // 断言作用在模板说明区间（tmplBlock，同 sc-收尾-② 口径）；反向变异（改回绝对表述）时
  // 这些新表述串消失即红，恰 1 条。
  const s17 = sectionBetween(MARKERS[16], undefined);
  const tmplStart = s17.indexOf('**提示词模板**');
  assert.ok(tmplStart >= 0, '⑰ 段应含「**提示词模板**」说明行');
  const payloadStart = s17.indexOf('<!-- approve-exec:watchdog-payload:start -->');
  const tmplBlock = s17.slice(tmplStart, payloadStart);
  assert.ok(
    tmplBlock.includes('毫秒级残余窗口'),
    '挂载时序必须承认毫秒级残余窗口（create 成功返回到 pause 成功返回之间撞 tick 仍可能触发一次占位符 prompt）——写「杜绝/关死窗口」类绝对表述即红'
  );
  assert.ok(
    tmplBlock.includes('pause 成功后'),
    '必须写明窗口在 pause 成功后（而非 create 返回时）才关死'
  );
  assert.ok(
    tmplBlock.includes('fresh-init'),
    '必须声明残余窗口的安全性依赖 fresh-init invariants（新 run 刚 init 时 phase=executing / minutes=null / in_flight 为空 / watchdog 观察文件不存在 → 占位符 prompt 只会写观察文件，不会走到 resume、不会 archive/重派）'
  );
  assert.ok(
    tmplBlock.includes('挂载只允许在 init 后的 fresh run 上做'),
    '必须声明挂载边界：只允许在 init 后的 fresh run 上做（非 fresh-init 的既有 run 上重新 create，占位符 prompt 会带真实 run_id 进入 --resume 并可能 archive+重派）'
  );
});

test('sc-收尾-⑤（GPT 终审文字债②）：四步挂载必须含 fail-closed 规则，pause 失败不得继续（反向变异：删 fail-closed 句恰红 1 条）', () => {
  // GPT 终审文字债②：四步调用缺显式「任一步失败即停止」fail-closed 句——尤其 pause 失败后若
  // 继续 update→resume，等于回到无保护的两步流程，占位符窗口重新暴露整个 hourly 周期。
  // 修复 = 四步任一步失败即停止；pause 失败绝不能继续 update→resume；create 成功后失败先
  // pause 住防跑占位符再报告 owner；连 pause 都失败则立即报告 owner 存在活跃的占位符 schedule。
  // 断言作用在模板说明区间（tmplBlock）；「fail-closed」裸词在全文多处出现（②⑤⑦段），
  // 必须锁本段内新表述串，防残留稀释。
  const s17 = sectionBetween(MARKERS[16], undefined);
  const tmplStart = s17.indexOf('**提示词模板**');
  assert.ok(tmplStart >= 0, '⑰ 段应含「**提示词模板**」说明行');
  const payloadStart = s17.indexOf('<!-- approve-exec:watchdog-payload:start -->');
  const tmplBlock = s17.slice(tmplStart, payloadStart);
  assert.ok(
    tmplBlock.includes('任一步失败即停止'),
    '四步挂载必须声明 fail-closed：任一步失败即停止，不得继续后续步骤（现状「四步完成才算挂好」属隐含，不构成明确规则）'
  );
  assert.ok(
    tmplBlock.includes('pause 失败绝不能继续'),
    '必须显式点名 pause 失败绝不能继续 update→resume（等于回到无保护的两步流程，占位符窗口重新暴露整个 hourly 周期）'
  );
  assert.ok(
    tmplBlock.includes('占位符 schedule'),
    '必须声明连 pause 都失败时立即报告 owner 说明存在活跃的占位符 schedule（最后一道防线，create 已成功但回填/暂停全失败时的可观测出口）'
  );
});
