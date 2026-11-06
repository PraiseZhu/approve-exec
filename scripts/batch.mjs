#!/usr/bin/env node
// batch.mjs — 批准执行（2026-11-07 改版：不走 KEEL、不建台账、不挂定时任务）。
// lead 用它看总 issue 下每个子 issue 走到哪一步、这一批能派哪些，生成开工消息，并在子 issue 上记派发 / 撤回防重派。
// 状态全部从 GitHub 现读：子 issue 与依赖 issue 的开关、正文写着「任务 issue：<ref>」的开着的 PR、子 issue 评论里的派发记录。
//
// CLI:
//   node scripts/batch.mjs status  --issue <owner/repo#号>
//   node scripts/batch.mjs brief   --item <子 issue> --lead <lead 会话 id> --repo-dir <目标仓主目录> --project <Cindy 项目路径>
//                                  [--name <人话任务名>] [--urgent] [--gateway <网关名>]
//   node scripts/batch.mjs archived --item <子 issue> --session <已归档的执行会话 id>
//   node scripts/batch.mjs claim   --item <子 issue> --session <派出的会话 id> --title <会话标题>
//   node scripts/batch.mjs release --item <子 issue> --reason <原因>
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>（测试用，代替 gh）]
// 输出：stdout 一行 JSON；exit 0 成功 / 2 拒绝（stderr 写原因）。
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, nowIso, parseArgs } from './lib/common.mjs';
import {
  assertChildTemplate, ghRunner, parseDeps, parseIssueRef, pendingQuestions, readIssue, readRoot, sectionText, splitSections, toKeelSc, toScope,
} from './issue-plan.mjs';
import { activeClaims, depStatus, ghLogin, readComments, sessionTitle } from './issue-run.mjs';

export class BatchError extends Error {}
const reject = (msg) => { throw new BatchError(msg); };

// 新派发记录的评论首行。不用「批准执行登记：」开头：验收机看到总 issue 上有登记评论会等 lead 交接（vigil#140），新流程没有这一步。
const DISPATCH_RE = /^批准执行派发：\S+ (\S+#\d+) → 会话 ([\w-]+)/;
const WITHDRAW_RE = /^批准执行撤回：\S+ (\S+#\d+)/;
const ARCHIVED_RE = /^批准执行归档：\S+ (\S+#\d+) 会话 ([\w-]+)/;
const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../config/defaults.json');
const SESSION_RE = /^[\w-]+$/;
const OPEN_PR_PAGES = 10;

// helpers

const commentsPath = (ref) => { const { repo, number } = parseIssueRef(ref); return `repos/${repo}/issues/${number}/comments`; };
const dateOf = (now) => String(now).slice(0, 10);

/** 评论 → 该子 issue 当前有效的派发记录（最后一条派发之后没有撤回）。只认 login 本人发的评论。 */
export function activeDispatch(comments, ref, login) {
  let current = null;
  const sorted = (Array.isArray(comments) ? comments : []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const c of sorted) {
    if (c.user?.login !== login) continue;
    const body = String(c.body ?? '');
    const d = DISPATCH_RE.exec(body);
    if (d && d[1] === ref) { current = { session: d[2], comment_id: c.id ?? null, url: c.html_url ?? null }; continue; }
    const w = WITHDRAW_RE.exec(body);
    if (w && w[1] === ref) current = null;
  }
  return current;
}

/** 评论 → 这个子 issue 派出过、还没记「批准执行归档」的会话（含已撤回的），按派发先后。lead 收工时据此归档。 */
export function unarchivedSessions(comments, ref, login) {
  const sessions = [];
  const archived = new Set();
  const sorted = (Array.isArray(comments) ? comments : []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const c of sorted) {
    if (c.user?.login !== login) continue;
    const body = String(c.body ?? '');
    const d = DISPATCH_RE.exec(body);
    if (d && d[1] === ref && !sessions.includes(d[2])) sessions.push(d[2]);
    const a = ARCHIVED_RE.exec(body);
    if (a && a[1] === ref) archived.add(a[2]);
  }
  return sessions.filter((s) => !archived.has(s));
}

/** config/defaults.json 的 dispatchRoute：执行会话默认用什么跑、备用网关顺序（用户 2026-11-07 定）。 */
export function selectDispatchRoute(path = DEFAULTS_PATH) {
  const route = JSON.parse(readFileSync(path, 'utf8')).dispatchRoute;
  const ok = route && ['agent_kind', 'model', 'effort'].every((k) => typeof route[k] === 'string' && route[k])
    && Array.isArray(route.gateways) && route.gateways.length > 0
    && route.gateways.every((g) => typeof g?.name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(String(g?.agent_device_id ?? '')));
  if (!ok) reject(`config/defaults.json 的 dispatchRoute 不完整（要有 agent_kind、model、effort 和至少一个带 agent_device_id 的网关）`);
  return route;
}

/** 某仓开着的 PR → { "<ref>": [{number, draft}] }，按正文里「任务 issue：<ref>」一行归到子 issue。 */
export function selectOpenTaskPrs(gh, repo) {
  const byRef = {};
  for (let page = 1; page <= OPEN_PR_PAGES; page++) {
    const batch = gh(['api', `repos/${repo}/pulls?state=open&per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) reject(`读 ${repo} 开着的 PR 返回的不是数组（第 ${page} 页）`);
    for (const pr of batch) {
      for (const line of String(pr.body ?? '').split('\n')) {
        const m = /^任务 issue：(\S+#\d+)$/.exec(line.trim());
        if (m) (byRef[m[1]] ??= []).push({ number: pr.number, draft: pr.draft === true });
      }
    }
    if (batch.length < 100) return byRef;
  }
  reject(`${repo} 开着的 PR 超过 ${OPEN_PR_PAGES * 100} 个，无法确认哪些子 issue 已经有 PR`);
}

// status

/** 单个子 issue 的现状。state 只有六种：done / in_progress / dispatchable / needs_decision / waiting / invalid。 */
export function childStatus({ gh, ref, issue, login, openPrs }) {
  const base = { ref, title: issue.title, url: issue.html_url ?? null };
  if (issue.state === 'closed') {
    // PR 合入、子 issue 关闭后，lead 要归档派出过的执行会话（用户 2026-11-07 定）。
    const toArchive = unarchivedSessions(readComments(gh, commentsPath(ref)), ref, login);
    return { ...base, state: 'done', reason: issue.state_reason === 'not_planned' ? '关成不做' : '已关闭', ...(toArchive.length ? { sessions_to_archive: toArchive } : {}) };
  }
  const { repo } = parseIssueRef(ref);
  let deps;
  let questions;
  try {
    assertChildTemplate(issue.body ?? '', ref);
    const sections = splitSections(issue.body ?? '');
    deps = parseDeps(sectionText(sections, '依赖'), repo, ref);
    questions = pendingQuestions(sectionText(sections, '待定问题'));
    // 验收时 check-pr 要按「范围」核对改动、按「验收标准」核对 SC：写不对的现在就拦下，不等做完才发现。
    toScope(sectionText(sections, '范围'), ref);
    toKeelSc(sectionText(sections, '验收标准'), ref);
  } catch (err) {
    return { ...base, state: 'invalid', reason: err.message };
  }
  const prs = openPrs[ref] ?? [];
  const comments = readComments(gh, commentsPath(ref));
  const dispatch = activeDispatch(comments, ref, login);
  const legacy = activeClaims(comments, ref, login);
  if (prs.length || dispatch || legacy.length) {
    return {
      ...base, state: 'in_progress', prs, session: dispatch?.session ?? null,
      reason: legacy.length && !dispatch ? '旧台账的 run 在做（按 references/legacy-ledger-flow.md 收尾）' : prs.length > 1 ? `有 ${prs.length} 个开着的 PR，一个子 issue 只能有一个` : '已派出',
    };
  }
  const blockers = deps.hard.map((d) => depStatus(gh, d)).filter((s) => !s.ok);
  if (blockers.length) {
    const dropped = blockers.filter((b) => b.reason === 'not_planned').map((b) => b.ref);
    return {
      ...base, state: 'waiting', waiting_on: blockers.map((b) => b.ref),
      reason: dropped.length ? `依赖 ${dropped.join('、')} 被关成不做，要用户决定` : `等 ${blockers.map((b) => b.ref).join('、')} 合进去`,
    };
  }
  if (questions.length) return { ...base, state: 'needs_decision', questions, reason: '待定问题还没写「已定」，派出去会卡住' };
  return { ...base, state: 'dispatchable', reason: '依赖都已合入，可以开工' };
}

export function batchStatus({ gh, issueRef }) {
  const { root, children } = readRoot(gh, issueRef);
  if (!children.length && /^\[总\]/.test(root.issue.title ?? '')) reject(`${root.ref} 是总 issue 却没有挂子 issue：先「开 issue」把子 issue 挂上`);
  const sources = children.length ? children : [{ repo: root.repo, issue: root.issue }];
  const login = ghLogin(gh);
  const openByRepo = {};
  const items = sources.map(({ repo, issue }) => {
    openByRepo[repo] ??= selectOpenTaskPrs(gh, repo);
    return childStatus({ gh, ref: `${repo}#${issue.number}`, issue, login, openPrs: openByRepo[repo] });
  });
  const count = (s) => items.filter((i) => i.state === s).length;
  return {
    ok: true,
    root: root.ref,
    kind: children.length ? 'parent' : 'single',
    items,
    dispatchable: items.filter((i) => i.state === 'dispatchable').map((i) => i.ref),
    to_archive: items.flatMap((i) => (i.sessions_to_archive ?? []).map((session) => ({ ref: i.ref, session }))),
    all_done: items.every((i) => i.state === 'done'),
    summary: Object.fromEntries(['done', 'in_progress', 'dispatchable', 'needs_decision', 'waiting', 'invalid'].map((s) => [s, count(s)])),
  };
}

// brief

/** 开工消息正文：执行会话只靠这条消息开工，要写全红线、做法和给 lead 发消息的三种格式。 */
export function toOwnerMessage({ ref, title, url, lead, openPr = null, urgent = false }) {
  return [
    `批准执行开工：${ref}「${title}」`,
    ...(url ? [url] : []),
    '',
    '你负责把这个子 issue 做成一个 PR，并推到正式 PR（Ready for review）。这是红线：PR 还是 Draft 就不算做完；CI 红了就修到绿。一个子 issue 只对应这一个 PR、这一个会话：不另开第二个 PR。',
    ...(openPr ? ['', `接手：这个子 issue 已经有开着的 PR #${openPr}（上一个会话没做完）。在它的分支上接着做，不开新 PR。`] : []),
    '',
    '做法：不走 KEEL，直接用 git + gh。完整步骤读 `~/.claude/skills/approve-exec/references/owner-protocol.md`，要点：',
    '1. 先读子 issue 全文、「参考」里的文件、目标仓的 AGENTS.md / CLAUDE.md 和 PR 模板。只改「范围」里的文件，不做「不做」里的事。',
    `2. 从最新的目标分支开分支，尽早开 Draft PR（正文按任务 issue 范式，写一行「任务 issue：${ref}」）。开出后用 cindy_helper 的 \`set_current_session_title\` 在标题前补 \`#<PR号>-\`。`,
    '3. 写代码，按目标仓规则测试，分批提交、推送。界面有变化就在 PR 里附截图或 HTML demo。',
    '4. 等 CI 时不结束本轮：反复跑 `timeout 540 gh pr checks <PR号> --watch --fail-fast`，直到出结果；红了就修，修完再等。',
    '5. Draft PR 当前 head 的 CI 全绿后，给 lead 发「待验收」，然后结束本轮，等 lead 回复。',
    '6. lead 回「要改」：改完回到第 4 步。lead 回「通过」：跑 PR 正文的 ready 检查，`gh pr ready <PR号>` 转正式，确认 CI 仍全绿，给 lead 发「已转正式」。到这里任务完成。',
    '',
    `给 lead 发消息：用 cindy_helper 的 \`send_to_session\`，\`target_session_id\` 填 \`${lead}\`。只在三种时候发，消息第一行固定写：`,
    `- \`批准执行待验收 ${ref} PR #<号> head <40 位 sha>\``,
    `- \`批准执行已转正式 ${ref} PR #<号>\``,
    `- \`批准执行卡住 ${ref}\`：缺权限、缺环境，或范围、验收标准必须改才能做完。下一行写原因和需要谁做什么。`,
    '',
    '其他时候不发消息，也不问用户。拿不准的选择问 Jev（`ghost_call` 的 `ghost_id=keel`、`tool=jev`），把结论写回子 issue。',
    '不合并 PR，不 force push 主分支，不改子 issue 的范围和验收标准。',
    ...(urgent ? ['', '这是加急任务：你转正式、发完「已转正式」就收工，之后由 lead 安排单审和 e2e，通过后直接合并。'] : []),
  ].join('\n');
}

export function brief({ gh, itemRef, lead, repoDir, project, name, urgent = false, gateway, route = selectDispatchRoute(), now = nowIso() }) {
  if (!SESSION_RE.test(String(lead ?? ''))) reject(`--lead 要填 lead 会话 id（get_current_session_id 的 session_id），当前：${lead}`);
  if (!isAbsolute(String(repoDir ?? ''))) reject(`--repo-dir 要填目标仓主目录的绝对路径，当前：${repoDir}`);
  if (!project) reject('--project 要填目标仓对应的 Cindy 项目路径（先 list_projects 查，没有就 create_project）');
  const { repo, number, ref } = parseIssueRef(itemRef);
  const issue = readIssue(gh, repo, number);
  if (issue.state === 'closed') reject(`${ref} 已关闭，不用再派`);
  const prs = selectOpenTaskPrs(gh, repo)[ref] ?? [];
  if (prs.length > 1) reject(`${ref} 有 ${prs.length} 个开着的 PR（${prs.map((p) => `#${p.number}`).join('、')}）：一个子 issue 只能有一个 PR，先关掉多余的再派`);
  const openPr = prs[0]?.number ?? null;
  let deviceId = null;
  if (gateway !== undefined) {
    const hit = route.gateways.find((g) => g.name === gateway);
    if (!hit) reject(`--gateway 只能是 ${route.gateways.map((g) => g.name).join(' / ')}（当前：${gateway}）`);
    deviceId = hit.agent_device_id;
  }
  const title = sessionTitle({ ref, title: issue.title }, now, { pr: openPr, ...(name ? { name } : {}) });
  return {
    ok: true,
    ref,
    open_pr: openPr,
    request: {
      title,
      message: toOwnerMessage({ ref, title: issue.title, url: issue.html_url ?? null, lead, openPr, urgent }),
      working_dir: repoDir,
      project_path: project,
      use_worktree: true,
      agent_kind: route.agent_kind,
      model: route.model,
      effort: route.effort,
      ...(deviceId ? { agent_device_id: deviceId } : {}),
    },
    gateways: route.gateways.map((g) => g.name),
  };
}

// claim / release

export function claim({ gh, itemRef, session, title, now = nowIso() }) {
  const { ref } = parseIssueRef(itemRef);
  if (!SESSION_RE.test(String(session ?? ''))) reject(`--session 要填 send_to_session 返回的 target_session_id，当前：${session}`);
  if (!title) reject('--title 要填派出会话的标题');
  const login = ghLogin(gh);
  const comments = readComments(gh, commentsPath(ref));
  const current = activeDispatch(comments, ref, login);
  if (current) reject(`${ref} 已派给会话 ${current.session}（${current.url ?? '子 issue 评论'}）：同一子 issue 只能有一个会话。确认那个会话已不在后，先 release 再派`);
  if (activeClaims(comments, ref, login).length) reject(`${ref} 还在旧台账的 run 里：按 references/legacy-ledger-flow.md 处理，不重复派`);
  const posted = gh(['api', '-X', 'POST', commentsPath(ref), '-f', `body=批准执行派发：${dateOf(now)} ${ref} → 会话 ${session}（${title}）`]);
  return { ok: true, ref, session, comment_url: posted?.html_url ?? null };
}

export function release({ gh, itemRef, reason, now = nowIso() }) {
  const { ref } = parseIssueRef(itemRef);
  if (!String(reason ?? '').trim()) reject('--reason 要写为什么撤回（例如：会话已删除，list_sessions 查不到）');
  const login = ghLogin(gh);
  const current = activeDispatch(readComments(gh, commentsPath(ref)), ref, login);
  if (!current) reject(`${ref} 没有有效的派发记录，不用撤回`);
  const posted = gh(['api', '-X', 'POST', commentsPath(ref), '-f', `body=批准执行撤回：${dateOf(now)} ${ref}：${String(reason).trim()}`]);
  return { ok: true, ref, released_session: current.session, comment_url: posted?.html_url ?? null };
}

export function archived({ gh, itemRef, session, now = nowIso() }) {
  const { ref } = parseIssueRef(itemRef);
  if (!SESSION_RE.test(String(session ?? ''))) reject(`--session 要填已归档的执行会话 id，当前：${session}`);
  const login = ghLogin(gh);
  if (!unarchivedSessions(readComments(gh, commentsPath(ref)), ref, login).includes(session)) {
    reject(`${ref} 没有待归档的会话 ${session}（没派过，或已经记过归档）`);
  }
  const posted = gh(['api', '-X', 'POST', commentsPath(ref), '-f', `body=批准执行归档：${dateOf(now)} ${ref} 会话 ${session}`]);
  return { ok: true, ref, session, comment_url: posted?.html_url ?? null };
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd] = args._;
  const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
  const now = typeof args.now === 'string' ? args.now : nowIso();
  try {
    let out;
    if (cmd === 'status') out = batchStatus({ gh, issueRef: args.issue });
    else if (cmd === 'brief') out = brief({ gh, itemRef: args.item, lead: args.lead, repoDir: args['repo-dir'], project: args.project, name: args.name, urgent: args.urgent === true, ...(typeof args.gateway === 'string' ? { gateway: args.gateway } : {}), now });
    else if (cmd === 'claim') out = claim({ gh, itemRef: args.item, session: args.session, title: args.title, now });
    else if (cmd === 'release') out = release({ gh, itemRef: args.item, reason: args.reason, now });
    else if (cmd === 'archived') out = archived({ gh, itemRef: args.item, session: args.session, now });
    else reject(`子命令只能是 status / brief / claim / release / archived（当前：${cmd ?? '空'}）`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
