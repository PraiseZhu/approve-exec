// issue 入口测试夹具：按 task-issue/v1 模板拼子 issue 正文，并生成 gh 夹具（key = gh 参数用空格拼接）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixturePost } from '../../../scripts/issue-plan.mjs';

export const REPO = 'acme/app';

export function childBody({
  group = 'A',
  goal = '用户能在设置页看到同步状态。',
  scope = ['- `src/sync/status.ts`：读状态', '- `tests/sync/*.test.ts`：相关测试'],
  notDo = ['- 不改服务端'],
  deps = '无，随时可开工',
  pending = '无',
  scs = [
    '- [ ] SC1 状态为 ok 时显示「已同步」。验证：unit（测试点：`renderStatus`）',
    '- [ ] SC2 断网 30 秒后显示「离线」。验证：browser-fixture（测试点：设置页）',
    '- [ ] SC3 上线后 24 小时内无同步报错。验证：github-live',
    '- [ ] SC4 目标仓测试与 CI 全绿。验证：static',
  ],
  target = 'main',
} = {}) {
  return [
    `> 子 issue · 总 issue ${REPO}#10 · 并行组 ${group} · 对应 1 个 PR（PR 指向 ${target}，正文写一行「任务 issue：${REPO}#本 issue」）`,
    '',
    '## 目标', '', goal, '',
    '## 原因', '', '后面的通知功能依赖它。', '',
    '## 范围（可改）', '', ...scope, '',
    '## 不做', '', ...notDo, '',
    '## 参考', '', '- `docs/sync.md` 第 2 节：状态定义', '',
    '## 依赖', '', deps, '',
    '## 待定问题', '', pending, '',
    '## 验收标准', '',
    '<!-- 每条写到能判对错 -->',
    ...scs,
    '',
  ].join('\n');
}

export function issue(number, title, body, { state = 'open', state_reason = null } = {}) {
  return {
    number,
    title,
    body,
    state,
    state_reason,
    html_url: `https://github.com/${REPO}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${REPO}`,
  };
}

/** 总 issue #10 下挂 A(#11)、B(#12)、C(#13，等 A 合入)；D(#14) 与 A 并行开发、A 先合。 */
export function parentFixture({ aState = 'open', aReason = null, cBody, extra = {} } = {}) {
  const a = issue(11, '[子1/4] 同步状态读取：从本地缓存读', childBody());
  const b = issue(12, '[子2/4] 同步状态图标', childBody({ scope: ['- `src/sync/icon.ts`：图标', '- `tests/sync/icon.test.ts`：图标测试'] }));
  const c = issue(13, '[子3/4] 离线提醒', cBody ?? childBody({ group: 'B', deps: '等 #11 合进 main 再开工（要用它新写的读取函数）', scope: ['- `src/sync/offline.ts`：提醒'] }));
  const d = issue(14, '[子4/4] 文案', childBody({ deps: '与 #11 并行开发，#11 先合（只是上线有先后）', scope: ['- `docs/copy.md`：文案'] }));
  const parent = issue(10, '[总] 同步状态可见', '总 issue 正文');
  return {
    [`api repos/${REPO}/issues/10`]: parent,
    [`api repos/${REPO}/issues/10/sub_issues?per_page=100`]: [a, b, c, d],
    [`api repos/${REPO}/issues/11`]: { ...a, state: aState, state_reason: aReason },
    [`api repos/${REPO}/issues/12`]: b,
    [`api repos/${REPO}/issues/13`]: c,
    [`api repos/${REPO}/issues/14`]: d,
    [`api repos/${REPO}/issues/10/comments?per_page=100`]: [],
    ...extra,
  };
}

export function standaloneFixture(body = childBody()) {
  const s = issue(20, '修复同步按钮', body);
  return {
    [`api repos/${REPO}/issues/20`]: s,
    [`api repos/${REPO}/issues/20/sub_issues?per_page=100`]: [],
    [`api repos/${REPO}/issues/20/comments?per_page=100`]: [],
  };
}

/** 夹具 → 临时目录：gh.json 与一个空的「目标仓主目录」。 */
export function writeFixture(fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-plan-'));
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir);
  const ghPath = join(dir, 'gh.json');
  writeFileSync(ghPath, JSON.stringify(fixture));
  return { dir, repoDir, ghPath };
}

/** 内存版 gh：读取查夹具；发评论写回夹具（同一 fixture 对象），之后的读取能读到。 */
export function ghFrom(fixture) {
  return (args) => {
    if (args[1] === '-X' && args[2] === 'POST') return fixturePost(fixture, args);
    const key = args.join(' ');
    if (!Object.hasOwn(fixture, key)) throw new Error(`gh 夹具缺少: ${key}`);
    return fixture[key];
  };
}
