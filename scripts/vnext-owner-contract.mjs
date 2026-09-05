#!/usr/bin/env node
// vNext owner 契约（skill 侧可独立落地的机器闸）。
// 终稿：docs/2026-09-04-0904-approve-exec-final.md
// 本模块不改旧 ledger GROUP_STATES 语义；缺宿主 create gateway 时 fail-closed。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { LedgerError } from './run-ledger.mjs';

export const CONTRACT_VERSION = 'vnext-owner-pr-ready-1';

// 旧台账组状态保持 legacy 语义，不得原地改名冒充 PR Ready。
export const LEGACY_GROUP_STATES = Object.freeze([
  'pending', 'dispatched', 'executing', 'blocked', 'e2e', 'review',
  'accepted', 'pr-open', 'local-cleaned', 'archived', 'failed',
]);

// per-PR owner 目标态。accepted 仍解释为 CANDIDATE_ACCEPTED，不是终点。
export const OWNER_STATES = Object.freeze([
  'HANDOFF_VALIDATED',
  'EXECUTING',
  'LOCAL_VALIDATED',
  'CANDIDATE_SUBMITTED',
  'CANDIDATE_ACCEPTED',
  'PR_OPEN',
  'CI_REVIEW_LOOP',
  'PR_READY',
  'DECISION_REQUIRED',
]);

export const HAN_RE = /\p{Script=Han}/u;
export const TITLE_RE = /^.+-.+丨 \d{4}$/;
export const PLACEHOLDER_EXCERPT_RE = /本包未附摘录/;
export const WAIT_FOR_LEAD_RE = /停等验收|(?<!禁止)(?<!不得)(?<!不要)等 lead 放行|(?<!禁止)(?<!不得)等 lead 对账|是否开始|先停着|请重新理解任务|等 lead jump|限流解除后再开 review|B 类 fail-closed|B 类停问/;
export const FALLBACK_REQUIRED_RE = /fallbacks|换 provider|不换代次/;
export const GH_PR_DIFF_RE = /\bgh\s+pr\s+diff\b/i;
const STRING_EXCERPT_RE = /^(\S+):(\d+)\s+(\S.*)$/;

export const SECTION_TITLES = Object.freeze([
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

// Cindy host create gateway 尚未提供原子 handoff 绑定。skill 仓不得假装已通。
export const HOST_CREATE_GATEWAY = Object.freeze({
  available: false,
  reason: '宿主无幂等 create；旧入口只支持 --dry-run 预览。真实路径用 owner-dispatch 的 skill 单次 claim，未知回执不重派',
});

export function handoffHash(text) {
  if (typeof text !== 'string') {
    throw new LedgerError('PACKET_INCOMPLETE', 'handoffHash 需要字符串正文');
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function assertTaskHasHan(task, what = '任务名') {
  if (typeof task !== 'string' || task.trim().length === 0) {
    throw new LedgerError('ARGS', `${what} 必须是非空字符串`);
  }
  if (!HAN_RE.test(task)) {
    throw new LedgerError('ARGS', `${what} 必须含至少一个汉字（当前: ${task}）`);
  }
  return task;
}

export function assertOwnerTitle(title) {
  if (typeof title !== 'string' || !TITLE_RE.test(title)) {
    throw new LedgerError('ARGS', `title 必须是 {项目名}-{中文任务名}丨 {MMDD}（当前: ${title}）`);
  }
  const sep = title.lastIndexOf('丨 ');
  const left = sep >= 0 ? title.slice(0, sep) : title;
  const dash = left.indexOf('-');
  if (dash < 1 || dash === left.length - 1) {
    throw new LedgerError('ARGS', `title 必须是 {项目名}-{中文任务名}丨 {MMDD}（当前: ${title}）`);
  }
  const task = left.slice(dash + 1);
  assertTaskHasHan(task, 'title 任务段');
  if (/^[pgv]\d+$/i.test(task) || /^(probe|verify)-/i.test(task)) {
    throw new LedgerError('ARGS', `title 任务段禁止只写 group/SC 机器 id（当前: ${title}）`);
  }
  return title;
}

export function assertCreateGatewayOrFailClosed({ dryRun = false, available = HOST_CREATE_GATEWAY.available } = {}) {
  if (dryRun) return { ok: true, mode: 'dry-run' };
  if (!available) {
    throw new LedgerError(
      'HOST_GATEWAY_MISSING',
      `缺宿主 create gateway，不得真派 owner session。${HOST_CREATE_GATEWAY.reason}`,
    );
  }
  return { ok: true, mode: 'create' };
}

function sectionBody(text, title) {
  const start = text.indexOf(`## ${title}`);
  if (start < 0) return '';
  const after = start + `## ${title}`.length;
  const next = text.indexOf('\n## ', after);
  return text.slice(after, next < 0 ? text.length : next).trim();
}

function assertExcerptFile(file, line, worktree) {
  if (typeof worktree !== 'string' || worktree.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 3 段核摘录需要 identity.worktree');
  }
  if (!existsSync(worktree)) {
    throw new LedgerError('PACKET_INCOMPLETE', `第 3 段 worktree 不存在，无法核摘录（${worktree}）`);
  }
  const abs = isAbsolute(file) ? file : join(worktree, file);
  if (!existsSync(abs)) {
    throw new LedgerError('PACKET_INCOMPLETE', `第 3 段摘录文件不存在: ${file}`);
  }
  const rel = relative(realpathSync(worktree), realpathSync(abs));
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !statSync(abs).isFile()) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 3 段摘录必须是仓内真实文件，禁止越界或目录');
  }
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  if (line > lines.length) {
    throw new LedgerError('PACKET_INCOMPLETE', `第 3 段摘录行号超出文件: ${file}:${line}`);
  }
}

export function assertExcerpts(excerpts, { worktree } = {}) {
  if (!Array.isArray(excerpts) || excerpts.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 3 段至少 1 条真摘录（file + line + behavior），禁止占位');
  }
  for (const e of excerpts) {
    let file;
    let line;
    let behavior;
    if (typeof e === 'string') {
      if (PLACEHOLDER_EXCERPT_RE.test(e) || e.trim().length === 0) {
        throw new LedgerError('PACKET_INCOMPLETE', '第 3 段禁止占位句「本包未附摘录」');
      }
      const m = e.trim().match(STRING_EXCERPT_RE);
      if (!m) {
        throw new LedgerError('PACKET_INCOMPLETE', `第 3 段摘录必须是 file:line 加行为说明（当前: ${e}）`);
      }
      file = m[1];
      line = Number(m[2]);
      behavior = m[3];
    } else if (e && typeof e === 'object') {
      file = e.file;
      line = e.line;
      behavior = e.behavior;
    } else {
      throw new LedgerError('PACKET_INCOMPLETE', '第 3 段摘录必须是字符串或 {file,line,behavior}');
    }
    if (typeof file !== 'string' || file.length === 0) {
      throw new LedgerError('PACKET_INCOMPLETE', '第 3 段摘录缺 file');
    }
    if (!Number.isSafeInteger(line) || line < 1) {
      throw new LedgerError('PACKET_INCOMPLETE', `第 3 段摘录 line 必须是正整数（当前: ${line}）`);
    }
    if (typeof behavior !== 'string' || behavior.trim().length === 0) {
      throw new LedgerError('PACKET_INCOMPLETE', '第 3 段摘录缺 behavior');
    }
    assertExcerptFile(file, line, worktree);
  }
}

export function assertVerifyCmds(cmds) {
  if (!Array.isArray(cmds) || cmds.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'verify_cmds 必须非空');
  }
  const runnable = cmds.filter((c) => typeof c === 'string' && c.trim() && !GH_PR_DIFF_RE.test(c));
  if (runnable.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 7 段必须含本仓可复制测试/脚本命令，禁止只用 gh pr diff');
  }
}

export function assertHandoffComplete(text, { why, how, excerpts, verify_cmds, title, worktree } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', 'handoff 正文不能为空');
  }
  if (WAIT_FOR_LEAD_RE.test(text)) {
    throw new LedgerError('PACKET_INCOMPLETE', 'handoff 禁止「停等验收 / 等 lead 放行 / 是否开始」');
  }
  if (PLACEHOLDER_EXCERPT_RE.test(text)) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 3 段禁止占位句「本包未附摘录」');
  }
  for (const t of SECTION_TITLES) {
    if (!text.includes(`## ${t}`)) {
      throw new LedgerError('PACKET_INCOMPLETE', `开工包缺块: ${t}`);
    }
  }
  const headings = text.split('\n').filter((line) => /^## \d+\./.test(line));
  if (headings.join('|') !== SECTION_TITLES.map((t) => '## ' + t).join('|')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包 0–10 必须各出现一次且顺序正确');
  }
  for (const heading of SECTION_TITLES) if (!sectionBody(text, heading)) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包空段: ' + heading);
  }
  if (title) assertOwnerTitle(title);
  if (excerpts) assertExcerpts(excerpts, { worktree });
  if (verify_cmds) assertVerifyCmds(verify_cmds);
  const whyBody = why ?? sectionBody(text, '2. 为什么改');
  const howBody = how ?? sectionBody(text, '4. 具体改法');
  if (typeof howBody === 'string' && typeof whyBody === 'string' && howBody.trim() === whyBody.trim()) {
    throw new LedgerError('PACKET_INCOMPLETE', '第 4 段必须是改法，不得复制第 2 段禁令/原因');
  }
  if (!text.includes('PR Ready') && !text.includes('PR_READY')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包必须声明责任终点是 PR Ready');
  }
  if (!text.includes('可自决') || !text.includes('必须停')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包必须含「可自决」与「必须停」表');
  }
  if (!text.includes('candidate') || !text.includes('检查点')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包必须声明 candidate 只是检查点');
  }
  const section8 = sectionBody(text, '8. 做完之后（自动，不要问 lead）');
  const fallbackNeedles = ['429', '崩溃', '创建失败', 'fallbacks', '换 provider', '不换代次', 'fallbacks_tried'];
  const missingFallback = fallbackNeedles.filter((n) => !section8.includes(n));
  if (missingFallback.length > 0 || !FALLBACK_REQUIRED_RE.test(section8)) {
    throw new LedgerError(
      'PACKET_INCOMPLETE',
      `开工包第 8 段必须声明 429/崩溃/创建失败按 routing.json fallbacks 换 provider、不换代次，并写入 fallbacks_tried（缺: ${missingFallback.join('/') || 'fallbacks 语义'}）`,
    );
  }
  if (/fallbacks_tried:\s*\[\s*\]/.test(section8) && !section8.includes('禁止空数组')) {
    throw new LedgerError('PACKET_INCOMPLETE', '开工包第 8 段禁止把空 fallbacks_tried 写成可问 lead 的路径');
  }
  return { ok: true, handoff_hash: handoffHash(text), contract: CONTRACT_VERSION };
}

export function mmddFromDate(d = new Date()) {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

export function watchTaskName(prNumber, task) {
  if (typeof task === 'string' && task.trim().length > 0) {
    assertTaskHasHan(task.trim(), '盯梢任务名');
    return task.trim();
  }
  if (!Number.isSafeInteger(Number(prNumber)) && typeof prNumber !== 'string') {
    throw new LedgerError('ARGS', '盯梢任务名缺 prNumber');
  }
  return `盯梢修复${prNumber}`;
}
