#!/usr/bin/env node
// render-pr-handoff.mjs — 用户可见开工包。缺块、乱序、缺绝对路径 = 渲染失败，不得 create session。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './lib/common.mjs';
import { LedgerError, readLedger, readExecutionManifest, assertManifestBound, findPacket, findGroupWave } from './run-ledger.mjs';
import {
  assertHandoffComplete, assertExcerpts, assertVerifyCmds, assertOwnerTitle,
} from './vnext-owner-contract.mjs';
import { findExtraStopPoints, formatStopPoints } from './lib/stop-points.mjs';
import { loadCollateralPolicy, renderCollateralPolicyText } from './lib/collateral.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_BLOCK_PATH = join(ROOT, '_tmp/handoff-gate-block-0.md');
const GOAL_SKILL = '/Users/praise/.agents/skills/goal/SKILL.md';
const ROUTING_LIVE = '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json';

const SECTION_TITLES = Object.freeze([
  '0. 开工闸',
  '1. 身份',
  '2. 为什么改',
  '3. 不要重读也能开工的现场',
  '4. 具体改法',
  '5. allowed_paths',
  '6. SC 全文',
  '7. 验证命令',
  '8. 做完之后（自动，不要问 lead）',
  '9. 禁做',
  '10. 回报格式',
]);

function gateBlock0() {
  const raw = readFileSync(GATE_BLOCK_PATH, 'utf8');
  return raw.replace(/^# 开工闸[^\n]*\n+/, '').trimEnd();
}

function requireAbs(path, what) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new LedgerError('PACKET_INCOMPLETE', `${what} 必须是绝对路径（当前: ${path ?? '缺失'}）`);
  }
}

export function renderScText(packet) {
  return packet.scs_inline.map((sc) => {
    const anchors = Array.isArray(sc.anchor_paths) ? sc.anchor_paths.join(', ') : packet.allowed_paths.join(', ');
    return '- id=' + sc.id + '\n  priority_id=' + sc.priority_id + '\n  change=' + (sc.change ?? '')
      + '\n  holds=' + (sc.holds ?? '') + '\n  expect=' + (sc.expect ?? '') + '\n  anchor_paths=' + anchors;
  }).join('\n');
}

// 决策三层（D0/D1/D2）+ Jev 调用约定 + CI 不收工。owner 多为 Pi，不读 ~/.claude/rules，必须内联。
export function renderDecisionLadder({ jevJournal, actConfidence, continuationV2 = false }) {
  const journal = jevJournal ?? '<台账目录>/jev/<sha256(组)>.jsonl（lead 出包时给绝对路径）';
  return [
    '决策三层（owner 自己判；可自决的不要问 lead）：',
    'D0 事实题：能用命令查清的自己查，不问 Jev 也不问 lead——CI 哪个 job 红（gh pr checks / gh run view --log-failed）、文件在不在 allowed_paths 或第 5 段连带清单、size-gate 结果、同一失败在 base 上是否也红。',
    `D1 域内判断（可自决）：不改 SC、对外接口兼容、授权、跨 PR 依赖和 base 的选择，先调 Jev 再自己执行。Pi 用 cindy_mcp_list_tools / cindy_mcp_call_tool 网关调 cindy 的 ghost_call；Claude/Codex 用 mcp__cindy__ghost_call；参数 ghost_id=keel、tool=jev、args={state, questions:{<qid>:{type: choice|noul|score, instructions, criteria}}}，返回 answers[qid].choice / confidence / probabilities（noul 返回概率）。固定时点：CI 红且日志不像基础设施故障；域外测试红（断言的是 SC 明确改掉的旧行为，还是本 PR 真回归）；等价实现二选一；连续 2 轮零增量换策略；record-delivery 前逐条核 SC 证据够不够。state 只放本题事实（SC 原文、失败断言、diff 摘要），不放密钥和整段日志；选项只列域内动作，不给 Jev「上报 lead」选项。choice 的 confidence ≥ ${actConfidence} 直接执行；否则补一条事实再问一次；仍低就取改动更小、可撤回的一项。`,
    `Jev 留痕：每次调用追加一行 JSON 到 ${journal}：{at, head, qid, question, options, choice, confidence, action, paths}。不写进 worktree。`,
    'Jev 不可用（网关没有 keel 或调用报错）：在留痕记 JEV_UNAVAILABLE；重跑 CI、等价实现、换策略这类可撤回的 D1 按「改动最小 > 可撤回 > 跟随仓内既有写法 > 不扩写域」自决，不回问 lead；连带文件改动必须有 Jev 结论，没有就按 D2 必须停。owner 自己派的只读 sub 没有网关，它们的 JEV_DECISION_REQUEST 回给 owner，由 owner 代调，不上交 lead。',
    'D2 必须停（DECISION_REQUIRED，保留原 owner 绑定）：硬停六条；hash/身份自检失败；SC、接口兼容、授权或跨 PR 依赖发生变化；allowed_paths 不够且不符合第 5 段连带策略；base 本身红；授权不足；已授权恢复策略和预算耗尽；连续 3 轮零增量。只发一条 decision_required，附已尝试动作、fallbacks_tried 和 Jev 给的选项排序（留痕行号），等 lead 一个决定后同一 owner 继续。等待期间保留任务状态、阻塞原因和唤醒条件，不报完成。',
    continuationV2
      ? 'CI 等待不收工：push 后启用了 continuation v2 就写 --phase waiting-ci 的 checkpoint 再结束本轮，由零 token 脚本在 CI 出结果时唤醒；未启用时本轮内用 KEEL 的 pr_wait 轮询（单次最多 25 分钟，超时就再调）（KEEL 不可用时降级为 gh pr checks <PR> --watch --interval 60，单条命令超时就重进，并在留痕记 KEEL_UNAVAILABLE），不得以「在等 CI」收工或报完成。CI 红先走确定性规则：失败日志命中网络超时 / ETIMEDOUT / ECONNRESET / 429 / runner 失联这类基础设施故障，且同一 head 未重跑过，就 gh run rerun <run-id> --failed 一次；不命中或重跑后仍红，再按 D1 问 Jev 定修法。'
      : 'CI 等待不收工：本包未启用 continuation v2，续跑调度只唤醒 lead、不会唤醒你；push 后不得以 waiting-ci 或「在等 CI」结束本轮，必须在本轮内用 KEEL 的 pr_wait 轮询到出结果（单次最多 25 分钟，超时就再调）（KEEL 不可用时降级为 gh pr checks <PR> --watch --interval 60，单条命令超时就重进，并在留痕记 KEEL_UNAVAILABLE），再继续转 Ready、写 pr_ready 和 goal_report。CI 红先走确定性规则：失败日志命中网络超时 / ETIMEDOUT / ECONNRESET / 429 / runner 失联这类基础设施故障，且同一 head 未重跑过，就 gh run rerun <run-id> --failed 一次；不命中或重跑后仍红，再按 D1 问 Jev 定修法。',
  ];
}

/** lead 可写部分不得加第⑧节五类停以外的停点（见 lib/stop-points.mjs）。 */
export function assertNoExtraStopPoints({ why, how, tableLine, forbidden = [] }) {
  const checks = [
    ['第 2 段', findExtraStopPoints(why)],
    ['第 4 段', findExtraStopPoints(how)],
    ['总表', findExtraStopPoints(tableLine)],
    ...forbidden.map((item) => ['第 9 段禁做「' + item + '」', findExtraStopPoints(item, { forbiddenItem: true })]),
  ];
  for (const [where, hits] of checks) {
    if (hits.length) throw new LedgerError('PACKET_EXTRA_STOP', formatStopPoints(where, hits));
  }
}

export function renderPrHandoff({
  packet, identity, leadSessionId, seq, repo, title, snapshot,
  why, excerpts, how, forbiddenExtra, tableLine, executionPlanHash, continuation,
  jevJournal, provenance,
}) {
  if (!packet || typeof packet !== 'object') {
    throw new LedgerError('PACKET_INCOMPLETE', 'render-pr-handoff 缺 packet');
  }
  if (!identity || typeof identity !== 'object') {
    throw new LedgerError('PACKET_INCOMPLETE', 'render-pr-handoff 缺 identity');
  }
  for (const k of ['worktree', 'branch', 'base']) {
    if (typeof identity[k] !== 'string' || identity[k].length === 0) {
      throw new LedgerError('PACKET_INCOMPLETE', `identity.${k} 必须是非空字符串`);
    }
  }
  requireAbs(identity.worktree, 'identity.worktree');
  requireAbs(GOAL_SKILL, 'goal skill');
  requireAbs(ROUTING_LIVE, 'routing.json');
  if (typeof leadSessionId !== 'string' || leadSessionId.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'lead session id 必须是非空字符串');
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new LedgerError('PACKET_INCOMPLETE', `本 PR 序号必须是正整数（当前: ${seq}）`);
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '仓名必须是非空字符串');
  }
  if (typeof title !== 'string' || !title.includes('丨 ')) {
    throw new LedgerError('PACKET_INCOMPLETE', 'title 必须含分隔符「丨 」');
  }
  assertOwnerTitle(title);
  if (!Array.isArray(packet.allowed_paths) || packet.allowed_paths.some((p) => typeof p !== 'string' || p.endsWith('/'))) {
    throw new LedgerError('PACKET_INCOMPLETE', 'allowed_paths 只列文件，禁止目录');
  }
  if (!Array.isArray(packet.scs_inline) || packet.scs_inline.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'scs_inline 必须非空');
  }
  if (!Array.isArray(packet.verify_cmds) || packet.verify_cmds.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'verify_cmds 必须非空');
  }
  assertVerifyCmds(packet.verify_cmds);
  const resolvedExcerpts = excerpts ?? packet.excerpts;
  const resolvedHow = how ?? packet.how ?? '';
  const resolvedWhy = why ?? packet.why ?? (typeof packet.instruction === 'string' ? packet.instruction.split('\n').find((l) => l.trim()) : '') ?? '';
  if (!Array.isArray(resolvedExcerpts) || resolvedExcerpts.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 3 段至少 1 条真摘录（file + line + behavior），禁止占位');
  }
  assertExcerpts(resolvedExcerpts, { worktree: identity.worktree });
  if (typeof resolvedHow === 'string' && typeof resolvedWhy === 'string' && resolvedHow.trim() === resolvedWhy.trim() && resolvedHow.trim().length > 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 4 段必须是改法，不得复制第 2 段');
  }

  const gate = gateBlock0();
  if (!gate.includes('用 goal skill 执行。')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工闸第 0 块必须含「用 goal skill 执行。」');
  }

  const whyLine = resolvedWhy;
  const excerptLines = resolvedExcerpts.map((e) => (typeof e === 'string' ? e : `${e.file}:${e.line} ${e.behavior}`));
  for (const entry of resolvedExcerpts) {
    const file = typeof entry === 'string' ? entry.trim().match(/^(\S+):\d+\s/)[1] : entry.file;
    excerptLines.push('source_sha256(' + file + ')=' + sha256(readFileSync(resolve(identity.worktree, file))));
  }
  const howLine = resolvedHow;
  if (typeof howLine !== 'string' || howLine.trim().length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 4 段具体改法不能为空，不得回退成 instruction 禁令');
  }
  let collateralPolicy;
  try {
    collateralPolicy = loadCollateralPolicy();
  } catch (err) {
    throw new LedgerError('PACKET_INCOMPLETE', `开工包第 5 段需要连带策略: ${err.message}`);
  }
  if (jevJournal !== undefined) requireAbs(jevJournal, 'Jev 留痕路径');
  assertNoExtraStopPoints({ why: resolvedWhy, how: resolvedHow, tableLine,
    forbidden: [...(packet.forbidden ?? []), ...(forbiddenExtra ?? [])] });
  const forbidden = [
    ...(packet.forbidden ?? []),
    ...(forbiddenExtra ?? []),
    '未读 goal / 未读 routing.json 不得开工',
    '不得改总表 / allowed_paths / base（只能 lead 走 replan）；第 5 段连带策略内的连带文件不算改 allowed_paths，但必须在交卷 collateral_used 逐条申报',
    '假设破裂必须 blocked 上报：仅指 SC、对外接口兼容、授权、跨 PR 依赖、allowed_paths 或 base 变化；现场摘录变化但域内等价实现可自决；符合第 5 段连带策略的连带文件不算 allowed_paths 不够',
  ];
  const provenanceLine = provenance?.kind === 'context-brief'
    ? `任务来源=上下文方案（brief sha256=${provenance.brief_sha256}；未经 task-priority 七面覆盖与对抗质询，PR 描述须标注）`
    : '任务来源=task-priority final manifest';

  const scLines = renderScText(packet).split('\n');

  const snapshotNote = snapshot
    ? `渲染当时快照，派工时再读。model-route show / ${ROUTING_LIVE}${typeof snapshot === 'string' ? `\n${snapshot}` : ''}`
    : `渲染当时快照，派工时再读。派工前必须再跑 model-route show 或 Read ${ROUTING_LIVE}`;

  const sections = [
    ['0. 开工闸', gate],
    ['1. 身份', [
      `仓=${repo}`,
      `对照树（只读）=${identity.worktree}`,
      `开发基线 SHA=${identity.base}`,
      `新分支名=${identity.branch}`,
      `lead session id=${leadSessionId}`,
      `本 PR 在总表里的序号=${seq}`,
      `session 标题=${title}`,
      provenanceLine,
    ].join('\n')],
    ['2. 为什么改', whyLine || '本 PR 修一条用户能看见的失败。'],
    ['3. 不要重读也能开工的现场', excerptLines.map((e) => (typeof e === 'string' ? e : `${e.file}:${e.line} ${e.behavior}`)).join('\n')],
    ['4. 具体改法', howLine],
    ['5. allowed_paths', [
      packet.allowed_paths.map((p) => `- ${p}`).join('\n'),
      '',
      renderCollateralPolicyText(collateralPolicy),
    ].join('\n')],
    ['6. SC 全文', scLines.join('\n')],
    ['7. 验证命令', packet.verify_cmds.join('\n')],
    ['8. 做完之后（自动，不要问 lead）', [
      'candidate 只是检查点，不是终点。同一 owner 继续到机器可证明的 PR Ready；启用 continuation v2 后，lead 仅在必要决策或整包最终验收时接收聚合事件。',
      ...(continuation ? ['启用 continuation v2 时，绑定完成后先写 checkpoint；阶段变化、CI等待、真实决策和交付前必须更新。同一命令用新 --phase/--step 重跑；不得只留口头进度。命令：' + continuation.command] : []),
      '启动执行时，若当前宿主实际暴露 create_goal/get_goal 工具，先检查并沿用本任务的 active Goal；没有本任务 Goal 时启动一个，目标必须覆盖本包全部 SC、本地 e2e、普通 push、当前提交必需 CI 绿、两阶段释放与 PR Ready。不得在 SC PASS 检查点把整体 Goal 标成 complete。若宿主未暴露这些工具，明确记录能力缺口并按内联契约继续，不把读过 goal skill 声称为已启动宿主 Goal。',
      'goal 场景 C 的 SC PASS 只是子阶段完成，不是 owner 整体任务完成。仅当所有 SC 都有 PASS 证据且没有 hard_stop、预算暂停或 blocked 时，才正常返回同一 owner 继续本地 e2e 和 PR Ready 收尾；不得通过切换阶段绕过停止条件。',
      '授权以本次任务已给出的来源、目标仓、分支和动作为准，开工包应注明；已明确授权的提交、推送、创建/更新目标 PR 直接执行，不重复请示。只有对应动作确实未获授权时才停下请求决定，PR Ready 终点本身不产生新增授权。',
      'goal 内 push／回帖仍要求投递消息中合法的独立行 OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY 声明，仅覆盖当前 PR 的普通 push 和回帖，不授权创建 PR 或 merge；这段说明不是授权声明，不得自行补造声明。',
      'mem-probe → 现读同一份 routing.json 再派 e2e；本地禁止派 reviewer，禁止 GPT/Claude 单审。结果只回 owner，不向 lead 请示。',
      '先确认本 session 可调用只读 sub、Orca start_team/create_worker/create_workers。派 worker 前显式 start_team({ worker_permission_mode: "bypassPermissions" })，读取返回值并确认仍为 bypassPermissions；缺能力或返回 auto 不得创建，不得把配置期望当实际权限。',
      `绝对路径: ${ROUTING_LIVE}`,
      '先跑 model-route show',
      snapshotNote,
      '可自决：不改变 SC、接口兼容、授权和跨 PR 依赖的域内实现选型；派 read-only sub / e2e worker；本机测试红在 allowed_paths 内修到绿；已授权的 feature branch push 与目标 PR create/update。禁止派 review worker。',
      '429 / Too Many Requests 按 Retry-After 和现有预算在原路由等待重试，记录下一次唤醒；worker 崩溃先查原 worker 状态再恢复。创建失败结果不明时先查绑定，不盲目重复创建。只有 NO_PROVIDER_FOR_AGENT / PROVIDER_ROUTE_UNAVAILABLE / BUDGET_MODEL_REQUIRES_API_MODE 才按现读该档 fallbacks 换 provider、不换代次。每次实际降级写入 fallbacks_tried；未走降级保留空数组并说明原因，禁止空数组就问 lead。',
      ...renderDecisionLadder({ jevJournal, actConfidence: collateralPolicy.jev.act_confidence, continuationV2: Boolean(continuation?.command) }),
      'PR 状态用 KEEL 查（与 Jev 同一个插件：Pi 经 cindy_mcp_list_tools / cindy_mcp_call_tool 网关调 cindy 的 ghost_call，Claude/Codex 用 mcp__cindy__ghost_call，ghost_id=keel）：看 PR 状态用 pr_status；等 CI 按上面的 CI 等待规则（未启用 continuation v2 时用 pr_wait）。KEEL 的 nextAction 只作参考，不构成新停点：转 Ready、pr_ready、confirm-pr-open、goal_report 仍按本包原有规则与五类停判断，评审线程照旧归 Mini。仓库把 agent-verify 设为必需检查时，由本包已派的 e2e worker 验证当前 head 通过后写该状态（pr_status 会给出命令），有新提交就重验。本包自己的入账脚本（record-delivery、confirm-pr-open、release-mivo-pr）照旧执行，KEEL 不替代它们，也不另跑 pstack_start；KEEL 不可用时在留痕记 KEEL_UNAVAILABLE，按本包原有 gh 步骤继续。',
      '按第⑩节提交 candidate 后继续已授权的本机验证、提交、普通 push 与 Draft PR 收尾；Mivo 必须等当前提交必需 CI 全绿且审查workflow静态入口前提可用后转为 OPEN 非 draft，再写 pr_ready。pr_ready 之后同一 owner 重新执行 confirm-pr-open 确认 PR 仍 OPEN 非 draft、必需 CI 全绿，写 note-event goal_report：逐条 SC（含设计/功能目标）标 achieved|partial|not_achieved 并附证据，如实报告未达成项；CI 转红或 PR 被关就先修到绿再报，释放后不得再改产品则发 decision_required。goal_report 之后由 lead 写 final_acceptance：accepted 才算正式完结，rejected 由同一 owner 返工。lead 验收后立即清本地并归档该 owner；Mini Cindy 常驻程序按 PR 唯一修复 session 处理云端审查反馈。本机不追反馈；必要门禁和远端 head 均已确认。子 session 不合入；任何角色不得自动合并、启用 auto-merge 或调用 gh pr merge，只有用户对指定 PR 的当次明确授权才允许合并。',
    ].join('\n')],
    ['9. 禁做', forbidden.map((f) => `- ${f}`).join('\n')],
    ['10. 回报格式', [
      'candidate（检查点，不得含 pr_url）record-delivery exact: branch, tip_sha, scs, goal_skill_path, e2e, size_gate, fallbacks_tried；用了连带文件再加 collateral_used[{path, class, sc_id, reason, jev_ref}]（没用可省略或写 []）',
      `goal_skill_path 必须是 ${GOAL_SKILL}`,
      'pr_ready note-event detail: group_id, pr_url, current_pr_head_sha, receipt（重新执行 confirm-pr-open 的真实回执路径；必须晚于 pr_opened，五分钟内）',
      'Mivo v2：Draft下 release-mivo-pr.mjs prepare --repo --pr --head --validation-report --review-trust --out；CI/SC/E2E与静态审查前提通过后 release --worktree --candidate-receipt --out。confirm-pr-open 增加 --worktree 与 --release-receipt，交付A与Mini后继B分列；current_pr_head_sha填已验收A。释放后不写产品、不等待实际审查入场；unknown Ready只查原journal，不重复mutation。详细报告schema见owner-protocol。',
      'goal_report note-event detail: group_id, head_sha（= pr_ready 的 current_pr_head_sha）, receipt（pr_ready 之后重新执行 confirm-pr-open 的真实回执，五分钟内）, goals[{id, verdict: achieved|partial|not_achieved, evidence}]（覆盖本组全部 SC）, summary',
      'decision_required 人读报告：本组/当前 head、阻塞事实、已尝试动作、fallbacks_tried、唯一待决问题、选项和建议（附 Jev 选项排序与留痕行号；Jev 不可用写 JEV_UNAVAILABLE）；不是另造 ledger schema',
      '直接调用随包 owner-protocol 的 skill 脚本入账；不需要宿主 gateway。创建回执未知时保留原 claim，不重复 create。',
    ].join('\n')],
  ];

  const titles = sections.map(([t]) => t);
  if (titles.join('|') !== SECTION_TITLES.join('|')) {
    throw new LedgerError('PACKET_INCOMPLETE', `开工包段序必须钉死 0–10（当前: ${titles.join(' / ')}）`);
  }
  for (const [titleText, body] of sections) {
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new LedgerError('PACKET_INCOMPLETE', `开工包缺块: ${titleText}`);
    }
  }

  const lines = ['用 goal skill 执行。', '--until-sc', ''];
  if (packet.stages) {
    if (!executionPlanHash) throw new LedgerError('PACKET_INCOMPLETE', '缺 PR 执行计划绑定');
    lines.push('execution_plan_hash=' + executionPlanHash);
    lines.push('PR 内阶段（同一 owner，不另开 PR、不等待阶段合并）：');
    lines.push(JSON.stringify(packet.stages));
    lines.push('先执行 owner-gate.mjs baseline，通过后才执行 goal 开工闸；全部阶段 SC 通过后才能 Ready。');
  }
  if (tableLine) {
    lines.push('## 总表');
    lines.push(tableLine);
    lines.push('');
  }
  for (const [titleText, body] of sections) {
    lines.push(`## ${titleText}`);
    lines.push(body.trimEnd());
    lines.push('');
  }
  const out = `${lines.join('\n').trimEnd()}\n`;
  for (const t of SECTION_TITLES) {
    if (!out.includes(`## ${t}`)) {
      throw new LedgerError('PACKET_INCOMPLETE', `开工包缺块: ${t}`);
    }
  }
  if (!out.includes(GOAL_SKILL) || !out.includes(ROUTING_LIVE)) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包必须含 goal skill 与 routing.json 绝对路径');
  }
  assertHandoffComplete(out, {
    why: whyLine,
    how: howLine,
    excerpts: resolvedExcerpts,
    verify_cmds: packet.verify_cmds,
    title,
    worktree: identity.worktree,
  });
  return out;
}

export function readLeadContinuationSchemaVersion(ledgerPath) {
  const configPath = join(dirname(ledgerPath), 'lead-continuation.json');
  if (!existsSync(configPath)) return 1;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    return raw?.schemaVersion === 2 ? 2 : 1;
  } catch {
    return 1;
  }
}

function ownerCheckpointCommand(ledgerPath, group) {
  return 'python3 ' + [resolve(ROOT, 'scripts/owner-checkpoint.py'), '--ledger', resolve(ledgerPath), '--group', group, '--checkpoint', resolve(dirname(ledgerPath), 'owner-checkpoints', sha256(group) + '.json'), '--phase', 'executing', '--step', 'start-authorized-owner'].map(value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'").join(' ');
}

export function renderPrHandoffFromLedger({
  ledgerPath, group, leadSessionId, seq, repo, title, snapshot, now,
  why, how, excerpts,
}) {
  const ledger = readLedger(ledgerPath);
  const manifest = readExecutionManifest(ledger);
  assertManifestBound(ledger, manifest, 'render-pr-handoff');
  const packet = findPacket(manifest, group);
  const wave = findGroupWave(ledger, group);
  const wg = wave.groups.find((g) => g.group_id === group);
  const identity = { worktree: wg.worktree, branch: wg.branch, base: wg.base };
  const continuationV2 = readLeadContinuationSchemaVersion(ledgerPath) === 2;
  return renderPrHandoff({
    executionPlanHash: ledger.pr_plan?.plan_hash,
    jevJournal: resolve(dirname(ledgerPath), 'jev', sha256(group) + '.jsonl'),
    provenance: manifest.provenance,
    continuation: continuationV2 ? { command: ownerCheckpointCommand(ledgerPath, group) } : undefined,
    packet,
    identity,
    leadSessionId,
    seq,
    repo,
    title,
    snapshot,
    why: why ?? packet.why,
    how: how ?? packet.how,
    excerpts: excerpts ?? packet.excerpts,
  });
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const key = a.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new LedgerError('ARGS', `参数 --${key} 缺值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function parseJsonFlag(raw, what) {
  if (typeof raw !== 'string') throw new LedgerError('ARGS', `${what} 缺 JSON`);
  const text = raw.startsWith('@') ? readFileSync(resolve(raw.slice(1)), 'utf8') : raw;
  try { return JSON.parse(text); } catch (err) {
    throw new LedgerError('ARGS', `${what} 不是合法 JSON: ${err.message}`);
  }
}

function runCli(argv) {
  try {
    const flags = parseFlags(argv);
    let out;
    if (flags.ledger && flags.group) {
      out = renderPrHandoffFromLedger({
        ledgerPath: resolve(flags.ledger),
        group: flags.group,
        leadSessionId: flags['lead-session-id'],
        seq: Number(flags.seq),
        repo: flags.repo,
        title: flags.title,
        snapshot: flags.snapshot,
        why: flags.why,
        how: flags.how,
        excerpts: flags.excerpts ? parseJsonFlag(flags.excerpts, '--excerpts') : undefined,
      });
    } else {
      out = renderPrHandoff({
        packet: parseJsonFlag(flags.packet, '--packet'),
        identity: parseJsonFlag(flags.identity, '--identity'),
        leadSessionId: flags['lead-session-id'],
        seq: Number(flags.seq),
        repo: flags.repo,
        title: flags.title,
        snapshot: flags.snapshot,
        why: flags.why,
        how: flags.how,
        excerpts: flags.excerpts ? parseJsonFlag(flags.excerpts, '--excerpts') : undefined,
      });
    }
    process.stdout.write(out);
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`render-pr-handoff: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`render-pr-handoff: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`render-pr-handoff: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}
