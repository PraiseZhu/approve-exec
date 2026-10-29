// render-issue-handoff.mjs：一页开工包（PraiseZhu/approve-exec#68 SC7）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, readRoot } from '../scripts/issue-plan.mjs';
import { renderIssueHandoff, KEEL_DONE } from '../scripts/render-issue-handoff.mjs';
import { REPO, parentFixture, writeFixture, ghFrom } from './fixtures/issues/build.mjs';

function packet(ref = `${REPO}#11`) {
  const fixture = parentFixture();
  const { repoDir } = writeFixture(fixture);
  const { root, children } = readRoot(ghFrom(fixture), `${REPO}#10`);
  const plan = buildPlan({ root, children, repoDirs: { [REPO]: repoDir }, lead: 'codex', authorization: '用户 2026-10-29：批准执行 acme/app#10', now: '2026-10-29T08:00:00.000Z' });
  const item = plan.items.find((i) => i.ref === ref);
  return { text: renderIssueHandoff({ plan, item, leadSessionId: 'lead-1' }), plan, item };
}

test('SC7 开工包含：子 issue 与总 issue 链接、批次与合并顺序、keel_run 参数、授权原话、完成标准与回报方式', () => {
  const { text, item } = packet(`${REPO}#14`);
  assert.ok(text.includes(`https://github.com/${REPO}/issues/14`));
  assert.ok(text.includes(`https://github.com/${REPO}/issues/10`));
  assert.ok(text.includes('第 1 批'));
  assert.ok(text.includes(`${REPO}#11 先合，你的 PR 再合`));
  assert.ok(text.includes(JSON.stringify(item.keel_run, null, 2)));
  assert.ok(text.includes('「用户 2026-10-29：批准执行 acme/app#10」'));
  assert.ok(text.includes(KEEL_DONE));
  assert.ok(text.includes('给 lead 会话 lead-1 发一条回执'));
  assert.ok(text.includes('SC3 上线后 24 小时内无同步报错。验证：github-live'), '黑盒验收项要列出，标「未执行」');
});

test('SC7 开工包不含模型 ID 与派工路由文件，夹具产出不超过 8KB', () => {
  const { text } = packet();
  assert.doesNotMatch(text, /routing\.json/);
  assert.doesNotMatch(text, /\b(gpt-[0-9]|grok-[0-9]|claude-(opus|sonnet|haiku|fable))/i);
  assert.doesNotMatch(text, /agent_kind|provider_id/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8 * 1024, `开工包 ${Buffer.byteLength(text, 'utf8')} 字节，超过 8KB`);
});

test('开工包写明不合并、不改 issue 验收标准', () => {
  const { text } = packet();
  assert.ok(text.includes('不合并 PR，不开 auto-merge'));
  assert.ok(text.includes('不改 issue 的范围和验收标准'));
});

test('缺 lead 会话 id 时拒绝渲染', () => {
  const { plan, item } = packet();
  assert.throws(() => renderIssueHandoff({ plan, item }), /需要 lead 会话 id/);
});

test('SC7 反例（review-pr71）：issue 的 SC 原文含模型词时，只出现在照抄的 SC 文本里，脚本自己写的部分不含', () => {
  const fixture = parentFixture();
  const subs = fixture[`api repos/${REPO}/issues/10/sub_issues?per_page=100`];
  subs[0].body = subs[0].body.replace('- [ ] SC4 目标仓测试与 CI 全绿。验证：static',
    '- [ ] SC4 `git grep` 不到 `grok-4.6`、`routing.json`。验证：static\n- [ ] SC5 上线后不再出现 `claude-fable`。验证：github-live');
  const { repoDir } = writeFixture(fixture);
  const { root, children } = readRoot(ghFrom(fixture), `${REPO}#10`);
  const plan = buildPlan({ root, children, repoDirs: { [REPO]: repoDir }, lead: 'codex', entry: '批准执行', now: '2026-10-29T08:00:00.000Z' });
  const item = plan.items.find((i) => i.ref === `${REPO}#11`);
  const text = renderIssueHandoff({ plan, item, leadSessionId: 'lead-1' });
  assert.match(text, /grok-4\.6/, '照抄的 SC 原文保留');
  const own = text
    .replace(JSON.stringify(item.keel_run, null, 2), '')
    .split('\n')
    .filter((l) => !item.manual_scs.some((s) => l.includes(s.text)))
    .join('\n');
  assert.doesNotMatch(own, /routing\.json|grok-[0-9]|gpt-[0-9]|claude-(opus|sonnet|haiku|fable)/i);
});

test('SC7 反例（review-pr71 第 2 轮）：直接以子 issue 为入口时，开工包也带首行写的总 issue 链接', () => {
  const fixture = parentFixture();
  const { repoDir } = writeFixture(fixture);
  const { root, children } = readRoot(ghFrom(fixture), `${REPO}#11`);
  const plan = buildPlan({ root, children, repoDirs: { [REPO]: repoDir }, lead: 'codex', entry: '批准执行 acme/app#11', now: '2026-10-29T08:00:00.000Z' });
  assert.equal(plan.root.kind, 'single');
  const text = renderIssueHandoff({ plan, item: plan.items[0], leadSessionId: 'lead-1' });
  assert.ok(text.includes(`- 总 issue：https://github.com/${REPO}/issues/10。`), text.slice(0, 600));
});
