#!/usr/bin/env node
// batch.mjs — 批准执行（2026-11-07 改版：不走 KEEL、不建台账、不挂定时任务）。
// lead 用它看总 issue 下每个子 issue 走到哪一步、这一批能派哪些，生成开工消息，并在子 issue 上记派发 / 撤回防重派。
// 状态全部从 GitHub 现读：子 issue 与依赖 issue 的开关、正文写着「任务 issue：<ref>」的开着的 PR、子 issue 评论里的派发记录。
//
// CLI:
//   node scripts/batch.mjs status  --issue <owner/repo#号>
//   node scripts/batch.mjs brief   --item <子 issue> --root <入口 issue> --lead <lead 会话 id> --repo-dir <目标仓主目录> --project <Cindy 项目路径>
//                                  [--name <人话任务名>] [--urgent] [--gateway <网关名>]
//   node scripts/batch.mjs archived --item <子 issue> --session <已归档的执行会话 id>
//   node scripts/batch.mjs claim   --item <子 issue> --session <派出的会话 id> --title <会话标题>
//   node scripts/batch.mjs release --item <子 issue> --reason <原因>
//   node scripts/batch.mjs notify  --pr <Mivo PR> --lead-address <deviceId>::<lead 会话 id> [--partner <partner.json>]
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>（测试用，代替 gh）]
// 输出：stdout 一行 JSON；exit 0 成功 / 2 拒绝（stderr 写原因）。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, nowIso, parseArgs } from './lib/common.mjs';
import {
  assertChildTemplate, ghRunner, parseDeps, parseHeader, parseIssueRef, pendingQuestions, readIssue, readRoot, sectionText, splitSections, toKeelSc, toScope,
} from './issue-plan.mjs';
import { activeClaims, ghLogin, readComments, sessionTitle } from './issue-run.mjs';

export class BatchError extends Error {}
const reject = (msg) => { throw new BatchError(msg); };

// 新派发记录的评论首行。不用「批准执行登记：」开头：验收机看到总 issue 上有登记评论会等 lead 交接（vigil#140），新流程没有这一步。
const DISPATCH_RE = /^批准执行派发：\S+ (\S+#\d+) → 会话 ([\w-]+)/;
const WITHDRAW_RE = /^批准执行撤回：\S+ (\S+#\d+)/;
const ARCHIVED_RE = /^批准执行归档：\S+ (\S+#\d+) 会话 ([\w-]+)/;
const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../config/defaults.json');
const SESSION_RE = /^[\w-]+$/;
const OPEN_PR_PAGES = 10;
const MIVO_REPO = 'xindong/mivo-canvas-plugin';
const ADDRESS_RE = /^[0-9a-f]{64}::[\w-]+$/;
const PARTNER_PATH = join(homedir(), '.claude/skills/pr-merge/partner.json');

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

/**
 * 依赖满足 = 依赖 issue 已关闭、不是「不做」，并且没有写着「任务 issue：<依赖>」的开着的 PR（astra 审查 #2：
 * 只关 issue、PR 还开着不算合入）。
 */
export function selectDepStatus(gh, depRef, openPrsFor) {
  const { repo, number, ref } = parseIssueRef(depRef);
  const issue = readIssue(gh, repo, number);
  if (issue.state !== 'closed') return { ref, ok: false, reason: 'open' };
  if (issue.state_reason === 'not_planned') return { ref, ok: false, reason: 'not_planned' };
  if ((openPrsFor(repo)[ref] ?? []).length) return { ref, ok: false, reason: 'open_pr' };
  return { ref, ok: true };
}

export const STATES = ['done', 'in_progress', 'needs_owner', 'dispatchable', 'needs_decision', 'waiting', 'invalid'];

/** 单个子 issue 的现状。state 只有七种，见 STATES。openPrsFor(repo) 返回那个仓「任务 issue」→ 开着的 PR。 */
export function childStatus({ gh, ref, issue, login, openPrsFor }) {
  const base = { ref, title: issue.title, url: issue.html_url ?? null };
  const { repo } = parseIssueRef(ref);
  const prs = openPrsFor(repo)[ref] ?? [];
  if (issue.state === 'closed') {
    // issue 关了但 PR 还开着：不算合入，不放行依赖、不归档会话（astra 审查 #2）。
    if (prs.length) {
      return { ...base, state: 'needs_decision', prs, reason: `issue 已关闭，但 PR ${prs.map((p) => `#${p.number}`).join('、')} 还开着：先核实是合了还是不做了，再重开 issue 或关掉 PR` };
    }
    // PR 合入、子 issue 关闭后，lead 要归档派出过的执行会话（用户 2026-11-07 定）。
    const toArchive = unarchivedSessions(readComments(gh, commentsPath(ref)), ref, login);
    return { ...base, state: 'done', reason: issue.state_reason === 'not_planned' ? '关成不做' : '已关闭', ...(toArchive.length ? { sessions_to_archive: toArchive } : {}) };
  }
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
  const comments = readComments(gh, commentsPath(ref));
  const dispatch = activeDispatch(comments, ref, login);
  const legacy = activeClaims(comments, ref, login);
  if (dispatch || legacy.length) {
    return {
      ...base, state: 'in_progress', prs, session: dispatch?.session ?? null,
      reason: legacy.length && !dispatch ? '旧台账的 run 在做（按 references/legacy-ledger-flow.md 收尾）' : prs.length > 1 ? `有 ${prs.length} 个开着的 PR，一个子 issue 只能有一个` : '已派出',
    };
  }
  // 只剩 PR、没有有效的派发记录（会话失联后撤回过，或别处开的 PR）：要人接手，不能当成有人在做（astra 审查 #1）。
  if (prs.length) {
    return {
      ...base, state: 'needs_owner', prs, session: null,
      reason: prs.length > 1 ? `有 ${prs.length} 个开着的 PR、没有执行会话：先关掉多余的 PR` : `PR #${prs[0].number} 开着，但没有在做的执行会话：核实实际负责人，确认没人就用 brief 接手这个 PR`,
    };
  }
  const blockers = deps.hard.map((d) => selectDepStatus(gh, d, openPrsFor)).filter((d) => !d.ok);
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
  const openByRepo = new Map();
  const openPrsFor = (repo) => {
    const key = repo.toLowerCase();
    if (!openByRepo.has(key)) openByRepo.set(key, selectOpenTaskPrs(gh, repo));
    return openByRepo.get(key);
  };
  const items = sources.map(({ repo, issue }) => childStatus({ gh, ref: `${repo}#${issue.number}`, issue, login, openPrsFor }));
  const count = (s) => items.filter((i) => i.state === s).length;
  return {
    ok: true,
    root: root.ref,
    kind: children.length ? 'parent' : 'single',
    items,
    dispatchable: items.filter((i) => i.state === 'dispatchable').map((i) => i.ref),
    needs_owner: items.filter((i) => i.state === 'needs_owner').map((i) => i.ref),
    to_archive: items.flatMap((i) => (i.sessions_to_archive ?? []).map((session) => ({ ref: i.ref, session }))),
    // lead 把自己派出的会话开的 PR 都挂到自己会话顶上（用户 2026-11-07 定）；重复 attach 无副作用。
    to_attach: items.filter((i) => ['in_progress', 'needs_owner'].includes(i.state))
      .flatMap((i) => (i.prs ?? []).map((pr) => ({ repo: parseIssueRef(i.ref).repo, number: pr.number }))),
    all_done: items.every((i) => i.state === 'done'),
    summary: Object.fromEntries(STATES.map((s) => [s, count(s)])),
  };
}

// brief

/** 开工消息正文：执行会话只靠这条消息开工，要写全红线、做法和给 lead 发消息的三种格式。 */
export function toOwnerMessage({ ref, title, url, lead, parent = null, openPr = null, urgent = false }) {
  return [
    `批准执行开工：${ref}「${title}」`,
    ...(url ? [url] : []),
    '',
    '你负责把这个子 issue 做成一个 PR，并推到正式 PR（Ready for review）。这是红线：PR 还是 Draft 就不算做完；CI 红了就修到绿。一个子 issue 只对应这一个 PR、这一个会话：不另开第二个 PR。',
    ...(parent ? ['', `总 issue：${parent}。开工前先读它的目标与背景、已定决策、并行/串行原则和相邻子 issue，弄清这个子 issue 在整体里要达成什么；总 issue 和子 issue 说法冲突时按子 issue 做，并发「卡住」说明。`] : []),
    ...(openPr ? ['', `接手：这个子 issue 已经有开着的 PR #${openPr}（上一个会话没做完）。接着这个 PR 做，不开新 PR。`] : []),
    '',
    '做法：不走 KEEL，直接用 git + gh。完整步骤读 `~/.claude/skills/approve-exec/references/owner-protocol.md`，要点：',
    '1. 先读子 issue 全文、「参考」里的文件、目标仓的 AGENTS.md / CLAUDE.md 和 PR 模板，以及它们指向的 PR 门禁规则（如 docs/dev-rules/ 下的文件）；PR 正文要逐项满足这些门禁。只改「范围」里的文件，不做「不做」里的事。',
    `2. 分支：Cindy 已经给你建好工作树和托管分支（cindy/<名>），就在这个分支上工作，不要 git checkout -b 另开分支（换分支会让工作树回收不了）。没有提交前先对齐最新目标分支：git fetch origin 后 git reset --hard origin/<目标分支>（子 issue 首行写了「PR 指向」就用它，否则 main）。${openPr ? `接手时改成对齐 PR 分支：git reset --hard origin/<PR #${openPr} 的分支>。` : ''}推送一律 git push origin HEAD:<PR 分支名>。尽早开 Draft PR（正文按任务 issue 范式，写一行「任务 issue：${ref}」）。开出后马上做两件事：用 cindy_helper 的 \`manage_session_prs\`（action=attach，pr 填 {repo, number}，不传 session_id）把这个 PR 挂到本会话顶上；用 \`set_current_session_title\` 在标题前补 \`#<PR号>-\`，其余命名不变（\`#<PR号>-<人话任务名>丨<MMDD>\`）。`,
    '3. 写代码，按目标仓规则测试，分批提交、推送。PR 正文里每条「已验证」都写实际跑的命令和退出码（例：`pnpm test → exit 0`），只写「通过」不算；没跑过的写进「未执行的验证」。界面有变化就在 PR 里附截图或 HTML demo。目标仓规定每个 PR 必须附的交接文件（如 Mivo 的 docs/pr/<PR号>/review.md、qa.md）按仓库要求写，不算越界。',
    '4. 等 CI 时不结束本轮：反复跑 `timeout 540 gh pr checks <PR号> --watch --fail-fast`，直到全部检查跑完；红了就修，修完再等。「CI 全绿」指当前 head 的全部检查都跑完且通过（skipping 算通过），不只是必需检查。',
    `5. CI 全绿后，先把 PR 正文「验收对照」每条 SC 的状态和证据填好，跑 \`check-pr-body.sh --stage ready <owner/repo#PR号> ${ref}\` 通过（人工手测项在「未执行的验证」写清谁验、何时验），再给 lead 发「待验收」，然后结束本轮，等 lead 回复。`,
    '6. lead 回「要改」：改完回到第 4 步。lead 回「通过」：`gh pr ready <PR号>` 转正式，确认 CI 仍全绿，给 lead 发「已转正式」。到这里任务完成。转正式后 lead 又回「要改」（正式档复核没过）：修完、CI 全绿后再发「已转正式」，不要再发「待验收」；Mivo 仓转正式后的 CI 和审查问题归盯梢，不由你改。',
    '',
    `给 lead 发消息：用 cindy_helper 的 \`send_to_session\`，\`target_session_id\` 填 \`${lead}\`。只在三种时候发，消息第一行固定写：`,
    `- \`批准执行待验收 ${ref} PR #<号> head <40 位 sha>\``,
    `- \`批准执行已转正式 ${ref} PR #<号>\``,
    `- \`批准执行卡住 ${ref}\`：缺权限、缺环境，或范围、验收标准必须改才能做完。下一行写原因和需要谁做什么。`,
    '',
    '发完看回执：ok 才算送到（wake_kind 是 queued 也算）。DELIVERY_UNKNOWN 先用 get_chat_history 查对方收到没有，没收到再发一次；ARCHIVED、DELETED、NOT_FOUND、AGENT_NOT_READY、HOST_NOT_READY 等送不到的，用 gh 在子 issue 上评论「批准执行未送达：<原消息第一行>（<错误码>）」，再结束本轮。',
    '其他时候不发消息，也不问用户。拿不准的选择问 Jev（`ghost_call` 的 `ghost_id=keel`、`tool=jev`），把结论写回子 issue。',
    '不合并 PR，不 force push 主分支，不改子 issue 的范围和验收标准。',
    ...(urgent ? ['', '这是加急任务：你转正式、发完「已转正式」就收工，之后由 lead 安排单审和 e2e，通过后直接合并。'] : []),
  ].join('\n');
}

export function brief({ gh, itemRef, root, lead, repoDir, project, name, urgent = false, gateway, route = selectDispatchRoute(), now = nowIso() }) {
  if (!SESSION_RE.test(String(lead ?? ''))) reject(`--lead 要填 lead 会话 id（get_current_session_id 的 session_id），当前：${lead}`);
  if (!isAbsolute(String(repoDir ?? ''))) reject(`--repo-dir 要填目标仓主目录的绝对路径，当前：${repoDir}`);
  if (!project) reject('--project 要填目标仓对应的 Cindy 项目路径（先 list_projects 查，没有就 create_project）');
  if (!root) reject('--root 要填本次「批准执行」入口的 issue（总 issue、独立 issue 或单个子 issue）');
  const { repo, number, ref } = parseIssueRef(itemRef);
  // 只派入口 issue 范围内的子 issue（2026-11-07 复盘：lead 把别的 issue 当成「接下来的」派了出去）
  const rootRef = parseIssueRef(root).ref;
  if (rootRef.toLowerCase() !== ref.toLowerCase()) {
    const { children } = readRoot(gh, rootRef);
    if (!children.some((c) => `${c.repo}#${c.issue.number}`.toLowerCase() === ref.toLowerCase())) {
      reject(`${ref} 不是 ${rootRef} 的子 issue：只派本次入口 issue 范围内的子 issue，别的 issue 即使也在你名下也不派`);
    }
  }
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
  const parent = parseHeader(splitSections(issue.body ?? '')).parent;
  return {
    ok: true,
    ref,
    open_pr: openPr,
    request: {
      title,
      message: toOwnerMessage({ ref, title: issue.title, url: issue.html_url ?? null, lead, parent, openPr, urgent }),
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

// notify

/**
 * Mivo PR 转正式后，lead 把自己的跨电脑地址登记给合并伙伴（PraiseZhu/approve-exec#97）。
 * 本人 Mivo PR 正文写了「合并顺序」就由伙伴自动合入，没有「合并」请求带 notify_session；不登记，伙伴合入后不知道叫醒谁。
 * 只读 GitHub 和 partner.json，不发消息：lead 把 message 用 send_to_session 发给 target_session_id。
 */
export function notify({ gh, prRef, leadAddress, partnerPath = PARTNER_PATH, now = nowIso() }) {
  const { repo, number, ref } = parseIssueRef(prRef);
  if (repo.toLowerCase() !== MIVO_REPO) reject(`只有 Mivo（${MIVO_REPO}）的 PR 要登记合入通知，当前：${ref}`);
  if (!ADDRESS_RE.test(String(leadAddress ?? ''))) reject(`--lead-address 要填 <deviceId>::<lead 会话 id>（deviceId 取 list_machines 里 isSelf 那台），当前：${leadAddress}`);
  const pr = gh(['api', `repos/${repo}/pulls/${number}`]);
  if (pr?.merged_at) return { ok: true, ref, already_merged: true };
  if (pr?.state !== 'open') reject(`${ref} 已关闭且没合入（state=${pr?.state}），不登记`);
  let partner;
  try {
    partner = JSON.parse(readFileSync(partnerPath, 'utf8'));
  } catch (err) {
    reject(`读不到合并伙伴地址 ${partnerPath}（${err.code ?? err.message}）：伙伴没部署，不登记`);
  }
  if (!ADDRESS_RE.test(String(partner?.session ?? ''))) reject(`${partnerPath} 里的 session 应是 <deviceId>::<会话 id>，当前：${partner?.session}`);
  const registration = { schema: 'praise-merge/notify@1', notify_session: leadAddress, prs: [{ repo: MIVO_REPO, number }], registered_at: now };
  return {
    ok: true,
    ref,
    already_merged: false,
    target_session_id: partner.session,
    message: `praise-merge 通知登记\n\`\`\`json\n${JSON.stringify(registration)}\n\`\`\``,
  };
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
    else if (cmd === 'brief') out = brief({ gh, itemRef: args.item, root: args.root, lead: args.lead, repoDir: args['repo-dir'], project: args.project, name: args.name, urgent: args.urgent === true, ...(typeof args.gateway === 'string' ? { gateway: args.gateway } : {}), now });
    else if (cmd === 'claim') out = claim({ gh, itemRef: args.item, session: args.session, title: args.title, now });
    else if (cmd === 'release') out = release({ gh, itemRef: args.item, reason: args.reason, now });
    else if (cmd === 'archived') out = archived({ gh, itemRef: args.item, session: args.session, now });
    else if (cmd === 'notify') out = notify({ gh, prRef: args.pr, leadAddress: args['lead-address'], ...(typeof args.partner === 'string' ? { partnerPath: args.partner } : {}), now });
    else reject(`子命令只能是 status / brief / claim / release / archived / notify（当前：${cmd ?? '空'}）`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
