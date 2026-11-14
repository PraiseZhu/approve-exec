#!/usr/bin/env node
// replay-capture.mjs — 把一次批准执行 run 的 GitHub 时间线录成回放数据（PraiseZhu/approve-exec#102）。
// 只读 GitHub（只发 GET）。对账器在线上运行时也用同一个 capture()，所以「现读」和「回放」走同一条判定路径。
//
// CLI:
//   node scripts/replay-capture.mjs --root <owner/repo#号> --out <目录> [--light] [--slim（进仓库的测试数据必须带：只留时间线骨架，去掉标题、正文、提交说明、文件名）]
//   node scripts/replay-capture.mjs --check <目录>
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>]
// 输出：stdout 一行 JSON；exit 0 成功 / 2 拒绝或校验不过（stderr 写原因）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain, nowIso, parseArgs } from './lib/common.mjs';
import { ghRunner, parseIssueRef, readRoot } from './issue-plan.mjs';

export class CaptureError extends Error {}
const reject = (msg) => { throw new CaptureError(msg); };

export const REPLAY_SCHEMA = 'approve-exec/replay@1';
const BODY_MAX = 4000;
const MAX_PAGES = 10;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SECRET_RES = [/gh[pousr]_[A-Za-z0-9]{8,}/, /\bsk-[A-Za-z0-9_-]{16,}/, /BEGIN [A-Z ]*PRIVATE KEY/];
const TIMELINE_EVENTS = ['ready_for_review', 'convert_to_draft', 'labeled', 'unlabeled', 'reviewed', 'merged', 'closed'];

// helpers

/** 正文脱敏：命中密钥样式整条换掉；邮箱换成占位；超长截断。 */
export function toSafeText(text) {
  const raw = String(text ?? '');
  if (SECRET_RES.some((re) => re.test(raw))) return { body: '[REDACTED]', truncated: false };
  const noEmail = raw.replace(EMAIL_RE, '[EMAIL]');
  return noEmail.length > BODY_MAX ? { body: noEmail.slice(0, BODY_MAX), truncated: true } : { body: noEmail, truncated: false };
}

function readPaged(gh, path) {
  const all = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = gh(['api', `${path}${sep}per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) reject(`读 ${path} 返回的不是数组（第 ${page} 页）`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  reject(`${path} 超过 ${MAX_PAGES * 100} 条，录不完整`);
}

const toComment = (c) => ({ id: c.id ?? null, user: c.user?.login ?? null, created_at: c.created_at ?? null, ...toSafeText(c.body) });

function toIssue(gh, repo, issue) {
  const ref = `${repo}#${issue.number}`;
  return {
    ref,
    number: issue.number,
    title: issue.title ?? '',
    state: issue.state ?? null,
    state_reason: issue.state_reason ?? null,
    created_at: issue.created_at ?? null,
    closed_at: issue.closed_at ?? null,
    ...toSafeText(issue.body),
    comments: readPaged(gh, `repos/${repo}/issues/${issue.number}/comments`).map(toComment),
  };
}

/** 子 issue 的时间线里被哪些 PR 提到过（跨引用），再按 PR 正文「任务 issue：<ref>」一行确认归属。 */
function selectTaskPrNumbers(gh, repo, number) {
  const timeline = readPaged(gh, `repos/${repo}/issues/${number}/timeline`);
  const numbers = new Set();
  for (const e of timeline) {
    const src = e?.source?.issue;
    if (e.event === 'cross-referenced' && src?.pull_request && String(src.repository_url ?? '').endsWith(`/${repo}`)) numbers.add(src.number);
  }
  return [...numbers].sort((a, b) => a - b);
}

function toPr(gh, repo, number, taskRef, { light }) {
  const pr = gh(['api', `repos/${repo}/pulls/${number}`]);
  const hasLine = String(pr.body ?? '').split('\n').some((l) => l.trim() === `任务 issue：${taskRef}`);
  if (!hasLine) return null;
  const events = readPaged(gh, `repos/${repo}/issues/${number}/timeline`)
    .filter((e) => TIMELINE_EVENTS.includes(e.event))
    .map((e) => ({ event: e.event, at: e.created_at ?? e.submitted_at ?? null, label: e.label?.name ?? null, actor: e.actor?.login ?? e.user?.login ?? null }))
    .filter((e) => e.at);
  const commits = readPaged(gh, `repos/${repo}/pulls/${number}/commits`).map((c) => {
    const merge = (c.parents ?? []).length > 1;
    const base = { sha: c.sha, at: c.commit?.committer?.date ?? c.commit?.author?.date ?? null, message: String(c.commit?.message ?? '').split('\n')[0].slice(0, 160), merge };
    if (light || merge) return base;
    const detail = gh(['api', `repos/${repo}/commits/${c.sha}`]);
    return { ...base, files: (detail.files ?? []).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) };
  });
  const reviews = readPaged(gh, `repos/${repo}/pulls/${number}/reviews`).map((r) => ({ user: r.user?.login ?? null, state: r.state ?? null, at: r.submitted_at ?? null })).filter((r) => r.at);
  return {
    repo,
    number,
    task_ref: taskRef,
    title: pr.title ?? '',
    state: pr.state ?? null,
    draft: pr.draft === true,
    base: pr.base?.ref ?? null,
    head_sha: pr.head?.sha ?? null,
    created_at: pr.created_at ?? null,
    closed_at: pr.closed_at ?? null,
    merged_at: pr.merged_at ?? null,
    merged_by: pr.merged_by?.login ?? null,
    events,
    commits,
    reviews,
  };
}

// capture

/** 读一个总 issue（或独立 issue）的全部回放数据。light 为真时不逐个读提交的改动文件（线上对账用）。 */
export function capture({ gh, rootRef, light = false, now = nowIso() }) {
  const { root, children } = readRoot(gh, rootRef);
  const sources = children.length ? children : [{ repo: root.repo, issue: root.issue }];
  const login = gh(['api', 'user'])?.login ?? null;
  const prs = [];
  const childData = sources.map(({ repo, issue }) => {
    const child = toIssue(gh, repo, issue);
    for (const n of selectTaskPrNumbers(gh, repo, issue.number)) {
      const pr = toPr(gh, repo, n, child.ref, { light });
      if (pr) prs.push(pr);
    }
    return child;
  });
  return {
    schema: REPLAY_SCHEMA,
    captured_at: now,
    login,
    root: children.length ? toIssue(gh, root.repo, root.issue) : { ref: root.ref, number: root.number, title: root.issue.title ?? '', comments: [] },
    children: childData,
    prs,
  };
}

/**
 * 瘦身：只留对账要用的时间线骨架，进仓库的回放数据必须用它（本仓是公开仓，目标仓可能是私有的）。
 * 留下：编号、状态、时间、目标分支名、标签名、提交哈希、review 时间，以及批准执行自己的协议评论首行和机器标记。
 * 去掉：issue 和 PR 的标题与正文、提交说明、改动文件名、其他评论的全部文字、派发评论里的会话标题、登录名以外的人名。
 */
export function toSlim(data) {
  const MARK_RE = /<!-- approve-exec:[a-z]+ v1 \{.*?\} -->/gs;
  const slimComment = (c) => {
    const body = String(c.body ?? '');
    const marks = body.match(MARK_RE) ?? [];
    let first = body.split('\n')[0];
    first = /^批准执行/.test(first) ? first.replace(/（[^（）]*丨\d{4}）/, '（会话标题已去掉）').slice(0, 200) : '';
    return { id: c.id, user: c.user, created_at: c.created_at, body: marks.length ? `${first}\n\n${marks.join('\n')}` : first, truncated: false };
  };
  const slimIssue = (i) => (i ? { ...i, title: '', body: '', truncated: false, comments: (i.comments ?? []).map(slimComment) } : i);
  const slimPr = (p) => ({
    ...p,
    title: '',
    events: (p.events ?? []).map((e) => ({ event: e.event, at: e.at, label: e.label ?? null })),
    commits: (p.commits ?? []).map((c) => ({ sha: c.sha, at: c.at, merge: c.merge === true })),
    reviews: (p.reviews ?? []).map((r) => ({ state: r.state ?? null, at: r.at })),
  });
  return { ...data, slim: true, root: slimIssue(data.root), children: (data.children ?? []).map(slimIssue), prs: (data.prs ?? []).map(slimPr) };
}

export const toFileName = (ref) => { const { repo, number } = parseIssueRef(ref); return `${repo.replace('/', '__')}__${number}.json`; };

// check

/** 校验一个目录里的全部回放文件。返回问题清单（空 = 通过）。 */
export function checkDir(dir) {
  const problems = [];
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (err) { return [`读不了目录 ${dir}（${err.code ?? err.message}）`]; }
  if (files.length === 0) problems.push(`${dir} 里没有回放文件`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    let data;
    try { data = JSON.parse(text); } catch { problems.push(`${f}：不是合法 JSON`); continue; }
    if (data.schema !== REPLAY_SCHEMA) problems.push(`${f}：schema 应是 ${REPLAY_SCHEMA}，实际 ${data.schema}`);
    if (!Array.isArray(data.children) || !Array.isArray(data.prs)) problems.push(`${f}：缺 children 或 prs 数组`);
    if (data.slim !== true) problems.push(`${f}：不是瘦身版（用 --slim 重录）：进仓库的回放数据不能带目标仓的标题、正文、提交说明和文件名`);
    else if ([data.root, ...(data.children ?? [])].some((i) => i?.title || i?.body) || (data.prs ?? []).some((p) => p.title || (p.commits ?? []).some((c) => c.message || c.files))) problems.push(`${f}：标了瘦身却还带着标题、正文、提交说明或文件名`);
    if (text.match(EMAIL_RE)) problems.push(`${f}：有邮箱样式的字符串`);
    const hit = SECRET_RES.find((re) => re.test(text));
    if (hit) problems.push(`${f}：有密钥样式的字符串（${hit.source}）`);
  }
  return problems;
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  try {
    if (typeof args.check === 'string') {
      const problems = checkDir(args.check);
      if (problems.length) { process.stderr.write(`[REJECT] ${problems.join('\n[REJECT] ')}\n`); return 2; }
      process.stdout.write(`${JSON.stringify({ ok: true, dir: args.check })}\n`);
      return 0;
    }
    if (typeof args.root !== 'string' || typeof args.out !== 'string') reject('要么 --root <owner/repo#号> --out <目录>，要么 --check <目录>');
    const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
    const full = capture({ gh, rootRef: args.root, light: args.light === true, now: typeof args.now === 'string' ? args.now : nowIso() });
    const data = args.slim === true ? toSlim(full) : full;
    mkdirSync(args.out, { recursive: true });
    const file = join(args.out, toFileName(args.root));
    writeFileSync(file, `${JSON.stringify(data)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, file, children: data.children.length, prs: data.prs.length })}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
