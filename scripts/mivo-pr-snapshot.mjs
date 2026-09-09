const DEFAULT_REPO = 'xindong/mivo-canvas-plugin';
const FIELDS = 'id,number,title,url,state,isDraft,headRefOid,headRefName,baseRefOid,baseRefName,createdAt,author,isCrossRepository,headRepository,headRepositoryOwner,mergeable,reviewDecision';
const parse = (raw) => typeof raw === 'string' ? JSON.parse(raw) : raw;
const requireValue = (ok, reason) => { if (!ok) throw new Error(`PR snapshot: ${reason}`); };
const quote = (value) => JSON.stringify(value);

function basic(raw, repo, number) {
  const value = parse(raw);
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid PR');
  for (const key of ['id', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName', 'createdAt']) requireValue(typeof value[key] === 'string' && value[key].length > 0, `missing ${key}`);
  requireValue(/^[a-f0-9]{40}$/i.test(value.headRefOid) && /^[a-f0-9]{40}$/i.test(value.baseRefOid), 'invalid SHA');
  requireValue(value.number === number && ['OPEN', 'CLOSED', 'MERGED'].includes(value.state) && typeof value.isDraft === 'boolean', 'invalid identity/state');
  requireValue(Number.isFinite(Date.parse(value.createdAt)) && typeof value.author?.login === 'string', 'missing author/createdAt');
  requireValue(typeof value.isCrossRepository === 'boolean', 'missing repository identity');
  requireValue(value.headRepository?.name && value.headRepositoryOwner?.login, 'missing head repository');
  const sameRepository = `${value.headRepositoryOwner.login}/${value.headRepository.name}`.toLowerCase() === repo.toLowerCase();
  requireValue(sameRepository === !value.isCrossRepository, 'inconsistent repository identity');
  return { ...value, repo, sameRepository };
}

function* connection({ id, field, selection, ghFn, argument = '' }) {
  let cursor = null;
  const seen = new Set();
  const nodes = [];
  do {
    const after = cursor ? `,after:${quote(cursor)}` : '';
    const query = `query{node(id:${quote(id)}){... on ${field === 'comments' ? 'PullRequestReviewThread' : 'PullRequest'}{${field}(first:100${argument}${after}){nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`;
    const payload = parse(yield () => ghFn(['api', 'graphql', '-f', `query=${query}`]));
    requireValue(payload && !payload.errors?.length && !('errors' in payload && !Array.isArray(payload.errors)), 'GraphQL errors');
    const page = payload.data?.node?.[field];
    requireValue(Array.isArray(page?.nodes) && page.nodes.every((node) => node && typeof node === 'object') && typeof page.pageInfo?.hasNextPage === 'boolean', `incomplete ${field} page`);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    requireValue(typeof cursor === 'string' && cursor.length > 0 && !seen.has(cursor), `${field} cursor missing/repeated`);
    seen.add(cursor);
  } while (true);
  return nodes;
}

function* epoch({ pr, ghFn }) {
  const events = yield* connection({ id: pr.id, field: 'timelineItems', argument: ',itemTypes:[READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT]', selection: '__typename ... on ReadyForReviewEvent{id createdAt} ... on ConvertToDraftEvent{id createdAt}', ghFn });
  let latest = null;
  const ids = new Set();
  for (const event of events) {
    requireValue(['ReadyForReviewEvent', 'ConvertToDraftEvent'].includes(event.__typename) && typeof event.id === 'string' && !ids.has(event.id) && Number.isFinite(Date.parse(event.createdAt)), 'invalid timeline event');
    requireValue(!latest || Date.parse(event.createdAt) >= Date.parse(latest.createdAt), 'unordered timeline');
    ids.add(event.id);
    latest = event;
  }
  if (latest) {
    requireValue(pr.isDraft === (latest.__typename === 'ConvertToDraftEvent'), 'timeline/draft drift');
    return `${latest.__typename === 'ReadyForReviewEvent' ? 'ready' : 'draft'}:${pr.id}:${latest.id}:${latest.createdAt}`;
  }
  return `opened:${pr.id}:${pr.createdAt}`;
}

function list(raw, label) {
  const value = parse(raw);
  requireValue(Array.isArray(value) && value.every((item) => item && typeof item === 'object' && !Array.isArray(item)), `invalid ${label}`);
  return value;
}

export function* collectPrSnapshot({ pr, ghFn }) {
  const repo = pr.repo ?? DEFAULT_REPO;
  const number = Number(pr.number);
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0 && typeof ghFn === 'function', 'invalid input');
  const viewArgs = ['pr', 'view', String(number), '--repo', repo, '--json', FIELDS];
  const before = basic(yield () => ghFn(viewArgs), repo, number);
  for (const key of ['id', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName']) {
    if (pr[key] !== undefined) requireValue(pr[key] === before[key], `listed ${key} drift`);
  }
  const releaseEpoch = yield* epoch({ pr: before, ghFn });
  const checks = list(yield () => ghFn(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state,bucket,link']), 'checks');
  const requiredChecks = list(yield () => ghFn(['pr', 'checks', String(number), '--repo', repo, '--required', '--json', 'name,state,bucket,link']), 'required checks');
  const threads = yield* connection({ id: before.id, field: 'reviewThreads', selection: 'id isResolved isOutdated path', ghFn });
  const threadIds = new Set();
  for (const thread of threads) {
    requireValue(typeof thread.id === 'string' && !threadIds.has(thread.id) && typeof thread.isResolved === 'boolean' && typeof thread.isOutdated === 'boolean', 'invalid thread');
    threadIds.add(thread.id);
    thread.comments = yield* connection({ id: thread.id, field: 'comments', selection: 'id body createdAt updatedAt author{login}', ghFn });
  }
  const pages = parse(yield () => ghFn(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']));
  requireValue(Array.isArray(pages) && pages.every(Array.isArray), 'incomplete issue comments');
  const comments = pages.flat().map((comment) => {
    requireValue(comment && comment.id && typeof comment.body === 'string', 'invalid issue comment');
    return { ...comment, author: comment.author ?? comment.user, createdAt: comment.createdAt ?? comment.created_at, updatedAt: comment.updatedAt ?? comment.updated_at };
  });
  const reviews = yield* connection({ id: before.id, field: 'reviews', selection: 'id body state submittedAt author{login} commit{oid}', ghFn });
  const labelNodes = yield* connection({ id: before.id, field: 'labels', selection: 'name', ghFn });
  requireValue(labelNodes.every((label) => typeof label.name === 'string'), 'invalid labels');
  const after = basic(yield () => ghFn(viewArgs), repo, number);
  const afterEpoch = yield* epoch({ pr: after, ghFn });
  for (const key of ['id', 'state', 'isDraft', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName', 'sameRepository']) requireValue(before[key] === after[key], `stale ${key}`);
  requireValue(releaseEpoch === afterEpoch, 'stale release epoch');
  const requiredChecksGreen = requiredChecks.length > 0 && requiredChecks.every((check) => check.state === 'SUCCESS');
  const ciStatus = requiredChecksGreen ? 'green' : requiredChecks.some((check) => ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR'].includes(check.state)) ? 'failed'
    : requiredChecks.length && requiredChecks.every((check) => ['SUCCESS', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'EXPECTED'].includes(check.state)) ? 'pending' : 'unknown';
  return { pr: { ...after, releaseEpoch }, checks, requiredChecks, reviews, comments, threads, labels: labelNodes.map((label) => label.name),
    mergeable: after.mergeable ?? 'UNKNOWN', reviewDecision: after.reviewDecision, requiredChecksGreen, ciStatus,
    ciPolicySource: 'gh-required-checks-only', unifiedPolicyVerified: false, identityVerified: true };
}

export function collectPrSnapshotSync(options) {
  const iterator = collectPrSnapshot(options);
  let step = iterator.next();
  while (!step.done) {
    const value = step.value();
    requireValue(!value || typeof value.then !== 'function', 'async transport used with sync collector');
    step = iterator.next(value);
  }
  return step.value;
}

export function collectPrOwnershipSync({ pr, ghFn }) {
  const repo = pr.repo ?? DEFAULT_REPO;
  const number = Number(pr.number);
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && Number.isSafeInteger(number) && number > 0 && typeof ghFn === 'function', 'invalid input');
  const read = (args) => {
    const value = ghFn(args);
    requireValue(!value || typeof value.then !== 'function', 'async transport used with sync collector');
    return value;
  };
  const readEpoch = (current) => {
    const iterator = epoch({ pr: current, ghFn: read });
    let step = iterator.next();
    while (!step.done) step = iterator.next(step.value());
    return step.value;
  };
  const args = ['pr', 'view', String(number), '--repo', repo, '--json', FIELDS];
  const before = basic(read(args), repo, number);
  for (const key of ['id', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName']) {
    if (pr[key] !== undefined) requireValue(pr[key] === before[key], `listed ${key} drift`);
  }
  const releaseEpoch = readEpoch(before);
  const after = basic(read(args), repo, number);
  const afterEpoch = readEpoch(after);
  for (const key of ['id', 'state', 'isDraft', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName', 'sameRepository']) requireValue(before[key] === after[key], `stale ${key}`);
  requireValue(releaseEpoch === afterEpoch, 'stale release epoch');
  return { ...after, releaseEpoch, identityVerified: true };
}

export async function collectPrSnapshotAsync(options) {
  const iterator = collectPrSnapshot(options);
  let step = iterator.next();
  while (!step.done) step = iterator.next(await step.value());
  return step.value;
}
