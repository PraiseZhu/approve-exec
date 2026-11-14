#!/usr/bin/env node
// note.mjs — 批准执行 v3 的运行笔记（PraiseZhu/approve-exec#106）。
// 执行会话做的决定和踩的坑记在总 issue 下，兄弟会话读得到。笔记只是候选经验：进仓库卡要另开 PR。
// 带 --broadcast 的笔记由对账器转成敲门，通知还在开发的兄弟会话；本脚本不发消息。
//
// CLI:
//   node scripts/note.mjs add  --root <总 issue> --from <子 issue> --kind <decision|pitfall> --text <一段话> [--broadcast]
//   node scripts/note.mjs list --root <总 issue> [--since <ISO>]
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>]
// 输出：stdout 一行 JSON；exit 0 成功 / 2 拒绝（stderr 写原因）。
import { isMain, nowIso, parseArgs } from './lib/common.mjs';
import { ghRunner, parseIssueRef } from './issue-plan.mjs';
import { ghLogin, readComments } from './issue-run.mjs';
import { NOTE_MARK_RE } from './lib/reconcile-rules.mjs';

export class NoteError extends Error {}
const reject = (msg) => { throw new NoteError(msg); };

export const NOTE_KINDS = { decision: '决定', pitfall: '坑' };
export const NOTE_TEXT_MAX = 1200;
const commentsPath = (ref) => { const { repo, number } = parseIssueRef(ref); return `repos/${repo}/issues/${number}/comments`; };

export function add({ gh, rootRef, fromRef, kind, text, broadcast = false, now = nowIso() }) {
  const root = parseIssueRef(rootRef).ref;
  const from = parseIssueRef(fromRef).ref;
  if (!Object.hasOwn(NOTE_KINDS, String(kind))) reject(`--kind 只能是 ${Object.keys(NOTE_KINDS).join(' / ')}（当前：${kind ?? '空'}）`);
  const body = String(text ?? '').trim();
  if (!body) reject('--text 要写笔记内容');
  if (body.length > NOTE_TEXT_MAX) reject(`--text 最多 ${NOTE_TEXT_MAX} 个字符（当前：${body.length}）`);
  if (body.includes('-->')) reject('--text 里不能有「-->」');
  const mark = { from, kind, broadcast: broadcast === true, at: now };
  const posted = gh(['api', '-X', 'POST', commentsPath(root), '-f', `body=批准执行笔记：${from} ${NOTE_KINDS[kind]}\n\n${body}\n\n<!-- approve-exec:note v1 ${JSON.stringify(mark)} -->`]);
  return { ok: true, root, ...mark, comment_url: posted?.html_url ?? null };
}

export function list({ gh, rootRef, since = null }) {
  const root = parseIssueRef(rootRef).ref;
  const login = ghLogin(gh);
  const notes = [];
  for (const c of readComments(gh, commentsPath(root))) {
    if (c.user?.login !== login) continue;
    const m = NOTE_MARK_RE.exec(String(c.body ?? ''));
    if (!m) continue;
    let mark;
    try { mark = JSON.parse(m[1]); } catch { continue; }
    if (since && Date.parse(mark.at) < Date.parse(since)) continue;
    const text = String(c.body).split('\n').slice(2).join('\n').replace(NOTE_MARK_RE, '').trim();
    notes.push({ from: mark.from, kind: mark.kind, broadcast: mark.broadcast === true, at: mark.at, text, url: c.html_url ?? null });
  }
  return { ok: true, root, notes };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd] = args._;
  const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
  try {
    let out;
    if (cmd === 'add') out = add({ gh, rootRef: args.root, fromRef: args.from, kind: args.kind, text: args.text, broadcast: args.broadcast === true, now: typeof args.now === 'string' ? args.now : nowIso() });
    else if (cmd === 'list') out = list({ gh, rootRef: args.root, since: typeof args.since === 'string' ? args.since : null });
    else reject(`子命令只能是 add / list（当前：${cmd ?? '空'}）`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
