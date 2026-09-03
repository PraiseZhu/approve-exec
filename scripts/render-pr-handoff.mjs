#!/usr/bin/env node
// render-pr-handoff.mjs — 用户可见开工包。缺块、乱序、缺绝对路径 = 渲染失败，不得 create session。
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LedgerError, readLedger, readManifest, assertManifestBound, findPacket, findGroupWave } from './run-ledger.mjs';

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

export function renderPrHandoff({
  packet, identity, leadSessionId, seq, repo, title, snapshot,
  why, excerpts, how, forbiddenExtra, tableLine,
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
  if (!Array.isArray(packet.allowed_paths) || packet.allowed_paths.some((p) => typeof p !== 'string' || p.endsWith('/'))) {
    throw new LedgerError('PACKET_INCOMPLETE', 'allowed_paths 只列文件，禁止目录');
  }
  if (!Array.isArray(packet.scs_inline) || packet.scs_inline.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'scs_inline 必须非空');
  }
  if (!Array.isArray(packet.verify_cmds) || packet.verify_cmds.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'verify_cmds 必须非空');
  }

  const gate = gateBlock0();
  if (!gate.includes('用 goal skill 执行。')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工闸第 0 块必须含「用 goal skill 执行。」');
  }

  const whyLine = why ?? (typeof packet.instruction === 'string' ? packet.instruction.split('\n').find((l) => l.trim()) : '') ?? '';
  const excerptLines = Array.isArray(excerpts) && excerpts.length > 0
    ? excerpts
    : ['（本包未附摘录：子 session 仍须按 allowed_paths 开工，禁止 Grep 整模块。）'];
  const howLine = how ?? packet.instruction ?? '';
  const forbidden = [
    ...(packet.forbidden ?? []),
    ...(forbiddenExtra ?? []),
    '未读 goal / 未读 routing.json 不得开工',
    '不得改总表 / allowed_paths / base（只能 lead 走 replan）',
    '假设破裂必须 blocked 上报，禁止就地改方案',
  ];

  const scLines = packet.scs_inline.map((sc) => {
    const id = sc.id;
    const change = sc.change ?? '';
    const holds = sc.holds ?? '';
    const expect = sc.expect ?? '';
    const anchors = Array.isArray(sc.anchor_paths) ? sc.anchor_paths.join(', ') : (packet.allowed_paths ?? []).join(', ');
    return `- id=${id}\n  change=${change}\n  holds=${holds}\n  expect=${expect}\n  anchor_paths=${anchors}`;
  });

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
      'mem-probe → 现读同一份 routing.json 再派 e2e / GPT 单审',
      `绝对路径: ${ROUTING_LIVE}`,
      '先跑 model-route show',
      snapshotNote,
      '按第⑩节 candidate 交卷 jump 回报 → 停等验收。验收前不开远端 PR。子 session 不合入。lead jump 开远端之后先注册 Mini 名册，再 wrapup-cleanup。',
    ].join('\n')],
    ['9. 禁做', forbidden.map((f) => `- ${f}`).join('\n')],
    ['10. 回报格式', [
      'candidate record-delivery exact: branch, tip_sha, scs, goal_skill_path, e2e, review, size_gate（不得含 pr_url）',
      `goal_skill_path 必须是 ${GOAL_SKILL}`,
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
  return out;
}

export function renderPrHandoffFromLedger({ ledgerPath, group, leadSessionId, seq, repo, title, snapshot, now }) {
  const ledger = readLedger(ledgerPath);
  const manifest = readManifest(ledger.manifest_path);
  assertManifestBound(ledger, manifest, 'render-pr-handoff');
  const packet = findPacket(manifest, group);
  const wave = findGroupWave(ledger, group);
  const wg = wave.groups.find((g) => g.group_id === group);
  const identity = { worktree: wg.worktree, branch: wg.branch, base: wg.base };
  return renderPrHandoff({
    packet, identity, leadSessionId, seq, repo, title, snapshot,
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
