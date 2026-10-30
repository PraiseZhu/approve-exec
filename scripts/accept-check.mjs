#!/usr/bin/env node
// accept-check.mjs — lead 验收前的确定性检查（PraiseZhu/approve-exec#69 SC4）。只读 GitHub 与台账，不改任何东西。
// 判「通过」之前先跑 --stage acceptance（PR 必须还是 Draft，#77）；owner 转 Ready 后跑 --stage ready 再清理。
//
// CLI: node scripts/accept-check.mjs --ledger <ledger.json> --item <owner/repo#号> [--stage acceptance|ready]
//        [--out <结果.json>] [--gh-fixture <夹具>]
// 输出：一行 JSON {ok, stage, ref, pr, head, checks:[{name, ok, detail}], checked_at}；全部通过 exit 0，否则 exit 2。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isMain, nowIso, parseArgs, readJson, writeJsonAtomic } from './lib/common.mjs';
import { ghRunner, readIssue, parseIssueRef, splitSections, pendingQuestions } from './issue-plan.mjs';

export const STAGES = ['acceptance', 'ready'];
const MAX_FILE_PAGES = 30; // GitHub 的 PR 文件列表最多 3000 条

// scope matching: 与 KEEL src/main/graph/scope.ts 同口径，lead 验收和 KEEL 写域判断不会各说各话。

function globToRegExp(pattern) {
  const escaped = pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*\*\//g, '\0').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?');
  return new RegExp(`^${body}$`);
}

export function matchScopeGlob(file, pattern) {
  const f = file.replace(/^\.\//, '');
  const p = pattern.replace(/\\/g, '/');
  if (p.endsWith('/')) return f === p.slice(0, -1) || f.startsWith(p);
  if (p.endsWith('/**')) {
    const root = p.slice(0, -3);
    return f === root || f.startsWith(`${root}/`);
  }
  return globToRegExp(p).test(f);
}

export function outOfScope(files, scope) {
  return files.filter((f) => !(f === 'node_modules' || f.startsWith('node_modules/')) && !scope.some((g) => matchScopeGlob(f, g)));
}

// github

/** `gh pr checks` 在有失败或进行中时退出码非 0，没有必需检查时退出码 1 且只打印一句话；这里都要拿到原样结果。 */
export function ghChecksRunner(fixturePath) {
  if (fixturePath) {
    return (args) => {
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const key = args.join(' ');
      if (!Object.hasOwn(fixture, key)) throw new Error(`gh 夹具缺少: ${key}`);
      return fixture[key];
    };
  }
  return (args) => {
    try {
      return { status: 0, stdout: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
    }
  };
}

function parseChecks(res) {
  const r = Array.isArray(res) ? { status: 0, stdout: JSON.stringify(res) } : res;
  const text = String(r?.stdout ?? '').trim();
  if (!text.startsWith('[')) return { none: /no required checks reported/i.test(`${text} ${r?.stderr ?? ''}`), list: [] };
  return { none: false, list: JSON.parse(text) };
}

/** 有必需检查就只看必需检查；仓库没设必需检查时看全部检查；一项检查都没有判失败。 */
export function ciVerdict(checks, repo, pr) {
  const requiredRes = checks(['pr', 'checks', String(pr), '--repo', repo, '--required', '--json', 'name,bucket']);
  const required = parseChecks(requiredRes);
  let list = required.list;
  let basis = 'required';
  if (list.length === 0 && !required.none) {
    const why = String(requiredRes?.stderr ?? requiredRes?.stdout ?? '').trim().split('\n')[0] || '没有输出';
    return { ok: false, detail: `读不到必需检查（${why}），无法确认 CI 全绿` };
  }
  if (list.length === 0) {
    list = parseChecks(checks(['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,bucket'])).list;
    basis = 'all';
  }
  if (list.length === 0) return { ok: false, detail: '这个 PR 上没有任何检查，无法确认 CI 全绿' };
  const bad = list.filter((c) => !['pass', 'skipping'].includes(c.bucket));
  return bad.length
    ? { ok: false, detail: `${basis === 'required' ? '必需' : '全部'}检查未全绿：${bad.map((c) => `${c.name}=${c.bucket}`).join('、')}` }
    : { ok: true, detail: `${basis === 'required' ? '必需' : '全部（仓库未设必需检查）'}检查 ${list.length} 项全绿` };
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

/** PR 正文「验收对照」一节（到下一个标题为止）的表格里出现过的 SC 编号。 */
export function scRowsInBody(body) {
  const ids = new Set();
  let inSection = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) { inSection = /^#{1,6}\s*验收对照\s*$/.test(line.trim()); continue; }
    if (!inSection) continue;
    const m = /^\s*\|\s*(?:\*\*)?(SC\d+)\b/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// check

export function acceptCheck({ ledger, plan, ref, stage = 'acceptance', gh, checks, now = nowIso() }) {
  if (!STAGES.includes(stage)) throw new Error(`--stage 只能是 ${STAGES.join(' / ')}`);
  const item = ledger.items[ref];
  if (!item) throw new Error(`台账里没有 ${ref}`);
  const cp = item.checkpoint;
  if (!cp?.pr || !cp?.head) throw new Error(`${ref} 还没有 owner 的 awaiting_acceptance checkpoint`);
  const planItem = plan.items.find((i) => i.ref === ref);
  if (!planItem) throw new Error(`计划里没有 ${ref}`);
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });

  const pr = gh(['api', `repos/${item.repo}/pulls/${cp.pr}`]);
  add('pr_head', pr?.head?.sha === cp.head, `PR head ${pr?.head?.sha ?? '未知'}，checkpoint head ${cp.head}`);
  // ready 档收尾时 PR 已合并也算过（用户在 lead 收尾前合了，#78）；关了没合仍不过。验收档必须还开着。
  const merged = stage === 'ready' && pr?.merged === true;
  add('pr_open', pr?.state === 'open' || merged, merged ? 'PR 已合并' : `PR 状态 ${pr?.state ?? '未知'}`);
  // 所有车道都先开 Draft、lead 判通过后才转正式（#77）：验收时已经是正式的，说明没等 lead 就转了。
  if (stage === 'acceptance') add('pr_draft', pr?.draft === true, pr?.draft === true ? 'PR 还是 Draft' : 'PR 已不是 Draft：lead 判通过之前不该转正式');
  if (stage === 'ready') add('pr_not_draft', pr?.draft === false, pr?.draft ? 'PR 还是 Draft' : 'PR 已是正式 Ready');

  const ci = ciVerdict(checks, item.repo, cp.pr);
  add('ci', ci.ok, ci.detail);

  const outside = outOfScope(prFiles(gh, item.repo, cp.pr), planItem.keel_run.scope);
  add('scope', outside.length === 0, outside.length ? `超出子 issue 范围：${outside.join('、')}` : '改动文件都在子 issue 范围内');

  const body = String(pr?.body ?? '');
  add('body_issue_line', body.split('\n').some((l) => l.trim() === `任务 issue：${ref}`), `PR 正文${body.includes(`任务 issue：${ref}`) ? '有' : '缺'}「任务 issue：${ref}」一行`);
  const { repo, number } = parseIssueRef(ref);
  const issue = readIssue(gh, repo, number);
  const sections = splitSections(issue.body ?? '');
  const scIds = [...planItem.keel_run.sc.map((s) => s.id), ...planItem.manual_scs.map((s) => s.id)];
  const rows = scRowsInBody(body);
  const missingRows = scIds.filter((id) => !rows.has(id));
  add('body_sc_rows', missingRows.length === 0, missingRows.length ? `PR 正文「验收对照」缺 ${missingRows.join('、')}` : `「验收对照」覆盖 ${scIds.length} 条 SC`);

  const pendingText = sections.find((s) => s.heading.startsWith('待定问题'))?.lines.join('\n') ?? '';
  const open = pendingQuestions(pendingText);
  add('pending_questions', open.length === 0, open.length ? `子 issue 还有没写「已定」的待定问题：${open.join('；')}` : '待定问题都已写回结论');

  return { ok: out.every((c) => c.ok), stage, ref, pr: cp.pr, head: cp.head, checks: out, checked_at: now };
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixture = typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null;
  try {
    const ledger = readJson(String(args.ledger));
    const plan = readJson(ledger.plan.path);
    const res = acceptCheck({
      ledger, plan, ref: String(args.item), stage: typeof args.stage === 'string' ? args.stage : 'acceptance',
      gh: ghRunner(fixture), checks: ghChecksRunner(fixture), now: typeof args.now === 'string' ? args.now : nowIso(),
    });
    if (typeof args.out === 'string') writeJsonAtomic(args.out, res);
    process.stdout.write(JSON.stringify(res) + '\n');
    return res.ok ? 0 : 2;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
