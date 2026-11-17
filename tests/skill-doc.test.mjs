// SKILL.md 结构断言（PraiseZhu/approve-exec#70 SC1、SC3、SC4；2026-11-07 改版：不走 KEEL、不建台账、不挂定时任务）。
// 目标：lead 换会话后不漂回旧入口（manifest / brief / 钉死模型），也不丢合并红线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const skillDoc = readFileSync(join(root, 'SKILL.md'), 'utf8');
const defaultsKeys = Object.keys(JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8')));
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillDoc)?.[1] ?? '';

const MARKERS = ['## ⓪ issue 入口', '## 执行会话的规矩', '## 加急合并', '## 合并红线（最高优先级）', '## 旧 run', '## 保证等级', '## 自进化'];
// #70 SC1：旧入口与钉死模型路由的词，不得出现在 SKILL.md、scripts/、config/。
const BANNED = ['grok-4.6', 'claude-fable', 'task-priority', 'context-intake', 'gate_goal', 'gate_routing', 'budgetPauseUsd', '800 行', '1600 行'];

function section(marker) {
  const start = skillDoc.indexOf(marker);
  assert.ok(start >= 0, `marker 缺失: ${marker}`);
  const next = skillDoc.indexOf('\n## ', start + marker.length);
  return skillDoc.slice(start, next === -1 ? undefined : next);
}

function filesUnder(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]);
}

test('frontmatter：name / trigger；description 写 2026-11-07 新流程，不再提 keel_run', () => {
  assert.match(frontmatter, /^name: approve-exec$/m);
  assert.match(frontmatter, /^trigger: 批准执行$/m);
  const description = /^description: (.*)$/m.exec(frontmatter)?.[1] ?? '';
  for (const must of ['开 issue', '吃总 issue', '并行/串行原则', '独立会话', '按执行类型读共享 session 路线', '不走 KEEL', '不建台账', '对账任务', '转正式', '归档已完成的会话', '不合并']) {
    assert.ok(description.includes(must), `description 应写「${must}」`);
  }
  for (const old of ['keel_run', '最多 2 轮', 'manifest', 'checkpoint', '续跑脚本']) {
    assert.equal(description.includes(old), false, `description 不得再提「${old}」`);
  }
});

test('#93 SC3：description 按仓分两路写合并，不再写不分仓的「PR 合入后合并伙伴通知 lead」（用户 2026-11-08）', () => {
  const description = /^description: (.*)$/m.exec(frontmatter)?.[1] ?? '';
  for (const must of ['Mivo 仓 PR 交合并伙伴、合入后伙伴通知 lead', '其他仓 PR 由 lead 按 pr-merge 自己合', '用户说「合并」的非 Mivo PR 外，lead 不合并']) {
    assert.ok(description.includes(must), `description 应写「${must}」`);
  }
  assert.equal(description.includes('PR 合入后合并伙伴通知 lead'), false, 'description 不得再写不分仓的「PR 合入后合并伙伴通知 lead」');
});

test('#93 README 同步两路分工（2026-11-08 lead 追加范围）', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const must of ['Mivo 仓 PR 交合并伙伴、合入后伙伴通知 lead', '其他仓 PR 由 lead 按 pr-merge 自己合', 'Mivo 仓由合并伙伴合，其他仓由收到这句话的会话按 pr-merge 的标准自己合']) {
    assert.ok(readme.includes(must), `README.md 应写「${must}」`);
  }
  for (const old of ['PR 合入后合并伙伴通知 lead', '本 skill 不合入；']) {
    assert.equal(readme.includes(old), false, `README.md 不得再写「${old}」`);
  }
});

test('七段 marker 齐全且顺序固定；旧入口第①–⑲段不再出现', () => {
  const idx = MARKERS.map((m) => skillDoc.indexOf(m));
  idx.forEach((i, k) => assert.ok(i >= 0, `marker 缺失: ${MARKERS[k]}`));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'marker 顺序必须固定');
  assert.doesNotMatch(skillDoc, /^## [①-⑲]/m, '旧入口第①–⑲段已删除');
});

test('issue 入口：batch status 七种状态，dispatchable 一次派完；派会话原样传 request、进目标仓项目分栏、claim 防重', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['scripts/batch.mjs status', '七种状态', '`dispatchable`', '`waiting`', '`needs_decision`', '`invalid`', '`in_progress`', '`needs_owner`', '`done`', '一次派完',
    'scripts/batch.mjs brief', '参数原样传 `request` 里的键', '`project_path`', '`list_projects`', '`create_project`', '`#<PR号>-<人话任务名>丨<MMDD>`', '--name',
    '不自己改模型和推理强度，不传 provider_id', 'scripts/batch.mjs claim', '1 个子 issue 只对应 1 个 PR、1 个执行会话']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('2026-11-07 改版：lead 派完就停，不挂定时任务、不建台账、不走 KEEL（用户定）', () => {
  const s = section('## ⓪ issue 入口');
  // v3（#108）：仍然派完就停、不轮询，但等待由对账任务看着；建任务的参数写在 README，不写进 ⓪ 段。
  assert.ok(s.includes('**停下。**') && s.includes('派完就结束本轮，不轮询') && s.includes('等待由对账任务看着'));
  for (const banned of ['keel_run', 'schedule_create', 'issue-watch', 'issue-run.mjs', 'ledger']) {
    assert.equal(s.includes(banned), false, `⓪ 段不得再写「${banned}」`);
  }
});

test('被消息叫醒：待验收跑 check-pr，已转正式跑 --stage ready，卡住、合并通知回第 1 步；要改不设轮数上限', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['**被消息叫醒后：**', 'scripts/check-pr.mjs --item <子 issue> --pr <号> --head', '--stage ready', '批准执行通过', '批准执行要改',
    '判要改不设轮数上限', '**卡住**', 'praise-merge 已合并', '用户说「继续」', '`notify_session`', 'scripts/batch.mjs release']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('PR 挂到会话顶上（用户 2026-11-07）：执行会话开出 PR 就挂自己；lead 把 to_attach 和待验收的 PR 都挂到自己会话，执行会话漏挂时兜底；命名不变', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['`to_attach`', '`manage_session_prs`（`action: attach`', '挂到 lead 自己的会话', '带 `session_id`=执行会话 id 挂到执行会话', '不替它改名']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
  const protocol = readFileSync(join(root, 'references/owner-protocol.md'), 'utf8');
  assert.ok(protocol.includes('`manage_session_prs`（`action: attach`') && protocol.includes('命名方式不变'), 'owner-protocol.md 应写执行会话自己挂 PR、命名不变');
});

test('astra 审查修复（2026-11-07）：待接手、issue 关了 PR 还开着、正式 PR 返修、总 issue 意图、权限档、未送达都写进流程', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['确认没人做就走第 2 步派一个会话接手', 'issue 关了但 PR 还开着会是 `needs_decision`', '先读总 issue 的目标与背景、已定决策和并行/串行原则',
    '不回到验收档，验收档要求 Draft', '**发给执行会话的消息送不到**', '批准执行未送达']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
  assert.ok(skillDoc.includes('lead 会话要在完全访问权限下运行'), 'SKILL.md 应写 lead 的权限档要求');
  assert.equal(skillDoc.includes('不会丢。'), false, '不再写「不会丢」这种过强保证');
  const protocol = readFileSync(join(root, 'references/owner-protocol.md'), 'utf8');
  for (const must of ['先读总 issue 的目标与背景', '用 Cindy 的托管分支，不另开分支', '`git push origin HEAD:<PR 分支名>`', '不算越出子 issue 范围',
    '全部检查跑完且通过（skipping 算通过）', '`check-pr-body.sh --stage ready', '不要再发「待验收」', '批准执行未送达', '`DELIVERY_UNKNOWN`']) {
    assert.ok(protocol.includes(must), `owner-protocol.md 应写「${must}」`);
  }
});

test('#89 验证证据：lead 核对每条「已验证」附命令和退出码，能复跑的挑一条复跑；执行会话先读目标仓 PR 门禁', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['每条「已验证」都附了命令和退出码，缺了判要改', '挑一条类型检查或测试命令在 PR head 的临时工作树里复跑', '复跑不了就在裁决评论写「未复跑」']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
  const protocol = readFileSync(join(root, 'references/owner-protocol.md'), 'utf8');
  for (const must of ['指向的 PR 门禁规则（如 `docs/dev-rules/` 下的文件）', '每条「已验证」都写实际跑的命令和退出码', '只写「通过」不算']) {
    assert.ok(protocol.includes(must), `owner-protocol.md 应写「${must}」`);
  }
});

test('#112 派发按共享路线备选重派并记录成功路线', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['session.ui', 'session.logic', 'session.mixed', 'APPROVE_EXEC_ROUTING', 'model-route check', '--route-index 0', '--route-index 1', 'PROVIDER_ROUTE_UNAVAILABLE', 'DELIVERY_UNKNOWN', '--route-json', '实际成功请求', '**派发失败的会话马上归档**']) assert.ok(s.includes(must), must);
});

test('收工：PR 合并前不归档执行会话；合入后 lead 按 to_archive 归档并记录，扫地僧兜底；lead 不交接、不关总 issue（用户 2026-11-07）', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['**收工。**', '`all_done`', '执行会话 PR 合并前不归档', '`to_archive`', 'scripts/batch.mjs archived', '扫地僧每天兜底归档', 'lead 不交接、不关总 issue', '不合并任何 PR']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('执行会话的规矩：红线是推到正式 PR；完整做法在 references/owner-protocol.md', () => {
  const s = section('## 执行会话的规矩');
  for (const must of ['PR 不转正式不算完', '不走 KEEL', '问 Jev', '等 CI 时不结束本轮', 'references/owner-protocol.md']) {
    assert.ok(s.includes(must), `执行会话段应写「${must}」`);
  }
  const protocol = readFileSync(join(root, 'references/owner-protocol.md'), 'utf8');
  for (const must of ['## 红线', '不走 KEEL', '不问用户', 'gh pr create --draft', 'timeout 540 gh pr checks', 'gh pr ready', '批准执行待验收', '批准执行已转正式', '批准执行卡住']) {
    assert.ok(protocol.includes(must), `owner-protocol.md 应写「${must}」`);
  }
});

test('加急合并：只在用户明确授权时走，单审 + e2e 通过才 admin 合并且钉住 head', () => {
  const s = section('## 加急合并');
  for (const must of ['明确授权', '没写就不走', 'review 档', 'e2e 档', '--admin', '--match-head-commit']) {
    assert.ok(s.includes(must), `加急合并段应写「${must}」`);
  }
});

test('合并红线：除两种用户当次授权外任何 agent 不合并、不开 auto-merge', () => {
  const s = section('## 合并红线（最高优先级）');
  assert.ok(s.includes('都不得合并、自动合并、启用 auto-merge、点击合并或调用 gh pr merge'));
  assert.ok(s.includes('只有用户本人对指定 PR 的明确、当次授权才允许合并'));
  assert.ok(s.includes('加急合并') && s.includes('合并伙伴'));
});

test('#93 SC1：合并红线第二种授权按仓分两路，其余禁止条款原样保留（用户 2026-11-08）', () => {
  const s = section('## 合并红线（最高优先级）');
  assert.ok(s.includes('用户说「合并」的 PR：Mivo 仓由合并伙伴按其标准合并；其他仓由收到这句话的会话按 `pr-merge` 的标准自己合并。'), '第二种授权应写两路分工');
  assert.equal(s.includes('由合并伙伴按各仓标准合并'), false, '不得再写所有仓都由合并伙伴合');
  // 其余条款逐句原样保留（#97 起开头的「两种用户当次授权」改成「三种用户授权」，见下一条测试）
  for (const kept of [
    '除下面三种用户授权的情况外，任何 lead、owner、reviewer、tester、Mini session、watcher、worker 或本 skill 都不得合并、自动合并、启用 auto-merge、点击合并或调用 gh pr merge。',
    '只有用户本人对指定 PR 的明确、当次授权才允许合并：用户在提示词里明确授权加急 admin 合并的 PR，由 lead 按「加急合并」执行；',
    'PR Ready、required checks 通过、管理员权限或开工消息里的提交/推送授权，都不构成合并授权。',
  ]) {
    assert.ok(s.includes(kept), `合并红线应原样保留「${kept}」`);
  }
});

test('#93 SC2：只有 Mivo PR 有伙伴通知；非 Mivo PR 由 lead 按 pr-merge 自己合完后直接归档、派下一批', () => {
  const s = section('## ⓪ issue 入口');
  const row = skillDoc.split('\n').find((l) => l.startsWith('| `praise-merge 已合并 …`'));
  assert.ok(row && row.includes('Mivo PR 合入后') && row.includes('其他仓 PR 由 lead 自己合，没有这条消息'), '消息表 praise-merge 一行应限定为 Mivo PR');
  const notice = s.slice(s.indexOf('**合并通知。**'), s.indexOf('**会话失联。**'));
  for (const must of ['按 `pr-merge` 分两路', 'Mivo 仓（`xindong/mivo-canvas-plugin`）的 PR 交给合并伙伴', '`notify_session`', '只有 Mivo PR 有这条伙伴通知',
    '其他仓的 PR 不交伙伴，由 lead 按 `pr-merge` 的标准自己合', '没有伙伴通知；lead 合进去后直接按第 4 步归档会话、派下一批']) {
    assert.ok(notice.includes(must), `合并通知应写「${must}」`);
  }
  assert.ok(s.includes('**praise-merge 已合并**（只有 Mivo PR 有）、lead 按 `pr-merge` 自己合完非 Mivo PR 后，或用户说「继续」'), '第 4 步应让 lead 自己合完非 Mivo PR 后也走归档、派下一批');
  assert.ok(s.includes('不合并任何 PR（「加急合并」和用户说「合并」的非 Mivo PR 除外）'), '边界应写明 lead 可合的两种例外');
});

test('#97 SC3：Mivo PR 转正式后 lead 登记合入通知；合并红线写明第三种（伙伴自动合并）', () => {
  const s = section('## ⓪ issue 入口');
  assert.ok(skillDoc.split('\n').some((l) => l.startsWith('| `praise-merge 通知登记` | lead | 合并伙伴（Mini） |')), '消息表应有「praise-merge 通知登记」一行');
  const row = skillDoc.split('\n').find((l) => l.startsWith('| `praise-merge 已合并 …`'));
  assert.ok(row.includes('自动合入的（lead 登记过地址）'), '「praise-merge 已合并」一行应写明自动合入也有');
  const ready = s.slice(s.indexOf('**已转正式**'), s.indexOf('**发给执行会话的消息送不到**'));
  for (const must of ['`node scripts/batch.mjs notify --pr <owner/repo#号> --lead-address <lead 的跨电脑地址>`', '把输出的 `message` 原样用 `send_to_session` 发给 `target_session_id`', '`already_merged` 为真时', '用户说「继续」']) {
    assert.ok(ready.includes(must), `已转正式应写「${must}」`);
  }
  const notice = s.slice(s.indexOf('**合并通知。**'), s.indexOf('**会话失联。**'));
  assert.ok(notice.includes('正文写了「合并顺序」的本人 Mivo PR 不用用户说「合并」'), '合并通知应写自动合');
  const red = section('## 合并红线（最高优先级）');
  assert.ok(red.includes('第三种是用户的长期授权（2026-11-08，PraiseZhu/praise-merge#38）'), '合并红线应写第三种授权');
  assert.ok(red.includes('lead 和执行会话不替 PR 挂这个标签'), '合并红线应禁止 lead 和执行会话代挂标签');
  assert.equal(red.includes('两种用户当次授权'), false, '不得再写只有两种授权');
});

test('旧 run：改版前开工的 run 按 legacy-ledger-flow.md 收尾，旧步骤原样保留', () => {
  const s = section('## 旧 run');
  assert.ok(s.includes('references/legacy-ledger-flow.md'));
  const legacy = readFileSync(join(root, 'references/legacy-ledger-flow.md'), 'utf8');
  for (const must of ['scripts/issue-run.mjs', 'scripts/issue-watch.py', 'scripts/accept-check.mjs', 'references/issue-owner-protocol.md']) {
    assert.ok(legacy.includes(must), `legacy-ledger-flow.md 应保留「${must}」`);
  }
  assert.ok(existsSync(join(root, 'references/issue-owner-protocol.md')), '旧 owner 协议文件必须保留到旧 run 收工');
});

test('保证等级 T1，不夸大成宿主强制隔离；接线用 selfcheck --live 检查', () => {
  const s = section('## 保证等级');
  for (const must of ['T1', '不是宿主强制隔离', 'scripts/selfcheck.mjs --live', 'tests/skill-doc.test.mjs', '对账任务负责发现六种情况', '它不负责合并、改代码', '仍靠「进展」和用户兜底']) {
    assert.ok(s.includes(must), `保证等级段应写「${must}」`);
  }
});

test('自进化：evolution-note 是自进化台账唯一写通道', () => {
  const s = section('## 自进化');
  assert.ok(s.includes('evolution/ledger.json') && s.includes('scripts/evolution-note.mjs'));
});

test('#70 SC1：SKILL.md、scripts/、config/ 里没有旧入口与钉死模型路由的词', () => {
  const hits = [];
  for (const rel of ['SKILL.md', ...filesUnder('scripts'), ...filesUnder('config')]) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const word of BANNED) if (text.includes(word)) hits.push(`${rel}: ${word}`);
  }
  assert.deepEqual(hits, [], `出现了旧入口的词：${hits.join('；')}`);
});

test('config 键名比对：SKILL.md 反引号里的 camelCase 键都真实存在于 defaults.json', () => {
  const backtickTokens = [...skillDoc.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const camelCaseTokens = backtickTokens.filter((t) => /^[a-z][a-zA-Z0-9]*$/.test(t) && /[A-Z]/.test(t));
  const unknown = camelCaseTokens.filter((t) => !defaultsKeys.includes(t));
  assert.deepEqual(unknown, [], `SKILL.md 引用了 defaults.json 中不存在的键: ${unknown.join(', ')}`);
});

test('#112 开工先查路线；说明和配置一致，旧网关规则已移除', () => {
  const s = section('## ⓪ issue 入口');
  const gate = s.indexOf('**开工先查路线**');
  const step1 = s.indexOf('1. **看现状。**');
  assert.ok(gate >= 0 && step1 > gate, '开工先查路线必须存在且在第 1 步之前');
  for (const file of ['SKILL.md', 'README.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const token of ['Praise-VPS', 'routing.json', 'APPROVE_EXEC_ROUTING', 'routingPath', 'fallbacks', '--route-index', '--route-json', '未记录']) assert.ok(text.includes(token), `${file} ${token}`);
    for (const stale of ['dispatchRoute', '--gateway Claude', '备用依次 Personal', '请在 Claude 网关上开 lead 会话']) assert.equal(text.includes(stale), false, `${file} ${stale}`);
  }
  const invalid = skillDoc.split('\n').find((l) => l.includes('`invalid`：'));
  for (const must of ['lead 直接补齐格式', '不改目标、范围和验收内容', '记一行']) assert.ok(invalid.includes(must), must);
});

// v3：对账式流水线（PraiseZhu/approve-exec#101）

test('#108 SC8：SKILL.md 不再写「不挂定时任务」；有「对账任务」一节，写清期限表、两种模式、不存进度状态', () => {
  assert.equal(skillDoc.includes('不挂定时任务'), false);
  const s = section('## 对账任务');
  for (const must of ['scripts/reconcile-tick.py', 'scripts/reconcile.mjs', '只读 GitHub', '不存进度状态', '只记不敲', '不建在 Linux 网关上', '`wake_lead`', '`wake_owner`', '`recheck`', '`request_merge`',
    '15 分钟', '30 分钟', '2 小时', '10 分钟', '6 小时', '没有章程的 run 不归它管']) {
    assert.ok(s.includes(must), `对账任务一节应写「${must}」`);
  }
  assert.ok(skillDoc.indexOf('## 对账任务') > skillDoc.indexOf('## ⓪ issue 入口') && skillDoc.indexOf('## 对账任务') < skillDoc.indexOf('## 执行会话的规矩'));
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const must of ['### 对账任务', 'APPROVE_EXEC_TICK_MODE', '`record`（默认）', '不带 `silentWhenIdle`', 'schedule_list', '### 运行章程', '### 回放数据']) {
    assert.ok(readme.includes(must), `README.md 应写「${must}」`);
  }
});

test('#104、#105：事件由脚本写；被叫醒后的三种对账动作各有做法；定章程在第 1 步之前', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['scripts/event.mjs emit --type verdict_pass', '`verdict_revise`', '暂缓转正式：', '**对账：复核**', '--stage recheck --accepted-head', '**对账：交合并请求**',
    'scripts/batch.mjs merge-request', '`pr_merge_input`', '**对账：叫醒 lead**', '`judgement`', '`prereview` 项不过']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
  assert.ok(skillDoc.includes('不手写这些评论'), 'SKILL.md 应写事件不手写');
  const charter = s.indexOf('**定章程**');
  assert.ok(charter >= 0 && charter < s.indexOf('1. **看现状。**'), '定章程应在第 1 步之前');
  for (const must of ['scripts/charter.mjs write', '章程没写的事一律不自动做', 'lead 换人时发一条新章程']) assert.ok(s.includes(must), `定章程应写「${must}」`);
  const red = section('## 合并红线（最高优先级）');
  assert.ok(red.includes('只有用户本人对指定 PR 的明确、当次授权才允许合并'), '合并红线原文保留，章程不新增合并通道');
});

test('#120 阶段授权只逐个请求同步 PR，不接通 run 级自动请求', () => {
  const start = skillDoc.indexOf('**阶段 PR 收口授权。**');
  const end = skillDoc.indexOf('1. **看现状。**', start);
  assert.ok(start >= 0 && end > start, '阶段授权应放在开工步骤之前');
  const stage = skillDoc.slice(start, end);
  assert.doesNotMatch(stage, /merge\.auto_request|merge\.bases|scripts\/batch\.mjs merge-request/,
    '阶段授权不得配置 run 级自动请求，也不借用通用 merge-request');
  for (const must of ['逐个手动发送 `praise-merge/request@1`', '每个请求仅含这一个同步 PR',
    '`authorization_text`', '阶段收口授权', '完整引用', '用户授权原话', '普通子 PR 继续按原规则合并']) {
    assert.ok(stage.includes(must), `阶段授权应写「${must}」`);
  }
});

test('#120 未消费消息：区分本机与跨机，查询失败先报告而不是接手', () => {
  const start = skillDoc.indexOf('**会话失联。**');
  const end = skillDoc.indexOf('\n边界：', start);
  assert.ok(start >= 0 && end > start);
  const lost = skillDoc.slice(start, end);
  for (const must of ['只能查询本机会话', '`get_session_runtime`', '`list_session_queue`',
    '`get_chat_history`', '`deviceId::sessionId`', '最后活动时间', '历史时间不能证明运行已结束或队列未消费',
    '`NOT_FOUND`', '`HOST_NOT_READY`', '查不到', '停下并报告用户', '不判定为失联，也不接手', 'consuming=false']) {
    assert.ok(lost.includes(must), `会话失联应写「${must}」`);
  }
});

test('#106、#107：开工带用户原话和共享记忆；预开工与预审写进 lead 流程和执行会话协议', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['`--user-words', '原样转给执行会话，不转述', '`repo-cards/`', '`early_dispatchable` 不是第八种状态', '--early', '上游全部合入前不发「待验收」', '--report']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
  const protocol = readFileSync(join(root, 'references/owner-protocol.md'), 'utf8');
  for (const must of ['**预审**', '只修确认成立的 P0、P1、P2', 'event.mjs emit --type prereview', '## 预开工', 'PR 一直保持 Draft', '不指向上游 PR 的分支', '## 收到对账敲门',
    'note.mjs add --root', '`--broadcast`', '「范围对照」', 'event.mjs emit --type ready_for_verdict', 'event.mjs emit --type ready ']) {
    assert.ok(protocol.includes(must), `owner-protocol.md 应写「${must}」`);
  }
});


test('#111 文档写明分类命令、兼容、提示与拒绝条件', () => {
  for (const file of ['SKILL.md', 'README.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const token of ['界面 / 逻辑 / 混合', '前端→界面', '后端→逻辑', 'batch.mjs classify', '--body-file', 'git ls-files', 'ui_globs', 'kind_hint', 'browser-fixture', 'cindy-mac', 'cindy-windows']) assert.ok(text.includes(token), `${file} 缺 ${token}`);
  }
});
