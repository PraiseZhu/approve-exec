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
const BANNED = ['grok-4.6', 'claude-fable', 'routing.json', 'task-priority', 'context-intake', 'gate_goal', 'gate_routing', 'budgetPauseUsd', '800 行', '1600 行'];

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
  for (const must of ['开 issue', '吃总 issue', '并行/串行原则', '独立会话', 'Claude 网关的 Opus 5.5 high', '不走 KEEL', '不建台账', '不挂定时任务', '转正式', '归档已完成的会话', '不合并']) {
    assert.ok(description.includes(must), `description 应写「${must}」`);
  }
  for (const old of ['keel_run', '最多 2 轮', 'manifest', 'checkpoint', '续跑脚本']) {
    assert.equal(description.includes(old), false, `description 不得再提「${old}」`);
  }
});

test('七段 marker 齐全且顺序固定；旧入口第①–⑲段不再出现', () => {
  const idx = MARKERS.map((m) => skillDoc.indexOf(m));
  idx.forEach((i, k) => assert.ok(i >= 0, `marker 缺失: ${MARKERS[k]}`));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'marker 顺序必须固定');
  assert.doesNotMatch(skillDoc, /^## [①-⑲]/m, '旧入口第①–⑲段已删除');
});

test('issue 入口：batch status 六种状态，dispatchable 一次派完；派会话原样传 request、进目标仓项目分栏、claim 防重', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['scripts/batch.mjs status', '`dispatchable`', '`waiting`', '`needs_decision`', '`invalid`', '`in_progress`', '`done`', '一次派完',
    'scripts/batch.mjs brief', '参数原样传 `request` 里的键', '`project_path`', '`list_projects`', '`create_project`', '`#<PR号>-<人话任务名>丨<MMDD>`', '--name',
    '不自己改模型和推理强度，不传 provider_id', 'scripts/batch.mjs claim', '1 个子 issue 只对应 1 个 PR、1 个执行会话']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('2026-11-07 改版：lead 派完就停，不挂定时任务、不建台账、不走 KEEL（用户定）', () => {
  const s = section('## ⓪ issue 入口');
  assert.ok(s.includes('**停下。**') && s.includes('不挂定时任务，不轮询'));
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

test('网关（用户 2026-11-07）：默认 Claude 网关 Opus 5.5 high，备用 Personal、Personal 2；不支持指定网关时只在 Claude 网关上派', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['Claude 网关的 `claude-opus-5-5`、effort high', '备用依次 Personal、Personal 2 网关', 'makecindy/cindy#9195', '`--gateway Claude`',
    '`--gateway Personal`', '`--gateway "Personal 2"`', '请在 Claude 网关上开 lead 会话', '**派发失败的会话马上归档**']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
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
  for (const must of ['T1', '不是宿主强制隔离', 'scripts/selfcheck.mjs --live', 'tests/skill-doc.test.mjs', '没有定时检查']) {
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
