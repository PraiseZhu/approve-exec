// SKILL.md 结构断言（PraiseZhu/approve-exec#70 SC1、SC3、SC4）：只留 issue 入口各段、合并红线、保证等级、自进化。
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

const MARKERS = ['## ⓪ issue 入口', '## 合并红线（最高优先级）', '## 保证等级', '## 自进化'];
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

test('frontmatter：name / trigger，description 只描述 issue 入口', () => {
  assert.match(frontmatter, /^name: approve-exec$/m);
  assert.match(frontmatter, /^trigger: 批准执行$/m);
  const description = /^description: (.*)$/m.exec(frontmatter)?.[1] ?? '';
  for (const must of ['开 issue', '吃总 issue', '独立会话', '不带模型参数', 'keel_run', '不合并']) {
    assert.ok(description.includes(must), `description 应写「${must}」`);
  }
  assert.equal(description.includes('最多 2 轮'), false, '#78：description 不再写最多 2 轮');
  for (const old of ['manifest', 'brief', '旧']) {
    assert.equal(description.includes(old), false, `description 不得再提「${old}」`);
  }
});

test('四段 marker 齐全且顺序固定；旧入口第①–⑲段不再出现', () => {
  const idx = MARKERS.map((m) => skillDoc.indexOf(m));
  idx.forEach((i, k) => assert.ok(i >= 0, `marker 缺失: ${MARKERS[k]}`));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'marker 顺序必须固定');
  assert.doesNotMatch(skillDoc, /^## [①-⑲]/m, '旧入口第①–⑲段已删除');
  assert.equal(skillDoc.includes('以下为旧入口'), false);
});

test('issue 入口：出计划、建台账、列可派；派会话只传四个键，不带模型参数', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['**出计划。**', 'scripts/issue-plan.mjs', '**建台账。**', '**列可派。**', '**派会话，每个子 issue 一次。**',
    '只传 `request` 里的四个键', '不传 agent_kind、model、effort、provider_id']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('owner 收口：开工包第 3 节 + references/issue-owner-protocol.md；续跑脚本叫醒 lead', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['**挂续跑脚本', 'scripts/issue-watch.py', '开工包第 3 节', 'references/issue-owner-protocol.md']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
  assert.ok(existsSync(join(root, 'references/issue-owner-protocol.md')), 'owner 协议文件必须存在');
});

test('lead 验收：accept-check 后判通过或要改，不设轮数上限、没有进展才停下等用户（#78）', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['**被叫醒后按信号处理**', 'scripts/accept-check.mjs', 'verdict --item <ref> --pass', '判「要改」不设轮数上限', '只有没有进展时', 'blocked_user', '**需要 lead**', '`needs_lead`',
    '**待收尾**', '**lead 未处理**', 'issue-run.mjs release --item <ref> --evidence']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('Ready 后收尾与收工标准：清本地、归档会话，run_status complete 才收工', () => {
  const s = section('## ⓪ issue 入口');
  for (const must of ['**Ready 后收尾。**', 'issue-run.mjs cleanup', 'archive_sessions', '**收工标准。**', 'run_status', '`complete`', '`waiting_merge`']) {
    assert.ok(s.includes(must), `⓪ 段应写「${must}」`);
  }
});

test('#70 SC4 合并红线：任何 agent 不合并、不开 auto-merge，只有用户对指定 PR 的当次授权才合并', () => {
  const s = section('## 合并红线（最高优先级）');
  assert.ok(s.includes('都不得合并'), '合并红线应写明不得合并');
  assert.ok(s.includes('都不得合并、自动合并、启用 auto-merge、点击合并或调用 gh pr merge'), '合并红线应写明不得合并、不开 auto-merge、不调 gh pr merge');
  assert.ok(s.includes('只有用户本人对指定 PR 的明确、当次授权才允许合并'), '合并红线应写明只有用户当次授权才合并');
  assert.ok(section('## ⓪ issue 入口').includes('不合并任何 PR'), '⓪ 段边界应写明 lead 不合并');
});

test('保证等级 T1，不夸大成宿主强制隔离；接线用 selfcheck --live 检查', () => {
  const s = section('## 保证等级');
  for (const must of ['T1', '不是宿主强制隔离', 'scripts/selfcheck.mjs --live', 'tests/skill-doc.test.mjs']) {
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
