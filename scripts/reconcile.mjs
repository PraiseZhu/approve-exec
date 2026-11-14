#!/usr/bin/env node
// reconcile.mjs — 批准执行 v3 的对账器（PraiseZhu/approve-exec#103）。
// 给它一个总 issue，它只读 GitHub，算出每个子 issue 走到哪一步、在等谁、等了多久，以及现在该叫醒谁做什么。
// 不存进度状态、不写 GitHub、不发消息、不写本地文件：同一份事实永远得到同一份输出。
// 判定规则在 lib/reconcile-rules.mjs（纯函数）；敲门由 reconcile-tick.py 做。
//
// CLI:
//   node scripts/reconcile.mjs --root <owner/repo#号> [--report]
//   node scripts/reconcile.mjs --replay <回放文件> --at <ISO 时间> [--report] [--charter <章程文件>]
//   node scripts/reconcile.mjs --roots-from-search [--owner <账号>]
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>]
// 输出：stdout 一行 JSON（--report 时是 {ok, root, markdown}）；exit 0 成功 / 2 参数错或读 GitHub 失败。
import { readFileSync } from 'node:fs';
import { isMain, nowIso, parseArgs } from './lib/common.mjs';
import { ghRunner, parseIssueRef } from './issue-plan.mjs';
import { readComments } from './issue-run.mjs';
import { capture } from './replay-capture.mjs';
import { selectCharter, toCharter } from './charter.mjs';
import { reconcile, toFacts, toReport } from './lib/reconcile-rules.mjs';

export class ReconcileError extends Error {}
const reject = (msg) => { throw new ReconcileError(msg); };

// helpers

/** 每个开着 PR 的子 issue 补一个「有没有还在跑的检查」（只在现读时有意义，回放里没有这项事实）。 */
function withPendingChecks(gh, data) {
  for (const pr of data.prs) {
    if (pr.state !== 'open' || !pr.head_sha) continue;
    try {
      const runs = gh(['api', `repos/${pr.repo}/commits/${pr.head_sha}/check-runs?per_page=100`]);
      pr.pending_checks = (runs?.check_runs ?? []).some((r) => r.status !== 'completed');
    } catch { pr.pending_checks = false; }
  }
  return data;
}

/** 现读一个总 issue → 事实。 */
export function readFacts({ gh, rootRef, now = nowIso() }) {
  const data = withPendingChecks(gh, capture({ gh, rootRef, light: true, now }));
  return toFacts(data, now);
}

/** 当前账号名下、开着的、带「总issue」标签的 issue 里，有合法章程评论的那些（对账任务只管这些 run）。 */
export function selectActiveRoots({ gh, owner = null }) {
  const login = owner ?? gh(['api', 'user'])?.login;
  if (!login) reject('读不到当前 gh 账号');
  const q = encodeURIComponent(`is:issue is:open author:${login} label:总issue`);
  const res = gh(['api', `search/issues?q=${q}&per_page=100`]);
  const refs = (res?.items ?? []).map((i) => `${String(i.repository_url ?? '').split('/').slice(-2).join('/')}#${i.number}`).sort();
  // 先只读总 issue 的评论确认有章程，再做完整对账：没有章程的 run 不花读取配额。
  return refs.filter((ref) => {
    const { repo, number } = parseIssueRef(ref);
    return selectCharter(readComments(gh, `repos/${repo}/issues/${number}/comments`), login) !== null;
  });
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
  const now = typeof args.now === 'string' ? args.now : nowIso();
  try {
    if (args['roots-from-search'] === true) {
      const roots = selectActiveRoots({ gh, owner: typeof args.owner === 'string' ? args.owner : null });
      const runs = roots.map((rootRef) => {
        const facts = readFacts({ gh, rootRef, now });
        if (!facts.charter) return null;
        return { ...reconcile(facts), lead_session: facts.charter.lead_session };
      }).filter(Boolean);
      process.stdout.write(`${JSON.stringify({ ok: true, at: now, runs })}\n`);
      return 0;
    }
    let facts;
    if (typeof args.replay === 'string') {
      if (typeof args.at !== 'string' || Number.isNaN(Date.parse(args.at))) reject('--replay 要配 --at <ISO 时间>');
      let data;
      try { data = JSON.parse(readFileSync(args.replay, 'utf8')); } catch (err) { reject(`读不了回放文件 ${args.replay}（${err.code ?? err.message}）`); }
      const charter = typeof args.charter === 'string' ? toCharter(JSON.parse(readFileSync(args.charter, 'utf8'))) : undefined;
      facts = toFacts(data, args.at, { charter });
    } else if (typeof args.root === 'string') {
      facts = readFacts({ gh, rootRef: args.root, now });
    } else reject('要填 --root <owner/repo#号>、--replay <回放文件> --at <ISO> 或 --roots-from-search');
    const out = args.report === true ? { ok: true, root: facts.root, markdown: toReport(facts).markdown } : reconcile(facts);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
