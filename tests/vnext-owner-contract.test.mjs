import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerError } from '../scripts/run-ledger.mjs';
import {
  assertOwnerTitle, assertExcerpts, assertVerifyCmds, assertHandoffComplete,
  assertCreateGatewayOrFailClosed, watchTaskName, HOST_CREATE_GATEWAY,
  CONTRACT_VERSION, OWNER_STATES, LEGACY_GROUP_STATES,
} from '../scripts/vnext-owner-contract.mjs';
import { sessionTitle, titlePrefixForRepo } from '../scripts/session-dispatch.mjs';
import { planDispatch } from '../scripts/pr-watch/session-watch.mjs';

test('legacy accepted 不得冒充 PR_READY', () => {
  assert.ok(LEGACY_GROUP_STATES.includes('accepted'));
  assert.equal(LEGACY_GROUP_STATES.includes('PR_READY'), false);
  assert.ok(OWNER_STATES.includes('PR_READY'));
  assert.ok(OWNER_STATES.includes('CANDIDATE_ACCEPTED'));
  assert.ok(CONTRACT_VERSION.startsWith('vnext-'));
});

test('title 任务段必须含汉字，英文 kebab / group id 拒', () => {
  assert.equal(sessionTitle({ project: 'MivoPlugin', task: '复制PNG修复', mmdd: '0905' }), 'MivoPlugin-复制PNG修复丨 0905');
  assert.throws(() => assertOwnerTitle('MivoPlugin-verify-copy-461丨 0904'), LedgerError);
  assert.throws(() => assertOwnerTitle('MivoPlugin-probe-448丨 0904'), LedgerError);
  assert.throws(() => sessionTitle({ project: 'MivoPlugin', task: 'g2', mmdd: '0904' }), LedgerError);
  assert.throws(() => assertOwnerTitle('项目名verify-copy丨 0905'), LedgerError);
});

test('摘录占位与只用 gh pr diff 拒', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(root);
  assert.throws(() => assertExcerpts([]), LedgerError);
  assert.throws(() => assertExcerpts(['（本包未附摘录：子 session 仍须按 allowed_paths 开工，禁止 Grep 整模块。）'], { worktree: repoRoot }), LedgerError);
  assert.throws(() => assertExcerpts(['src/a.ts:1'], { worktree: repoRoot }), LedgerError);
  assert.throws(() => assertExcerpts([{ file: 'src/lib/a.ts', line: 3, behavior: 'foo' }], { worktree: repoRoot }), LedgerError);
  assert.throws(() => assertVerifyCmds(['gh pr diff 461 --repo xindong/mivo-canvas-plugin']), LedgerError);
  assert.throws(() => assertVerifyCmds(['cd /repo && gh pr diff 24']), LedgerError);
  assertVerifyCmds(['node scripts/run-tests.mjs']);
  assertExcerpts([{ file: 'scripts/render-pr-handoff.mjs', line: 1, behavior: 'renderPrHandoff 入口' }], { worktree: repoRoot });
});

test('缺宿主 create gateway 真派 fail-closed，dry-run 放行', () => {
  assert.equal(HOST_CREATE_GATEWAY.available, false);
  const dry = assertCreateGatewayOrFailClosed({ dryRun: true });
  assert.equal(dry.mode, 'dry-run');
  assert.throws(() => assertCreateGatewayOrFailClosed({ dryRun: false }), (err) => (
    err instanceof LedgerError && err.code === 'HOST_GATEWAY_MISSING'
  ));
});

test('handoff 含停等验收 / 缺 PR Ready 拒', () => {
  const base = [
    '用 goal skill 执行。',
    '## 0. 开工闸', 'x',
    '## 1. 身份', 'x',
    '## 2. 为什么改', '失败可见',
    '## 3. 不要重读也能开工的现场', 'src/a.ts:1 foo',
    '## 4. 具体改法', '改 writePng',
    '## 5. allowed_paths', 'src/a.ts',
    '## 6. SC 全文', 'sc-1',
    '## 7. 验证命令', 'node scripts/run-tests.mjs',
    '## 8. 做完之后（自动，不要问 lead）', '可自决\n必须停\ncandidate 只是检查点\nPR Ready\n429 按 fallbacks 换 provider、不换代次',
    '## 9. 禁做', 'x',
    '## 10. 回报格式', 'pr_ready',
  ].join('\n');
  assert.equal(assertHandoffComplete(base).ok, true);
  assert.throws(() => assertHandoffComplete(`${base}\n停等验收`), LedgerError);
  assert.throws(() => assertHandoffComplete(`${base}\n限流解除后再开 review`), LedgerError);
  assert.throws(() => assertHandoffComplete(base.replace('429 按 fallbacks 换 provider、不换代次', '')), LedgerError);
});

test('盯梢必须等本组 pr_ready，不是开 PR 即发、也不是等整批 run ready', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /pr_ready/);
  assert.match(skill, /开 PR ≠ 发盯梢|尚未 `pr_ready`|仅开 PR 不得发 Mini 盯梢|谁 Ready 发谁/);
  assert.match(skill, /4 个 PR|谁 Ready 发谁/);
});

test('盯梢 create 标题走 sessionTitle，不是 owner/repo#号 盯梢', () => {
  assert.equal(titlePrefixForRepo('xindong/mivo-canvas-plugin'), 'MivoPlugin');
  assert.equal(watchTaskName(461), '盯梢修复461');
  assert.throws(
    () => planDispatch({
      decision: 'actionable',
      state: { owner: 'xindong', repo: 'mivo-canvas-plugin', pr_number: 461, session_id: null, mmdd: '0905' },
      signals: ['comment'],
      newItems: { comments: [{ id: 'c1', body: 'fix' }] },
    }),
    /HOST_GATEWAY_MISSING|缺宿主 create gateway/,
  );
  const create = planDispatch({
    decision: 'actionable',
    state: { owner: 'xindong', repo: 'mivo-canvas-plugin', pr_number: 461, session_id: null, mmdd: '0905' },
    signals: ['comment'],
    newItems: { comments: [{ id: 'c1', body: 'fix' }] },
    gatewayAvailable: true,
  });
  assert.equal(create.title, 'MivoPlugin-盯梢修复461丨 0905');
  assert.doesNotMatch(create.title, /xindong\/mivo-canvas-plugin#461 盯梢/);
});
