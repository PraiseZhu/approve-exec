// replay-capture.mjs：回放数据的录制与校验（PraiseZhu/approve-exec#102）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { REPLAY_SCHEMA, capture, checkDir, toFileName, toSafeText } from '../scripts/replay-capture.mjs';

const DIR = fileURLToPath(new URL('./fixtures/replay/', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/replay-capture.mjs', import.meta.url));
const load = (n) => JSON.parse(readFileSync(join(DIR, `xindong__mivo-canvas-plugin__${n}.json`), 'utf8'));
const M = 'xindong/mivo-canvas-plugin';

test('画布边界那次 run 的回放数据：5 个子 PR 都在，PR 2141 的转正式时间和两次审查放行标签都录到了', () => {
  const data = load(2089);
  assert.equal(data.schema, REPLAY_SCHEMA);
  const numbers = data.prs.map((p) => p.number);
  for (const n of [2141, 2142, 2184, 2204, 2246]) assert.ok(numbers.includes(n), `缺 PR ${n}`);
  const pr = data.prs.find((p) => p.number === 2141);
  assert.equal(pr.task_ref, `${M}#2092`);
  assert.equal(pr.base, 'integration/canvas-bounds-s1');
  assert.ok(pr.events.some((e) => e.event === 'ready_for_review' && e.at.startsWith('2026-11-11T09:02')));
  assert.ok(pr.events.filter((e) => e.event === 'labeled' && e.label === 'review:merge-ready').length >= 2);
  assert.ok(pr.commits.some((c) => c.sha === '6a3334915b062c11693ff5811d28f82f172dcdda'), '判通过时的版本在提交列表里');
});

test('单文件 1200 行那次 run 的回放数据：7 个拆文件的 PR 都有合并时间', () => {
  const data = load(2214);
  for (const n of [2224, 2225, 2226, 2227, 2228, 2229, 2230]) {
    const pr = data.prs.find((p) => p.number === n);
    assert.ok(pr, `缺 PR ${n}`);
    assert.match(pr.merged_at, /^2026-11-12T/);
  }
});

test('--check：仓里的数据通过；塞进邮箱样式或密钥样式的字符串后退出码 2 并指出文件', () => {
  assert.deepEqual(checkDir(DIR), []);
  assert.equal(spawnSync(process.execPath, [CLI, '--check', DIR], { encoding: 'utf8' }).status, 0);
  const tmp = mkdtempSync(join(tmpdir(), 'replay-'));
  cpSync(join(DIR, 'xindong__mivo-canvas-plugin__2214.json'), join(tmp, 'a.json'));
  const text = readFileSync(join(tmp, 'a.json'), 'utf8');
  writeFileSync(join(tmp, 'a.json'), text.replace('"schema"', `"leak":"someone${'@'}example.com","schema"`));
  const bad = spawnSync(process.execPath, [CLI, '--check', tmp], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /a\.json：有邮箱样式的字符串/);
  writeFileSync(join(tmp, 'a.json'), text.replace('"schema"', `"leak":"${'ghp'}_${'x'.repeat(20)}","schema"`));
  assert.match(checkDir(tmp).join('\n'), /密钥样式/);
});

test('脱敏：邮箱换成占位，密钥样式整条换掉，超过 4000 字符截断并标记', () => {
  assert.equal(toSafeText(`联系 a.b${'@'}example.com`).body, '联系 [EMAIL]');
  assert.equal(toSafeText(`token ${'ghp'}_${'a'.repeat(30)}`).body, '[REDACTED]');
  const long = toSafeText('字'.repeat(5000));
  assert.equal(long.body.length, 4000);
  assert.equal(long.truncated, true);
  assert.equal(toFileName('xindong/mivo-canvas-plugin#2089'), 'xindong__mivo-canvas-plugin__2089.json');
});

test('录制只发读请求：把 PR 归到子 issue 靠时间线里的跨引用加正文「任务 issue」一行', () => {
  const R = 'acme/app';
  const H = 'c'.repeat(40);
  const issue = (n, extra = {}) => ({ number: n, title: `t${n}`, body: `b ${'x'}${'@'}example.com`, state: 'open', created_at: '2026-11-14T00:00:00Z', closed_at: null, repository_url: `https://api.github.com/repos/${R}`, ...extra });
  const xref = (n) => ({ event: 'cross-referenced', created_at: '2026-11-14T00:20:00Z', source: { issue: { number: n, pull_request: {}, repository_url: `https://api.github.com/repos/${R}` } } });
  const fixture = {
    [`api repos/${R}/issues/10`]: issue(10),
    [`api repos/${R}/issues/10/sub_issues?per_page=100`]: [issue(11)],
    'api user': { login: 'lead-account' },
    [`api repos/${R}/issues/10/comments?per_page=100&page=1`]: [],
    [`api repos/${R}/issues/11/comments?per_page=100&page=1`]: [{ id: 1, user: { login: 'lead-account' }, created_at: '2026-11-14T00:10:00Z', body: '批准执行派发：…' }],
    [`api repos/${R}/issues/11/timeline?per_page=100&page=1`]: [xref(5), xref(6)],
    [`api repos/${R}/pulls/5`]: { number: 5, title: 'pr', state: 'closed', draft: false, body: `任务 issue：${R}#11`, base: { ref: 'main' }, head: { sha: H }, created_at: '2026-11-14T00:20:00Z', merged_at: '2026-11-14T03:00:00Z', merged_by: { login: 'bot' } },
    [`api repos/${R}/pulls/6`]: { number: 6, title: '只是提到', state: 'open', draft: true, body: '顺带提到 #11', base: { ref: 'main' }, head: { sha: H } },
    [`api repos/${R}/issues/5/timeline?per_page=100&page=1`]: [{ event: 'ready_for_review', created_at: '2026-11-14T01:00:00Z', actor: { login: 'a' } }, { event: 'commented', created_at: '2026-11-14T01:01:00Z' }, { event: 'labeled', created_at: '2026-11-14T02:00:00Z', label: { name: 'review:merge-ready' } }],
    [`api repos/${R}/pulls/5/commits?per_page=100&page=1`]: [{ sha: H, parents: [{}], commit: { committer: { date: '2026-11-14T00:30:00Z' }, message: 'feat: x\n\nbody' } }],
    [`api repos/${R}/commits/${H}`]: { files: [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }] },
    [`api repos/${R}/pulls/5/reviews?per_page=100&page=1`]: [{ user: { login: 'bot' }, state: 'COMMENTED', submitted_at: '2026-11-14T01:30:00Z' }],
  };
  const calls = [];
  const gh = (args) => { calls.push(args.join(' ')); const k = args.join(' '); if (!Object.hasOwn(fixture, k)) throw new Error(`gh 夹具缺少: ${k}`); return fixture[k]; };
  const data = capture({ gh, rootRef: `${R}#10`, now: '2026-11-14T04:00:00Z' });
  assert.deepEqual(data.prs.map((p) => p.number), [5], '只提到子 issue、正文没有「任务 issue」一行的 PR 不算');
  assert.deepEqual(data.prs[0].events.map((e) => e.event), ['ready_for_review', 'labeled']);
  assert.deepEqual(data.prs[0].commits[0].files, [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }]);
  assert.equal(data.prs[0].commits[0].message, 'feat: x');
  assert.equal(data.children[0].body, 'b [EMAIL]');
  assert.deepEqual(calls.filter((c) => /-X (POST|PATCH|PUT|DELETE)/.test(c)), []);
});

test('瘦身：只留时间线骨架。标题、正文、提交说明、文件名、非协议评论的文字、会话标题都去掉；仓里的回放数据必须是瘦身版', async () => {
  const { toSlim } = await import('../scripts/replay-capture.mjs');
  const mark = '<!-- approve-exec:event v1 {"type":"verdict_pass","ref":"a/b#1"} -->';
  const full = { schema: REPLAY_SCHEMA, root: { ref: 'a/b#9', title: '[总] 内部项目名', body: '总 issue 正文', comments: [] },
    prs: [{ number: 2, title: 'feat: 内部功能', events: [{ event: 'labeled', at: 't', label: 'review:merge-ready', actor: '某人' }], commits: [{ sha: 'abc', at: 't', message: 'fix: 内部细节', merge: false, files: [{ filename: 'src/secret.ts' }] }], reviews: [{ user: '某人', state: 'COMMENTED', at: 't' }] }],
    children: [{ ref: 'a/b#1', title: '[子1/2] 内部功能', body: '很长的子 issue 正文', comments: [
      { id: 1, user: 'u', created_at: 't', body: `批准执行通过 a/b#1 PR #2\n\n细节一大段\n\n${mark}` },
      { id: 2, user: 'u', created_at: 't', body: '讨论内容第一行\n第二行' },
      { id: 3, user: 'u', created_at: 't', body: '批准执行派发：2026-11-10 a/b#1 → 会话 s-1（内部任务名丨1111）' },
    ] }] };
  const slim = toSlim(full);
  const text = JSON.stringify(slim);
  for (const leaked of ['内部', '正文', '讨论内容', 'src/secret.ts', '某人']) assert.equal(text.includes(leaked), false, `不该留下「${leaked}」`);
  assert.equal(slim.children[0].comments[0].body, `批准执行通过 a/b#1 PR #2\n\n${mark}`);
  assert.equal(slim.children[0].comments[1].body, '');
  assert.equal(slim.children[0].comments[2].body, '批准执行派发：2026-11-10 a/b#1 → 会话 s-1（会话标题已去掉）');
  assert.deepEqual(slim.prs[0].commits, [{ sha: 'abc', at: 't', merge: false }]);
  assert.deepEqual(slim.prs[0].events, [{ event: 'labeled', at: 't', label: 'review:merge-ready' }]);
  for (const n of [2089, 2214]) assert.equal(load(n).slim, true);
  // 没瘦身的数据过不了校验
  const tmp = mkdtempSync(join(tmpdir(), 'replay-full-'));
  writeFileSync(join(tmp, 'a.json'), JSON.stringify({ ...full, slim: undefined }));
  assert.match(checkDir(tmp).join('\n'), /不是瘦身版/);
  writeFileSync(join(tmp, 'a.json'), JSON.stringify({ ...full, slim: true }));
  assert.match(checkDir(tmp).join('\n'), /标了瘦身却还带着/);
});
