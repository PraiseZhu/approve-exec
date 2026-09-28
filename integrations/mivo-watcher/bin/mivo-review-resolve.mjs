// Autonomous P2/P3 review-thread closure. No human notification, no session dispatch.
// Eligibility is entirely derived from the existing policy layer:
//   category === 'reply-resolve'  (== feedbackRepairPolicy action 'reply-only')
// which already encodes: trusted source, P2/P3-only, current-head-bound, no code authority.
// Thread membership is tracked via the explicit `threadId` field (set only for
// GraphQL review-thread items), never via `item.source === 'thread'` — Greptile-authored
// thread comments carry `source: 'greptile'`, so gating on `source` would silently skip them.

const REPLY_TEXT = '这是一条 P2 级（建议类）反馈，不是阻塞性问题。按项目当前规则，这类建议本轮不安排修复；'
  + '如后续需要可另行处理。讨论到此关闭，不影响本 PR 合并。';

export function autoCloseReplyText() {
  return REPLY_TEXT;
}

export function isAutoCloseEligible(item) {
  return Boolean(item) && item.category === 'reply-resolve'
    && item.repairPolicy?.action === 'reply-only'
    && typeof item.threadId === 'string' && item.threadId.length > 0;
}

// Splits `fresh` into items this watcher will resolve on GitHub directly (never
// dispatched to a session) and the remainder that still flows through normal dispatch.
export function partitionAutoClose(fresh = []) {
  const eligible = [];
  const remaining = [];
  for (const item of fresh) (isAutoCloseEligible(item) ? eligible : remaining).push(item);
  return { eligible, remaining };
}

const replyMutation = 'mutation($tid:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){comment{id}}}';
const resolveMutation = 'mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}';

// Idempotent: `previous.autoClosedThreads[threadId]` is the durable receipt. Re-runs
// (retries, next poll before persistState lands) skip network calls for threads already closed.
export function* autoCloseThreads({ eligible = [], previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const seen = new Set();
  for (const item of eligible) {
    const threadId = item.threadId;
    if (seen.has(threadId) || closedThreads[threadId]) { seen.add(threadId); continue; }
    seen.add(threadId);
    yield () => ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${threadId}`, '-f', `body=${autoCloseReplyText()}`]);
    yield () => ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${threadId}`]);
    closedThreads[threadId] = { at: now, key: item.key ?? null, nativeId: item.nativeId ?? null };
    results.push({ threadId, key: item.key ?? null });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}
