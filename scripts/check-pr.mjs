#!/usr/bin/env node
// check-pr.mjs — 批准执行（2026-11-07 改版）lead 的确定性检查，不读台账。只读 GitHub。
//   --stage acceptance：执行会话发来「待验收」时跑。PR 必须还是 Draft，当前 head 必需 CI 全绿，改动在子 issue 范围内，
//                       PR 正文有「任务 issue」一行、「验收对照」覆盖全部 SC，子 issue 待定问题都已写「已定」。
//   --stage ready：执行会话发来「已转正式」时跑。PR 已不是 Draft（已合并也算过），当前 head 必需 CI 全绿。
// 检查全过只是必要条件：lead 还要对照子 issue 的「目标」「原因」「不做」看 diff 是否做对了事。
//
// CLI: node scripts/check-pr.mjs --item <owner/repo#号> --pr <PR 号> [--head <40 位 sha>] [--stage acceptance|ready]
//        [--gh-fixture <夹具>]
// 输出：一行 JSON {ok, stage, ref, pr, head, checks:[{name, ok, detail}]}；全部通过 exit 0，否则 exit 2。
import { isMain, parseArgs } from './lib/common.mjs';
import { ghRunner, parseIssueRef, pendingQuestions, readIssue, sectionText, splitSections, toKeelSc, toScope } from './issue-plan.mjs';
import { ciVerdict, ghChecksRunner, outOfScope, scRowsInBody } from './accept-check.mjs';

export const STAGES = ['acceptance', 'ready'];
const MAX_FILE_PAGES = 30; // GitHub 的 PR 文件列表最多 3000 条

function prFiles(gh, repo, pr) {
  const files = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = gh(['api', `repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`]);
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) return files;
  }
  throw new Error(`PR #${pr} 改动文件超过 ${MAX_FILE_PAGES * 100} 个，无法完整核对范围`);
}

export function checkPr({ gh, checks, ref: rawRef, pr, head = null, stage = 'acceptance' }) {
  if (!STAGES.includes(stage)) throw new Error(`--stage 只能是 ${STAGES.join(' / ')}（当前：${stage}）`);
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`--pr 要填 PR 号（当前：${pr}）`);
  const { repo, number, ref } = parseIssueRef(rawRef);
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });

  const p = gh(['api', `repos/${repo}/pulls/${pr}`]);
  const actualHead = p?.head?.sha ?? null;
  if (head) add('pr_head', actualHead === head, `PR head ${actualHead ?? '未知'}，消息里的 head ${head}`);
  const merged = stage === 'ready' && p?.merged === true;
  add('pr_open', p?.state === 'open' || merged, merged ? 'PR 已合并' : `PR 状态 ${p?.state ?? '未知'}`);
  if (stage === 'acceptance') add('pr_draft', p?.draft === true, p?.draft === true ? 'PR 还是 Draft' : 'PR 已不是 Draft：lead 判通过之前不该转正式');
  if (stage === 'ready') add('pr_not_draft', p?.draft === false, p?.draft ? 'PR 还是 Draft：还没转正式' : 'PR 已是正式');
  if (!merged) {
    const ci = ciVerdict(checks, repo, pr);
    add('ci', ci.ok, ci.detail);
  }
  if (stage === 'ready') return { ok: out.every((c) => c.ok), stage, ref, pr, head: actualHead, checks: out };

  const issue = readIssue(gh, repo, number);
  const sections = splitSections(issue.body ?? '');
  // 有的仓要求每个 PR 附交接目录 docs/pr/<PR号>/（如 mivo 的 review.md、qa.md），子 issue「范围」常漏写，这里固定放行。
  const scope = [...toScope(sectionText(sections, '范围'), ref), `docs/pr/${pr}/`];
  const outside = outOfScope(prFiles(gh, repo, pr), scope);
  add('scope', outside.length === 0, outside.length ? `超出子 issue 范围：${outside.join('、')}` : '改动文件都在子 issue 范围内');

  const body = String(p?.body ?? '');
  const hasLine = body.split('\n').some((l) => l.trim() === `任务 issue：${ref}`);
  add('body_issue_line', hasLine, `PR 正文${hasLine ? '有' : '缺'}「任务 issue：${ref}」一行`);
  const { sc, manual } = toKeelSc(sectionText(sections, '验收标准'), ref);
  const scIds = [...sc, ...manual].map((s) => s.id);
  const rows = scRowsInBody(body);
  const missing = scIds.filter((id) => !rows.has(id));
  add('body_sc_rows', missing.length === 0, missing.length ? `PR 正文「验收对照」缺 ${missing.join('、')}` : `「验收对照」覆盖 ${scIds.length} 条 SC`);

  const open = pendingQuestions(sectionText(sections, '待定问题'));
  add('pending_questions', open.length === 0, open.length ? `子 issue 还有没写「已定」的待定问题：${open.join('；')}` : '待定问题都已写回结论');

  return { ok: out.every((c) => c.ok), stage, ref, pr, head: actualHead, checks: out };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixture = typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null;
  try {
    const res = checkPr({
      gh: ghRunner(fixture), checks: ghChecksRunner(fixture), ref: args.item, pr: Number(args.pr),
      head: typeof args.head === 'string' ? args.head : null, stage: typeof args.stage === 'string' ? args.stage : 'acceptance',
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return res.ok ? 0 : 2;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
