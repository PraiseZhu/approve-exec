#!/usr/bin/env node
// render-issue-handoff.mjs — issue 入口的一页开工包。内容只来自计划（issue-plan.mjs 的产物），
// 不写模型 ID、不写派工路由文件路径：模型由 owner 会话与 KEEL 主控方案决定。
//
// CLI: node scripts/render-issue-handoff.mjs --plan <plan.json> --item <owner/repo#号> --lead-session <id> [--ledger <ledger.json>]
// 输出：开工包正文（stdout）。exit 0 / 2（计划里没有这个子 issue）。
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, parseArgs } from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** owner 的验收点：KEEL 只差把 Draft 转正式（PraiseZhu/approve-exec#77）。 */
export const ACCEPTANCE_POINT =
  'KEEL 只差转 Ready：交接车道是 `next` 让你调 `pr_ready`，其他车道是 done 门只剩 `pr_status 是 mark_ready`。这时 PR 还是 Draft、CI 全绿、非作者审查已通过';
/** owner 结束本轮只有这四种情况；别的时候一直照 `next` 做。 */
export const END_TURN_STATES = Object.freeze(['awaiting_acceptance', 'ready', 'needs_lead', 'blocked_user']);

function mergeOrderLine(item) {
  if (item.merge_after.length === 0 && item.hard_deps.length === 0) return '无先后要求';
  const parts = [];
  if (item.hard_deps.length) parts.push(`${item.hard_deps.join('、')} 合进目标分支后才派到你，现在已满足`);
  if (item.merge_after.length) parts.push(`${item.merge_after.join('、')} 先合，你的 PR 再合：转 Ready 前先同步目标分支`);
  return parts.join('；');
}

/** owner 跑的台账命令；台账路径在 prepare 时填入，dry-run 时用占位。 */
function runCmd({ scriptsDir, ledgerPath, ref }, sub, tail = '') {
  return `node ${JSON.stringify(`${scriptsDir}/issue-run.mjs`)} ${sub} --ledger ${JSON.stringify(ledgerPath)} --item ${ref}${tail ? ` ${tail}` : ''}`;
}

export function renderIssueHandoff({ plan, item, leadSessionId, ledgerPath = '<台账路径，派发时填入>', scriptsDir = HERE }) {
  if (!leadSessionId) throw new Error('renderIssueHandoff 需要 lead 会话 id');
  const cmd = (tail) => runCmd({ scriptsDir, ledgerPath, ref: item.ref }, 'checkpoint', tail);
  const auth = plan.authorization_source;
  const scTable = JSON.stringify([
    ...item.keel_run.sc.map((s) => ({ id: s.id, status: 'pass' })),
    ...item.manual_scs.map((s) => ({ id: s.id, status: 'manual' })),
  ]);
  // 总 issue：以总 issue 为入口时取 root；以单个子 issue 为入口时取子 issue 首行写的总 issue。
  const parentRef = plan.root.kind === 'parent' ? plan.root.ref : item.parent_ref ?? null;
  const parentUrl = plan.root.kind === 'parent'
    ? plan.root.url
    : parentRef && `https://github.com/${parentRef.replace('#', '/issues/')}`;
  const manual = item.manual_scs.length
    ? item.manual_scs.map((s) => `   - ${s.text}`).join('\n')
    : '   - 无';
  const pending = item.pending_questions.length
    ? item.pending_questions.map((q) => `   - ${q}`).join('\n')
    : '   - 无';
  const lines = [
    `# 开工包：${item.ref}「${item.title}」`,
    '',
    '这是执行指令，直接开工，不要反问要不要开始。',
    '',
    '## 1. 你负责什么',
    '',
    `- 子 issue：${item.url}。范围、不做、验收标准都以它为准。`,
    ...(parentUrl ? [`- 总 issue：${parentUrl}。并行/串行原则与决策表在这里。`] : []),
    `- 目标仓：${item.repo}，主目录 \`${item.keel_run.repo_dir}\`；PR 目标分支：${item.keel_run.base_ref ?? 'main'}。`,
    `- 批次：第 ${item.wave} 批。合并顺序：${mergeOrderLine(item)}。`,
    `- 授权：「${plan.authorization_source}」。推送、开 PR、按目标仓规则转 Ready 都在这句授权内；合并不在。`,
    `- lead 会话：${leadSessionId}。`,
    '',
    '## 2. 怎么做',
    '',
    '1. 调 KEEL 的 `keel_run`，参数原样用下面这段；会改代码，`scope` 已按 issue「范围」给出：',
    '',
    '```json',
    JSON.stringify(item.keel_run, null, 2),
    '```',
    '',
    '2. 之后只照 KEEL 返回的 `next` 推进，一直做到第 3 节的验收点。你是无人值守的 owner：KEEL 手册里让你停下的地方按下面做，自己处理，不找 lead，也不找用户。',
    `   - \`next\` 让你调 \`pr_open\`：加 \`draft: true\`，\`authorization_source\` 填「${auth}」。任何车道都先开 Draft。`,
    '   - `next` 是等待（`keel_wait` 等）：等完照新的 `next` 接着做。在等 CI 不是结束本轮的理由。',
    '   - `next.kind` 是 `decide`：自己答。拿不准先问 KEEL 的 `jev`；低于执行线时取改动最小、可撤回的选项（KEEL 手册第 9 条）。done 门缺证据选 `revise`，验证没过选 `retry_verify`，不选 `waive`：豁免要用户原话，你没有。',
    '   - `next.kind` 是 `stop`：分支被别的 worktree 占着就跑第 3 节的 `free-worktree`，再调一次；别的原因写 `blocked_user`。',
    '3. 下面的待定问题，以及执行中遇到的方案选择，先问 KEEL 的 `jev`；把结论写回子 issue（「已定 YYYY-MM-DD：结论」）：',
    pending,
    `4. 开 PR 前跑 \`check-pr-issue.sh ${item.ref}\`；正文按任务 issue 范式写，第一行「任务 issue：${item.ref}」，目标仓允许时再写「Closes ${item.ref}」。`,
    '5. 下面这些验收项合并前拿不到证据，没有传给 `keel_run`；在 PR 正文「验收对照」里标「未执行」并写明验证层：',
    manual,
    '',
    '## 3. 收口：到验收点就停下，等 lead 裁决',
    '',
    `验收点：${ACCEPTANCE_POINT}。**lead 判通过之前，任何车道都不调 \`pr_ready\`**：转正式之后 KEEL 不再允许你推送。`,
    '',
    '到验收点后写 checkpoint，然后结束本轮；不用 `send_to_session` 回报，续跑脚本会叫醒 lead：',
    '',
    '```sh',
    cmd(`--state awaiting_acceptance --pr <PR 号> --head <40 位 head sha> --keel-run <KEEL run_id> --lane <车道> --sc '${scTable}'`),
    '```',
    '',
    '`--sc` 每条 SC 一行：KEEL 判通过的写 `pass`，上面第 5 条的黑盒验收项写 `manual`；还有没通过的就没到验收点。',
    '',
    `lead 会用 \`send_to_session\` 回你一条裁决：`,
    `- 「通过」：调 KEEL 的 \`pr_ready\`，\`authorization_source\` 填「${auth}」；成功后写 \`--state ready --pr <PR 号> --head <同一 sha>\`。不是交接车道的，再把 done 门答 \`wait\`，KEEL 看到可合并就收工。写完结束。`,
    '- 「要改」：先释放上一个 KEEL run 占着 PR 分支的 worktree，再用 `keel_run` 传 `pr=<PR 号>`（`scope` 同上）在同一 PR 上接着做；改完回到验收点，重新写 `--state awaiting_acceptance`：',
    '',
    '```sh',
    runCmd({ scriptsDir, ledgerPath, ref: item.ref }, 'free-worktree'),
    '```',
    '',
    '范围或验收标准必须改才能做完（先问过 `jev`，确认在范围内换做法也不行）：',
    '',
    '```sh',
    cmd('--state needs_lead --reason "<要加哪些文件或改哪条 SC，为什么>"'),
    '```',
    '',
    '只有用户能做的事（外部审批、规则集或权限、发布、缺凭据），或 `stop` 解决不了：',
    '',
    '```sh',
    cmd('--state blocked_user --reason "<要用户做什么>"'),
    '```',
    '',
    `结束本轮只有四种情况：写完 ${END_TURN_STATES.map((s) => `\`${s}\``).join(' / ')} 之一。别的时候一直照 \`next\` 做，不回报进度。`,
    '',
    '## 4. 不许做',
    '',
    '- 不合并 PR，不开 auto-merge，不 force push，不直推默认分支。',
    '- 不改 issue 的范围和验收标准；必须改时写 `needs_lead`。',
    '- 不改范围以外的文件；KEEL 报 `SCOPE_VIOLATION` 时按它的提示收回越界改动。',
    '',
  ];
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const plan = JSON.parse(readFileSync(String(args.plan), 'utf8'));
  const item = plan.items.find((i) => i.ref === args.item);
  if (!item) {
    process.stderr.write(`[REJECT] 计划里没有 ${args.item}\n`);
    return 2;
  }
  const ledgerPath = typeof args.ledger === 'string' ? args.ledger : undefined;
  process.stdout.write(renderIssueHandoff({ plan, item, leadSessionId: args['lead-session'], ledgerPath }));
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
