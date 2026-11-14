#!/usr/bin/env node
// charter.mjs — 批准执行 v3 的运行章程（PraiseZhu/approve-exec#105）。
// 开工时把用户的授权和取舍一次问清，写成总 issue 下一条固定格式的评论。对账器和 lead 只在章程写明的范围内自动做事；
// 没写的照旧问用户。章程不存本地文件。
//
// CLI:
//   node scripts/charter.mjs write --root <总 issue> --json <章程文件>
//   node scripts/charter.mjs read  --root <总 issue>
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>]
// 输出：stdout 一行 JSON；exit 0 成功 / 2 拒绝（stderr 写原因）。
import { readFileSync } from 'node:fs';
import { isMain, nowIso, parseArgs } from './lib/common.mjs';
import { ghRunner, parseIssueRef } from './issue-plan.mjs';
import { ghLogin, readComments } from './issue-run.mjs';

export class CharterError extends Error {}
const reject = (msg) => { throw new CharterError(msg); };

export const CHARTER_SCHEMA = 'approve-exec/charter@1';
export const CHARTER_MARK_RE = /<!-- approve-exec:charter v1 (\{.*?\}) -->/s;
const TOP_KEYS = ['schema', 'merge', 'conflict', 'prereview', 'early_start', 'max_parallel', 'manual_test', 'user_words', 'lead_session'];
const BASES = ['main', 'integration/*'];
const ADDRESS_RE = /^[0-9a-f]{64}::[\w-]+$/;

const commentsPath = (ref) => { const { repo, number } = parseIssueRef(ref); return `repos/${repo}/issues/${number}/comments`; };

// helpers

/** 校验章程；返回规范化后的对象。字段缺失、类型不对、出现清单外的字段都拒绝，消息里写字段名。 */
export function toCharter(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reject('章程要是一个 JSON 对象');
  const unknown = Object.keys(raw).filter((k) => !TOP_KEYS.includes(k));
  if (unknown.length) reject(`章程里有清单外的字段：${unknown.join('、')}（允许：${TOP_KEYS.join('、')}）`);
  if (raw.schema !== undefined && raw.schema !== CHARTER_SCHEMA) reject(`schema 要是 ${CHARTER_SCHEMA}（当前：${raw.schema}）`);
  const merge = raw.merge;
  if (!merge || typeof merge !== 'object' || Array.isArray(merge)) reject('merge 要是对象 {auto_request, bases}');
  const mergeUnknown = Object.keys(merge).filter((k) => !['auto_request', 'bases'].includes(k));
  if (mergeUnknown.length) reject(`merge 里有清单外的字段：${mergeUnknown.join('、')}`);
  if (typeof merge.auto_request !== 'boolean') reject(`merge.auto_request 要是 true 或 false（当前：${merge.auto_request}）`);
  if (!Array.isArray(merge.bases) || merge.bases.some((b) => !BASES.includes(b))) reject(`merge.bases 只能含 ${BASES.join('、')}（当前：${JSON.stringify(merge.bases)}）`);
  const conflict = raw.conflict;
  if (!conflict || typeof conflict !== 'object' || !['serial', 'parallel'].includes(conflict.same_file)) reject(`conflict.same_file 只能是 serial 或 parallel（当前：${conflict?.same_file}）`);
  if (Object.keys(conflict).some((k) => k !== 'same_file')) reject('conflict 里只能有 same_file');
  if (!['feature', 'all', 'off'].includes(raw.prereview)) reject(`prereview 只能是 feature / all / off（当前：${raw.prereview}）`);
  if (typeof raw.early_start !== 'boolean') reject(`early_start 要是 true 或 false（当前：${raw.early_start}）`);
  if (!Number.isInteger(raw.max_parallel) || raw.max_parallel < 1 || raw.max_parallel > 12) reject(`max_parallel 要是 1–12 的整数（当前：${raw.max_parallel}）`);
  if (typeof raw.manual_test !== 'string' || !raw.manual_test.trim()) reject('manual_test 要写一句话：谁做实机手测');
  if (typeof raw.user_words !== 'string' || !raw.user_words.trim()) reject('user_words 要原样写用户授权的原话');
  if (!ADDRESS_RE.test(String(raw.lead_session ?? ''))) reject(`lead_session 要是 <deviceId>::<会话 id>（当前：${raw.lead_session}）`);
  for (const k of ['manual_test', 'user_words']) if (raw[k].includes('-->')) reject(`${k} 里不能有「-->」`);
  return {
    schema: CHARTER_SCHEMA,
    merge: { auto_request: merge.auto_request, bases: [...merge.bases] },
    conflict: { same_file: conflict.same_file },
    prereview: raw.prereview,
    early_start: raw.early_start,
    max_parallel: raw.max_parallel,
    manual_test: raw.manual_test.trim(),
    user_words: raw.user_words,
    lead_session: raw.lead_session,
  };
}

/** 评论 → 最新一条合法章程（只认 login 本人发的）。没有返回 null。 */
export function selectCharter(comments, login) {
  let latest = null;
  const sorted = (Array.isArray(comments) ? comments : []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const c of sorted) {
    if (login && c.user?.login !== login) continue;
    const m = CHARTER_MARK_RE.exec(String(c.body ?? ''));
    if (!m) continue;
    try { latest = toCharter(JSON.parse(m[1])); } catch { /* 坏掉的章程评论不采信，继续找更早或更晚的合法章程 */ }
  }
  return latest;
}

/** PR 目标分支是否在章程授权自动交合并请求的范围里。 */
export function baseAllowed(charter, base) {
  if (!charter?.merge?.auto_request) return false;
  return charter.merge.bases.some((b) => (b === 'integration/*' ? /^integration\/[^/]+$/.test(String(base)) : b === base));
}

// write / read

export function write({ gh, rootRef, raw, now = nowIso() }) {
  const { ref } = parseIssueRef(rootRef);
  const charter = toCharter(raw);
  const body = `批准执行章程：${String(now).slice(0, 10)}\n\n<!-- approve-exec:charter v1 ${JSON.stringify(charter)} -->`;
  const posted = gh(['api', '-X', 'POST', commentsPath(ref), '-f', `body=${body}`]);
  return { ok: true, root: ref, charter, comment_url: posted?.html_url ?? null };
}

export function read({ gh, rootRef }) {
  const { ref } = parseIssueRef(rootRef);
  return { ok: true, root: ref, charter: selectCharter(readComments(gh, commentsPath(ref)), ghLogin(gh)) };
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd] = args._;
  const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
  try {
    let out;
    if (cmd === 'write') {
      if (typeof args.json !== 'string') reject('--json 要填章程文件路径');
      let raw;
      try { raw = JSON.parse(readFileSync(args.json, 'utf8')); } catch (err) { reject(`读不了章程文件 ${args.json}（${err.code ?? err.message}）`); }
      out = write({ gh, rootRef: args.root, raw, now: typeof args.now === 'string' ? args.now : nowIso() });
    } else if (cmd === 'read') out = read({ gh, rootRef: args.root });
    else reject(`子命令只能是 write / read（当前：${cmd ?? '空'}）`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
