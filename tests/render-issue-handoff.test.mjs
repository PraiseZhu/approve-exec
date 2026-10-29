// render-issue-handoff.mjs：一页开工包（PraiseZhu/approve-exec#68 SC7、#69 SC6、#77 SC1 SC2 SC6）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, readRoot } from '../scripts/issue-plan.mjs';
import { renderIssueHandoff, ACCEPTANCE_POINT, END_TURN_STATES } from '../scripts/render-issue-handoff.mjs';
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
  assert.ok(text.includes(ACCEPTANCE_POINT));
  assert.ok(text.includes('## 3. 收口：到验收点就停下，等 lead 裁决'), '回报方式改为写 checkpoint（#69）');
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

test('#77 SC1 任何车道都先开 Draft，验收点是「KEEL 只差转 Ready」，lead 判通过之前不调 pr_ready', () => {
  const { text } = packet();
  assert.ok(text.includes('`next` 让你调 `pr_open`：加 `draft: true`，`authorization_source` 填「用户 2026-10-29：批准执行 acme/app#10」。任何车道都先开 Draft。'));
  assert.ok(text.includes(`验收点：${ACCEPTANCE_POINT}。`));
  // review-pr80 P1：PR 是 Draft、CI 干净时 KEEL 对三种车道都给 mark_ready，交接车道不会出现 pr_ready 的 next。
  assert.ok(ACCEPTANCE_POINT.includes('done 门（`next.kind` 是 `decide`、`gate_id` 是 `done`）的缺项只剩一条 `pr_status 是 mark_ready`。三种车道都一样'));
  assert.doesNotMatch(ACCEPTANCE_POINT, /交接车道是 `next` 让你调 `pr_ready`/);
  assert.ok(text.includes('PR 已经不是 Draft（例如 `next` 让你调 `pr_ready`）：不调，先 `gh pr ready <PR 号> --undo` 转回 Draft，再接着做。'));
  assert.ok(text.includes('**lead 判通过之前，任何车道都不调 `pr_ready`**'));
  assert.ok(text.includes('- 「通过」：调 KEEL 的 `pr_ready`，`authorization_source` 填「用户 2026-10-29：批准执行 acme/app#10」；成功后写 `--state ready --pr <PR 号> --head <同一 sha>`，再把 done 门答 `wait`，KEEL 看到已交接或可合并就收工。'), '通过后所有车道都由 owner 转正式，再答 done 门收工');
  assert.ok(text.includes('不用 `send_to_session` 回报，续跑脚本会叫醒 lead'));
  assert.doesNotMatch(text, /report_mergeable 时就是验收点|personal 车道直接写/, '#69 时 personal 车道 PR 一开就是正式的，验收点已改');
  assert.doesNotMatch(text, /发一条回执/);
});

test('#77 SC2 owner 无人值守：只在四种情况结束本轮，等待接着等，decide 门自己答，不留没有渠道的「回报 lead / 问用户」', () => {
  const { text } = packet();
  assert.deepEqual([...END_TURN_STATES], ['awaiting_acceptance', 'ready', 'needs_lead', 'blocked_user']);
  assert.ok(text.includes('结束本轮只有四种情况：写完 `awaiting_acceptance` / `ready` / `needs_lead` / `blocked_user` 之一。别的时候一直照 `next` 做，不回报进度。'));
  assert.ok(text.includes('`next` 是等待（`keel_wait` 等）：等完照新的 `next` 接着做。在等 CI 不是结束本轮的理由。'));
  assert.ok(text.includes('`next.kind` 是 `decide`：自己答。done 门缺项只剩 `pr_status 是 mark_ready` 就是验收点，不答这个门，按第 3 节写 checkpoint；缺项是在等 CI（如 `pr_status 是 wait_for_ci`）答 `wait`；缺 SC 证据选 `revise`；验证没过选 `retry_verify`；不选 `waive`'));
  assert.ok(text.includes('其他门拿不准先问 KEEL 的 `jev`；低于执行线时取改动最小、可撤回的选项（KEEL 手册第 9 条）。'));
  assert.ok(text.includes('`next.kind` 是 `stop`：分支被别的 worktree 占着就跑第 3 节的 `free-worktree`，再调一次；别的原因写 `blocked_user`。'));
  assert.doesNotMatch(text, /回报 lead|问用户|问 lead|回来问/, '没有渠道的指引会让 owner 停下等人');
});

test('#69 SC6 checkpoint 命令带脚本与台账的绝对路径、本子 issue 全部 SC（KEEL 管的 pass，黑盒 manual）', () => {
  const fixture = parentFixture();
  const { repoDir } = writeFixture(fixture);
  const { root, children } = readRoot(ghFrom(fixture), `${REPO}#10`);
  const plan = buildPlan({ root, children, repoDirs: { [REPO]: repoDir }, lead: 'codex', entry: '批准执行', now: '2026-10-29T08:00:00.000Z' });
  const item = plan.items.find((i) => i.ref === `${REPO}#11`);
  const text = renderIssueHandoff({ plan, item, leadSessionId: 'lead-1', ledgerPath: '/abs/run/ledger.json', scriptsDir: '/abs/skill/scripts' });
  assert.ok(text.includes(`node "/abs/skill/scripts/issue-run.mjs" checkpoint --ledger "/abs/run/ledger.json" --item ${REPO}#11 --state awaiting_acceptance`));
  assert.ok(text.includes(`--sc '[{"id":"SC1","status":"pass"},{"id":"SC2","status":"pass"},{"id":"SC4","status":"pass"},{"id":"SC3","status":"manual"}]'`));
  assert.ok(text.includes('--state blocked_user --reason'));
  assert.ok(text.includes(`node "/abs/skill/scripts/issue-run.mjs" checkpoint --ledger "/abs/run/ledger.json" --item ${REPO}#11 --state needs_lead --reason`), '#77 SC4：范围或验收标准必须改时交回 lead');
  assert.ok(text.includes(`node "/abs/skill/scripts/issue-run.mjs" free-worktree --ledger "/abs/run/ledger.json" --item ${REPO}#11\n`), '#77 SC6：判要改后先释放旧 worktree');
});
