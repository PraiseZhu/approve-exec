// Autonomous P3 review-thread closure. Permission errors degrade; they must not fail the poll.
const REPLY_TEXT = '这是一条 P3 级（建议类）反馈，不是阻塞性问题。按 Cindy 仓当前规则，这类建议本轮不安排修复；'
  + '如后续需要可另行处理。讨论到此关闭，不影响本 PR 等待维护者审批。';

export function autoCloseReplyText() {
  return REPLY_TEXT;
}

export function isPermissionError(error) {
  const status = error?.status ?? error?.exitCode ?? error?.code;
  const text = String(error?.message ?? error?.stderr ?? error ?? '');
  return status === 403 || status === '403'
    || /(?:^|\D)403(?:\D|$)|FORBIDDEN|Resource not accessible by integration|insufficient permission|permission denied|not allowed to/i.test(text);
}

export function isAutoCloseEligible(item) {
  const severities = item?.repairPolicy?.severities ?? [];
  return Boolean(item) && item.category === 'reply-resolve'
    && item.repairPolicy?.action === 'reply-only'
    && severities.includes('P3')
    && !severities.some((s) => s === 'P0' || s === 'P1' || s === 'P2')
    && typeof item.threadId === 'string' && item.threadId.length > 0;
}

export function partitionAutoClose(fresh = []) {
  const eligible = [];
  const remaining = [];
  for (const item of fresh) (isAutoCloseEligible(item) ? eligible : remaining).push(item);
  return { eligible, remaining };
}

const replyMutation = 'mutation($tid:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){comment{id}}}';
const resolveMutation = 'mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}';

export function* autoCloseThreads({ eligible = [], previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const seen = new Set();
  for (const item of eligible) {
    const threadId = item.threadId;
    if (seen.has(threadId) || closedThreads[threadId]) { seen.add(threadId); continue; }
    seen.add(threadId);
    const reply = yield () => {
      try { return ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${threadId}`, '-f', `body=${autoCloseReplyText()}`]); }
      catch (error) { if (isPermissionError(error)) return { __degraded: true, error }; throw error; }
    };
    if (reply?.__degraded) {
      results.push({ threadId, key: item.key ?? null, degraded: true, reason: 'permission-denied',
        report: 'GitHub 拒绝回复或 resolve（权限不足）。仅在本会话报告，不视为本轮 poll 失败。' });
      continue;
    }
    const resolved = yield () => {
      try { return ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${threadId}`]); }
      catch (error) { if (isPermissionError(error)) return { __degraded: true, error }; throw error; }
    };
    if (resolved?.__degraded) {
      results.push({ threadId, key: item.key ?? null, degraded: true, reason: 'permission-denied',
        report: 'GitHub 拒绝回复或 resolve（权限不足）。仅在本会话报告，不视为本轮 poll 失败。' });
      continue;
    }
    closedThreads[threadId] = { at: now, key: item.key ?? null, nativeId: item.nativeId ?? null };
    results.push({ threadId, key: item.key ?? null });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}
