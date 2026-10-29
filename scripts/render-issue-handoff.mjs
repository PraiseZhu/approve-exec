#!/usr/bin/env node
// render-issue-handoff.mjs — issue 入口的一页开工包。内容只来自计划（issue-plan.mjs 的产物），
// 不写模型 ID、不写派工路由文件路径：模型由 owner 会话与 KEEL 主控方案决定。
//
// CLI: node scripts/render-issue-handoff.mjs --plan <plan.json> --item <owner/repo#号> --lead-session <id>
// 输出：开工包正文（stdout）。exit 0 / 2（计划里没有这个子 issue）。
import { readFileSync } from 'node:fs';
import { isMain, parseArgs } from './lib/common.mjs';

export const KEEL_DONE =
  '`pr_status` 的 `nextAction` 是 `report_mergeable`；或交接车道 `pr_ready` 成功后变为 `stopped_after_handoff`；或报出具体阻塞（缺权限、缺环境、预算用完）。看到 `handoff` 表示该调 `pr_ready` 交接，不是结束';

function mergeOrderLine(item) {
  if (item.merge_after.length === 0 && item.hard_deps.length === 0) return '无先后要求';
  const parts = [];
  if (item.hard_deps.length) parts.push(`${item.hard_deps.join('、')} 合进目标分支后才派到你，现在已满足`);
  if (item.merge_after.length) parts.push(`${item.merge_after.join('、')} 先合，你的 PR 再合：转 Ready 前先同步目标分支`);
  return parts.join('；');
}

export function renderIssueHandoff({ plan, item, leadSessionId }) {
  if (!leadSessionId) throw new Error('renderIssueHandoff 需要 lead 会话 id');
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
    `2. 之后只照 KEEL 返回的 \`next\` 推进，直到 KEEL 完成标准：${KEEL_DONE}。`,
    '3. 下面的待定问题，以及执行中遇到的方案选择，先问 KEEL 的 `jev`；把结论写回子 issue（「已定 YYYY-MM-DD：结论」），不回来问 lead 或用户：',
    pending,
    `4. 开 PR 前跑 \`check-pr-issue.sh ${item.ref}\`；正文按任务 issue 范式写，第一行「任务 issue：${item.ref}」，目标仓允许时再写「Closes ${item.ref}」。`,
    '5. 下面这些验收项合并前拿不到证据，没有传给 `keel_run`；在 PR 正文「验收对照」里标「未执行」并写明验证层：',
    manual,
    '',
    '## 3. 什么时候回报',
    '',
    `完成（达到上面的 KEEL 完成标准），或遇到只有用户能做的事（外部审批、规则集或权限、发布、缺凭据）时，用 \`send_to_session\` 给 lead 会话 ${leadSessionId} 发一条回执：PR 链接、状态、CI 结果、每条 SC 的状态、需要用户做的事。别的时候不发。`,
    '',
    '## 4. 不许做',
    '',
    '- 不合并 PR，不开 auto-merge，不 force push，不直推默认分支。',
    '- 不改 issue 的范围和验收标准；确实要改时先回报 lead。',
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
  process.stdout.write(renderIssueHandoff({ plan, item, leadSessionId: args['lead-session'] }));
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
