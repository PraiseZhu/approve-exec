#!/usr/bin/env node
// render-pr-handoff.mjs — 用户可见开工包。缺块、乱序、缺绝对路径 = 渲染失败，不得 create session。
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './lib/common.mjs';
import { LedgerError, readLedger, readExecutionManifest, assertManifestBound, findPacket, findGroupWave } from './run-ledger.mjs';
import {
  assertHandoffComplete, assertExcerpts, assertVerifyCmds, assertOwnerTitle,
} from './vnext-owner-contract.mjs';

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

export function renderPrHandoff({
  packet, identity, leadSessionId, seq, repo, title, snapshot,
  why, excerpts, how, forbiddenExtra, tableLine, executionPlanHash,
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
  const forbidden = [
    ...(packet.forbidden ?? []),
    ...(forbiddenExtra ?? []),
    '未读 goal / 未读 routing.json 不得开工',
    '不得改总表 / allowed_paths / base（只能 lead 走 replan）',
    '假设破裂必须 blocked 上报：仅指 SC、对外接口兼容、授权、跨 PR 依赖、allowed_paths 或 base 变化；现场摘录变化但域内等价实现可自决',
  ];

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
    ].join('\n')],
    ['2. 为什么改', whyLine || '本 PR 修一条用户能看见的失败。'],
    ['3. 不要重读也能开工的现场', excerptLines.map((e) => (typeof e === 'string' ? e : `${e.file}:${e.line} ${e.behavior}`)).join('\n')],
    ['4. 具体改法', howLine],
    ['5. allowed_paths', packet.allowed_paths.map((p) => `- ${p}`).join('\n')],
    ['6. SC 全文', scLines.join('\n')],
    ['7. 验证命令', packet.verify_cmds.join('\n')],
    ['8. 做完之后（自动，不要问 lead）', [
      'candidate 只是检查点，不是终点。同一 owner 继续到机器可证明的 PR Ready，并由 lead 在终点验收。',
      'goal 场景 C 的 SC PASS 只是子阶段完成，不是 owner 整体任务完成。仅当所有 SC 都有 PASS 证据且没有 hard_stop、预算暂停或 blocked 时，才正常返回同一 owner 继续审查和 PR Ready 收尾；不得通过切换阶段绕过停止条件。',
      '授权以本次任务已给出的来源、目标仓、分支和动作为准，开工包应注明；已明确授权的提交、推送、创建/更新目标 PR 直接执行，不重复请示。只有对应动作确实未获授权时才停下请求决定，PR Ready 终点本身不产生新增授权。',
      'goal 内 push／回帖仍要求投递消息中合法的独立行 OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY 声明，仅覆盖当前 PR 的普通 push 和回帖，不授权创建 PR 或 merge；这段说明不是授权声明，不得自行补造声明。',
      'mem-probe → 现读同一份 routing.json 再派 e2e / GPT 单审；结果只回 owner，不向 lead 请示。',
      '先确认本 session 可调用只读 sub、Orca start_team/create_worker/create_workers。派 worker 前显式 start_team({ worker_permission_mode: "bypassPermissions" })，读取返回值并确认仍为 bypassPermissions；缺能力或返回 auto 不得创建，不得把配置期望当实际权限。',
      `绝对路径: ${ROUTING_LIVE}`,
      '先跑 model-route show',
      snapshotNote,
      '可自决：不改变 SC、接口兼容、授权和跨 PR 依赖的域内实现选型；派 read-only sub / e2e / review worker；本机测试红和 review unresolved>0 在 allowed_paths 内修到绿；已授权的 feature branch push 与目标 PR create/update。',
      '429 / Too Many Requests 按 Retry-After 和现有预算在原路由等待重试，记录下一次唤醒；worker 崩溃先查原 worker 状态再恢复。创建失败结果不明时先查绑定，不盲目重复创建。只有 NO_PROVIDER_FOR_AGENT / PROVIDER_ROUTE_UNAVAILABLE / BUDGET_MODEL_REQUIRES_API_MODE 才按现读该档 fallbacks 换 provider、不换代次。每次实际降级写入 fallbacks_tried；未走降级保留空数组并说明原因，禁止空数组就问 lead。',
      '必须停（DECISION_REQUIRED，保留原 owner 绑定）：硬停六条；hash/身份自检失败；SC、接口兼容、授权或跨 PR 依赖发生变化；allowed_paths 不够；授权不足；已授权恢复策略和预算耗尽；连续 3 轮零增量。只发一条 decision_required，附已尝试动作和 fallbacks_tried，等 lead 一个决定后同一 owner 继续。等待期间保留任务状态、阻塞原因和唤醒条件，不报完成。',
      '按第⑩节提交 candidate 后继续已授权的本机验证、提交、普通 push 与 OPEN 非 draft PR 确认；本机 pr_ready 交 lead 验收全部 priority/SC。仅对应任务 lead 发 Mini 盯梢授权，Mini 用与本机 owner 完全一致的标题和每 PR 一个 session 修复云端 CI/review。接管后本机不追反馈；必要门禁和远端 head 均已确认。子 session 不合入；任何角色不得自动合并、启用 auto-merge 或调用 gh pr merge，只有用户对指定 PR 的当次明确授权才允许合并。',
    ].join('\n')],
    ['9. 禁做', forbidden.map((f) => `- ${f}`).join('\n')],
    ['10. 回报格式', [
      'candidate（检查点，不得含 pr_url）record-delivery exact: branch, tip_sha, scs, goal_skill_path, e2e, review, size_gate, fallbacks_tried',
      `goal_skill_path 必须是 ${GOAL_SKILL}`,
      'pr_ready note-event detail: group_id, pr_url, current_pr_head_sha, receipt（重新执行 confirm-pr-open 的真实回执路径；必须晚于 pr_opened，五分钟内）',
      'decision_required 人读报告：本组/当前 head、阻塞事实、已尝试动作、fallbacks_tried、唯一待决问题、选项和建议；不是另造 ledger schema',
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
  return renderPrHandoff({
    executionPlanHash: ledger.pr_plan?.plan_hash,
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
