#!/usr/bin/env node
// check-pr.mjs — 批准执行（2026-11-07 改版）lead 的确定性检查，不读台账。只读 GitHub。
//   --stage acceptance：执行会话发来「待验收」时跑。PR 必须还是 Draft，当前 head 全部检查跑完且通过，改动在子 issue 范围内，
//                       PR 正文有「任务 issue」一行、「验收对照」覆盖全部 SC，ready 档正文检查通过（每条 SC 有状态和证据），
//                       子 issue 待定问题都已写「已定」。
//   --stage ready：执行会话发来「已转正式」时跑。PR 已不是 Draft（已合并也算过），当前 head 全部检查跑完且通过。
//   --stage recheck：判通过后 PR 又有新提交时跑（v3，#104）。只看判通过的版本到当前版本之间的新增改动：
//                    范围、存量测试有没有被删行、CI。
// 「CI 全绿」两端同一口径：全部检查（不只必需检查）跑完，pass 或 skipping（astra 审查 #7）。
// 检查全过只是必要条件：lead 还要对照子 issue 的「目标」「原因」「不做」看 diff 是否做对了事。
//
// CLI: node scripts/check-pr.mjs --item <owner/repo#号> --pr <PR 号> [--head <40 位 sha>] [--stage acceptance|ready|recheck]
//        [--accepted-head <40 位 sha>（recheck 必填，取自最新的 verdict_pass 事件）]
//        [--gh-fixture <夹具>]
// 输出：一行 JSON {ok, stage, ref, pr, head, checks:[{name, ok, detail}], judgement?:[…]}；全部通过 exit 0，否则 exit 2。
// 范围三档（v3，#106）：在子 issue「范围」里或命中仓库卡 always_allowed 的通过；其余文件在 PR 正文「范围对照」里写了说明的
// 记 needs_judgement（不算不过，交 lead 判断），没写说明的不过。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMain, parseArgs } from './lib/common.mjs';
import { ghRunner, parseDeps, parseHeader, parseIssueRef, pendingQuestions, readIssue, sectionText, splitSections, toKeelSc, toScope } from './issue-plan.mjs';
import { ghLogin, readComments } from './issue-run.mjs';
import { parseEvents } from './event.mjs';
import { selectCharter } from './charter.mjs';
import { readRepoCard, selectAlwaysAllowed } from './lib/repo-card.mjs';
import { ghChecksRunner, outOfScope, scRowsInBody } from './accept-check.mjs';

export const STAGES = ['acceptance', 'ready', 'recheck'];
const SHA_RE = /^[0-9a-f]{40}$/;
const TEST_FILE_RE = /\.test\.[A-Za-z0-9]+$/;
const NON_SOURCE_RES = [/\.test\.[A-Za-z0-9]+$/, /(^|\/)__tests__\//, /\.md$/, /^docs\//];
const MAX_FILE_PAGES = 30; // GitHub 的 PR 文件列表最多 3000 条
const PR_BODY_CHECK = join(homedir(), 'AI-Agent/Claude/capabilities/source/scripts/check-pr-body.sh');

/** 当前 head 的全部检查：一项都没有、还在跑、或有失败都不算绿。skipping 算通过。 */
export function ciAllVerdict(checks, repo, pr) {
  const res = checks(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,bucket']);
  const text = String((Array.isArray(res) ? JSON.stringify(res) : res?.stdout) ?? '').trim();
  const list = text.startsWith('[') ? JSON.parse(text) : [];
  if (list.length === 0) return { ok: false, detail: '这个 PR 上没有任何检查，无法确认 CI 全绿' };
  const pending = list.filter((c) => c.bucket === 'pending').map((c) => c.name);
  const bad = list.filter((c) => !['pass', 'skipping', 'pending'].includes(c.bucket)).map((c) => `${c.name}=${c.bucket}`);
  if (bad.length) return { ok: false, detail: `有检查没过：${bad.join('、')}` };
  if (pending.length) return { ok: false, detail: `还有 ${pending.length} 项检查在跑：${pending.join('、')}` };
  return { ok: true, detail: `全部 ${list.length} 项检查跑完且通过（含 skipping）` };
}

/** ready 档 PR 正文检查（与执行会话转正式前跑的同一脚本）：每条 SC 有状态和证据、人工手测写清谁验何时验。 */
export function runBodyReadyCheck(prRef, issueRef) {
  const res = spawnSync('bash', [PR_BODY_CHECK, '--stage', 'ready', prRef, issueRef], { encoding: 'utf8', timeout: 120_000 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0, detail: out.split('\n').slice(0, 6).join(' ') || `check-pr-body.sh 退出码 ${res.status}` };
}

function prFiles(gh, repo, pr) {
  const files = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = gh(['api', `repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`]);
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) return files;
  }
  throw new Error(`PR #${pr} 改动文件超过 ${MAX_FILE_PAGES * 100} 个，无法完整核对范围`);
}


const commentsPath = (ref) => { const { repo, number } = parseIssueRef(ref); return `repos/${repo}/issues/${number}/comments`; };

/** PR 正文「范围对照」一节里，哪些范围外文件带了说明（那一行除了路径还有至少 4 个非空白字符）。 */
export function selectExplained(body, files) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => /^#{2,4}\s*范围对照/.test(l.trim()));
  if (start < 0) return new Map();
  const endRel = lines.slice(start + 1).findIndex((l) => /^#{2,4}\s/.test(l.trim()));
  const section = lines.slice(start + 1, endRel < 0 ? undefined : start + 1 + endRel);
  const out = new Map();
  for (const f of files) {
    const line = section.find((l) => l.includes(f) && l.replace(f, '').replace(/[\s|`*\-：:]/g, '').length >= 4);
    if (line) out.set(f, line.trim());
  }
  return out;
}

/** 范围三档：返回 {outside（没说明的范围外文件）, judgement（写了说明、交 lead 判断的）}。 */
export function scopeVerdict({ files, scope, repo, pr, body, card }) {
  const allowed = card ? selectAlwaysAllowed(card, pr) : [`docs/pr/${pr}/`];
  const beyond = outOfScope(files, [...scope, ...allowed]);
  const explained = selectExplained(body, beyond);
  return {
    outside: beyond.filter((f) => !explained.has(f)),
    judgement: beyond.filter((f) => explained.has(f)).map((f) => ({ file: f, note: explained.get(f) })),
    repo,
  };
}

/** 章程是否要求这个 PR 预审：all，或 feature 且改了非测试、非文档的源码文件。 */
export function needsPrereview(charter, files) {
  if (!charter || charter.prereview === 'off') return false;
  if (charter.prereview === 'all') return true;
  return files.some((f) => !NON_SOURCE_RES.some((re) => re.test(f)));
}

/** 判通过后的复核（#104）：只看 accepted..head 之间的新增改动。 */
function recheck({ gh, checks, repo, ref, number, pr, acceptedHead, actualHead, card, prBody, add }) {
  if (!SHA_RE.test(String(acceptedHead ?? ''))) throw new Error(`--stage recheck 要带 --accepted-head <40 位 sha>（当前：${acceptedHead}）`);
  if (actualHead === acceptedHead) { add('unchanged', true, `PR 当前版本就是判通过的版本 ${acceptedHead.slice(0, 7)}`); return; }
  let cmp;
  try { cmp = gh(['api', `repos/${repo}/compare/${acceptedHead}...${actualHead}`]); } catch (err) {
    add('compare', false, `验收时的版本已不在分支上，需要整体重新验收（${String(err.message).slice(0, 80)}）`);
    return;
  }
  const changed = Array.isArray(cmp?.files) ? cmp.files : [];
  const issue = readIssue(gh, repo, number);
  const scope = toScope(sectionText(splitSections(issue.body ?? ''), '范围'), ref);
  const sv = scopeVerdict({ files: changed.map((f) => f.filename), scope, repo, pr, body: prBody, card });
  add('scope', sv.outside.length === 0, sv.outside.length ? `判通过后的新增改动超出范围：${sv.outside.join('、')}` : `判通过后的新增改动（${changed.length} 个文件）都在范围内`);
  const touched = changed.filter((f) => TEST_FILE_RE.test(f.filename) && f.status !== 'added' && (f.deletions ?? 0) > 0);
  add('existing_tests', touched.length === 0, touched.length ? `判通过后存量测试被删了行：${touched.map((f) => `${f.filename}（删 ${f.deletions} 行）`).join('、')}` : '判通过后没有删改存量测试');
  const ci = ciAllVerdict(checks, repo, pr);
  add('ci', ci.ok, ci.detail);
  return sv.judgement;
}

export function checkPr({ gh, checks, bodyCheck = runBodyReadyCheck, ref: rawRef, pr, head = null, stage = 'acceptance', acceptedHead = null, cardsDir }) {
  if (!STAGES.includes(stage)) throw new Error(`--stage 只能是 ${STAGES.join(' / ')}（当前：${stage}）`);
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`--pr 要填 PR 号（当前：${pr}）`);
  const { repo, number, ref } = parseIssueRef(rawRef);
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });

  const p = gh(['api', `repos/${repo}/pulls/${pr}`]);
  const actualHead = p?.head?.sha ?? null;
  if (head) add('pr_head', actualHead === head, `PR head ${actualHead ?? '未知'}，消息里的 head ${head}`);
  const card = readRepoCard(repo, cardsDir);
  if (stage === 'recheck') {
    add('pr_open', p?.state === 'open', `PR 状态 ${p?.state ?? '未知'}`);
    const judgement = recheck({ gh, checks, repo, ref, number, pr, acceptedHead, actualHead, card, prBody: String(p?.body ?? ''), add }) ?? [];
    return { ok: out.every((c) => c.ok), stage, ref, pr, head: actualHead, accepted_head: acceptedHead, checks: out, ...(judgement.length ? { judgement } : {}) };
  }
  const merged = stage === 'ready' && p?.merged === true;
  add('pr_open', p?.state === 'open' || merged, merged ? 'PR 已合并' : `PR 状态 ${p?.state ?? '未知'}`);
  if (stage === 'acceptance') add('pr_draft', p?.draft === true, p?.draft === true ? 'PR 还是 Draft' : 'PR 已不是 Draft：lead 判通过之前不该转正式');
  if (stage === 'ready') add('pr_not_draft', p?.draft === false, p?.draft ? 'PR 还是 Draft：还没转正式' : 'PR 已是正式');
  if (!merged) {
    const ci = ciAllVerdict(checks, repo, pr);
    add('ci', ci.ok, ci.detail);
  }
  if (stage === 'ready') return { ok: out.every((c) => c.ok), stage, ref, pr, head: actualHead, checks: out };

  const issue = readIssue(gh, repo, number);
  const sections = splitSections(issue.body ?? '');
  // 范围三档（#106）：子 issue 范围、仓库卡 always_allowed（没有仓库卡的仓固定放行 docs/pr/<PR号>/）、写了说明交 lead 判断。
  const body = String(p?.body ?? '');
  const files = prFiles(gh, repo, pr);
  const sv = scopeVerdict({ files, scope: toScope(sectionText(sections, '范围'), ref), repo, pr, body, card });
  const judged = sv.judgement.length ? `；另有 ${sv.judgement.length} 个范围外文件写了说明，记 needs_judgement 交 lead 判断：${sv.judgement.map((j) => j.file).join('、')}` : '';
  add('scope', sv.outside.length === 0, sv.outside.length ? `超出子 issue 范围且没在 PR 正文「范围对照」说明：${sv.outside.join('、')}${judged}` : `改动文件都在子 issue 范围内${judged}`);

  const hasLine = body.split('\n').some((l) => l.trim() === `任务 issue：${ref}`);
  add('body_issue_line', hasLine, `PR 正文${hasLine ? '有' : '缺'}「任务 issue：${ref}」一行`);
  const { sc, manual } = toKeelSc(sectionText(sections, '验收标准'), ref);
  const scIds = [...sc, ...manual].map((s) => s.id);
  const rows = scRowsInBody(body);
  const missing = scIds.filter((id) => !rows.has(id));
  add('body_sc_rows', missing.length === 0, missing.length ? `PR 正文「验收对照」缺 ${missing.join('、')}` : `「验收对照」覆盖 ${scIds.length} 条 SC`);
  // 只查 SC 编号不够：状态还是「待验证」也会放行（astra 审查 #8）。用执行会话转正式前的同一个脚本复核。
  const bodyReady = bodyCheck(`${repo}#${pr}`, ref);
  add('body_ready', bodyReady.ok, bodyReady.detail);

  const open = pendingQuestions(sectionText(sections, '待定问题'));
  add('pending_questions', open.length === 0, open.length ? `子 issue 还有没写「已定」的待定问题：${open.join('；')}` : '待定问题都已写回结论');


  // 预审（#107）：章程要求时，子 issue 上要有 head 等于当前版本的 prereview 事件。
  const login = ghLogin(gh);
  const parent = parseHeader(sections).parent;
  const charter = parent ? selectCharter(readComments(gh, commentsPath(parent)), login) : null;
  if (needsPrereview(charter, files)) {
    const done = parseEvents(readComments(gh, commentsPath(ref)), login).events.some((e) => e.type === 'prereview' && e.head === actualHead);
    add('prereview', done, done ? '当前版本有预审记录' : '当前版本没有预审记录：按 owner-protocol.md「预审」审完再发待验收');
  } else add('prereview', true, '章程未要求预审');

  // 预开工（#107）：上游子 issue 全部合入（关闭）之前不验收。
  const upstream = parseDeps(sectionText(sections, '依赖'), repo, ref).hard.filter((d) => {
    const dep = parseIssueRef(d);
    return readIssue(gh, dep.repo, dep.number).state !== 'closed';
  });
  add('upstream_merged', upstream.length === 0, upstream.length ? `上游还没合入：${upstream.join('、')}（预开工的 PR 等上游合入、同步目标分支后再发待验收）` : '依赖的子 issue 都已合入');

  return { ok: out.every((c) => c.ok), stage, ref, pr, head: actualHead, checks: out, ...(sv.judgement.length ? { judgement: sv.judgement } : {}) };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixture = typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null;
  try {
    const res = checkPr({
      gh: ghRunner(fixture), checks: ghChecksRunner(fixture), ref: args.item, pr: Number(args.pr),
      head: typeof args.head === 'string' ? args.head : null, stage: typeof args.stage === 'string' ? args.stage : 'acceptance',
      acceptedHead: typeof args['accepted-head'] === 'string' ? args['accepted-head'] : null,
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 2;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
