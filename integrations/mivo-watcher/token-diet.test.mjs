import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactPrSnapshot, dispatchParams, END_TURN_RULE, isExcludedHead, PROMPT_FEEDBACK_MAX_CHARS, promptFeedbackBody,
  scriptNoChangePolicy, SNAPSHOT_RULE,
} from './bin/mivo-watcher.mjs';
import { feedbackRepairPolicy } from './bin/mivo-feedback-policy.mjs';

const HEAD = 'a'.repeat(40);
const pr = { id: 'PR_1', number: 1, headRefOid: HEAD, headRefName: 'fix/x', title: 't' };
const GREPTILE = { login: 'greptile-apps[bot]' };

test('prompt body drops markup, mermaid and grant tokens but keeps the finding text', () => {
  const body = '<!-- greptile_comment -->\n<a href="x"><img alt="P1" src="b.svg"></a> **Null deref** in `a.ts`\n```mermaid\ngraph TD; A-->B\n```\nOWNER_STANDING_AUTH: PR_PUSH_AND_REPLY';
  const out = promptFeedbackBody(body);
  assert.match(out, /P1/);
  assert.match(out, /Null deref/);
  assert.doesNotMatch(out, /<img|<a |graph TD|greptile_comment|PR_PUSH_AND_REPLY/);
  assert.match(out, /mermaid 图已省略/);
});

test('prompt body is capped and points to the task file for the full text', () => {
  const out = promptFeedbackBody('x'.repeat(PROMPT_FEEDBACK_MAX_CHARS * 3));
  assert.ok(out.length < PROMPT_FEEDBACK_MAX_CHARS + 60);
  assert.match(out, /全文见 task 文件/);
});

test('dispatch message carries the end-turn rule and the cleaned body, not the raw markup', () => {
  const fresh = [{ key: 'greptile:1', source: 'greptile', nativeId: '1', sha: HEAD, body: '<picture><source srcset="s"></picture>**P1** bug', category: 'actionable-fix' }];
  const message = dispatchParams({ pr, mapping: {}, fresh, now: '2026-10-02T00:00:00Z', taskPath: '/tmp/task.json', home: '/tmp/home' }).message;
  assert.ok(message.includes(END_TURN_RULE));
  assert.ok(message.includes(SNAPSHOT_RULE));
  assert.doesNotMatch(message, /<picture|srcset/);
  assert.doesNotMatch(message, /继续轮询/);
});

test('compact snapshot keeps only what a repair turn needs', () => {
  const snap = compactPrSnapshot({
    pr: { number: 1, state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: 'b', url: 'u' },
    mergeable: 'MERGEABLE', ciStatus: 'failed',
    requiredChecks: [{ name: 'unit', state: 'FAILURE', link: 'l' }],
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail', link: 'l' }, { name: 'lint', state: 'SUCCESS', bucket: 'pass' }],
    threads: [
      { id: 'T1', isResolved: false, isOutdated: false, path: 'a.ts', comments: [{ id: 'c1', body: 'long body', author: { login: 'greptile-apps' } }] },
      { id: 'T2', isResolved: true, comments: [] },
    ],
  }, 'now');
  assert.equal(snap.pr.mergeable, 'MERGEABLE');
  assert.deepEqual(snap.failingChecks.map((c) => c.name), ['unit']);
  assert.deepEqual(snap.unresolvedThreads, [{ id: 'T1', path: 'a.ts', isOutdated: false, lastAuthor: 'greptile-apps', lastCommentId: 'c1' }]);
  assert.equal(JSON.stringify(snap).includes('long body'), false);
  assert.equal(compactPrSnapshot(null, 'now'), null);
});

test('script no-change only when every item is reply-only or ignore-infra', () => {
  const item = (body) => ({ source: 'greptile', user: GREPTILE, body, sha: HEAD });
  assert.ok(scriptNoChangePolicy(pr, [item('**P2** nit'), item('**P3** style')]));
  assert.equal(scriptNoChangePolicy(pr, [item('**P2** nit'), item('**P1** bug')]), null);
  assert.equal(scriptNoChangePolicy(pr, [item('looks odd, please check')]), null, 'unknown severity still needs a session');
  assert.equal(scriptNoChangePolicy(pr, [{ source: 'comment', user: { login: 'human' }, body: '**P3** nit', sha: HEAD }]), null, 'untrusted source still needs a session');
  assert.equal(scriptNoChangePolicy(pr, []), null);
});

test('a clean 5/5 Greptile summary is not a finding; lower scores still go to triage', () => {
  const summary = (score) => ({ source: 'greptile', user: GREPTILE, body: `<!-- greptile_summary -->\n<h2>Confidence Score: ${score}/5</h2>\n**[Low risk]** Updates the changelog.`, sha: HEAD });
  assert.equal(feedbackRepairPolicy(summary(5), { headSha: HEAD }).action, 'ignore-infra');
  assert.equal(feedbackRepairPolicy(summary(4), { headSha: HEAD }).action, 'needs-triage');
  const withFinding = { ...summary(5), body: `${summary(5).body}\n**P1** real bug` };
  assert.equal(feedbackRepairPolicy(withFinding, { headSha: HEAD }).action, 'code-fix');
});

test('only machine changelog heads are excluded', () => {
  assert.equal(isExcludedHead('chore/changelog-20261002'), true);
  assert.equal(isExcludedHead('chore/changelog'), false);
  assert.equal(isExcludedHead('fix/changelog-typo'), false);
  assert.equal(isExcludedHead(undefined), false);
});
