#!/usr/bin/env node
// selfcheck.mjs — approve-exec 派工前 A 类 fail-closed 环境自检（机器化前置）。
//
// 五类检查（exact 枚举，逐项独立报告，不因前项失败跳过后项）：
//   ① routing（routing.json）：文件存在可读可解析；execute/review/e2e/pr_merge 四档齐；
//      各档 agent/model/effort 非空字符串；agent ∈ {codex, claude-code}；effort ∈ 六枚举。
//   ② orca-fanout：worktree-ledger.mjs / worktree-reclaim.mjs 存在（config.orcaFanoutScriptsRoot）。
//   ③ goal skill：SKILL.md 存在（config.goalSkillRoot）。
//   ④ runLedgerDir：可创建可写（mkdir -p + 探针文件写入/读回/清理；~ 经 HOME 展开）。
//   ⑤ --live 模式追加两处接线检查：
//      a. skills/claude-active/approve-exec symlink 指向本仓（realpath 含 SKILL.md + git common dir 同源）；
//      b. ~/.claude/rules/skill-trigger-scan.md 含「批准执行」触发行（整行逐字匹配）。
//
// 输出与退出：逐项 PASS/FAIL 行；任一 FAIL → 汇总点名（exit 2）；全过 → exit 0。
//
// CLI: node scripts/selfcheck.mjs [--live] [--routing-file <path>]
//   --routing-file 仅测试注入（夹具）；缺省读 config.defaults.json 的 routingPath。
// 只依赖 node 内置模块；路径一律来自 config，不写死。
import { readFileSync, existsSync, lstatSync, realpathSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const AGENTS = ['codex', 'claude-code'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ROUTES = ['execute', 'review', 'e2e', 'pr_merge'];
// sc-p2c change ② 的触发行原文（整行逐字匹配，防描述被改写后入口失效）
const TRIGGER_LINE = '| 批准执行 | `approve-exec` | 直接执行不确认。只吃 task-priority final manifest，缺输入 fail-closed 指路 |';
// selfcheck 所在仓相对于 skills/claude-active 的接线位置（与 task-priority 同款：skills 目录内 symlink）
const LIVE_LINK = resolve(root, '../../skills/claude-active/approve-exec');

// ---------- CLI 解析 ----------
function parseArgs(argv) {
  const args = { routingFile: null, live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--routing-file') {
      const v = argv[++i];
      if (v === undefined) { console.error('selfcheck: --routing-file 缺参数值'); process.exit(2); }
      args.routingFile = v;
    } else if (a === '--live') {
      args.live = true;
    } else {
      console.error(`selfcheck: 未知参数 ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function expandHome(p) {
  return p.startsWith('~/') ? join(process.env.HOME, p.slice(2)) : p;
}

// git 仓库同一性：--git-common-dir 解析到绝对路径（worktree 与主 checkout 共享同一 common dir）。
// 输出可能是相对路径（如 .git），先按运行目录 resolve 再 realpath 归一。
function gitCommonDir(dir) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  const resolved = resolve(dir, r.stdout.trim());
  try { return realpathSync(resolved); } catch { return resolved; }
}

// ---------- ① routing ----------
function checkRouting(routingFile, items) {
  let text;
  try {
    text = readFileSync(routingFile, 'utf8');
  } catch (e) {
    items.push({ id: 'routing-file', ok: false, detail: `读取失败: ${routingFile}（${e.message}）` });
    return;
  }
  let routing;
  try {
    routing = JSON.parse(text);
  } catch (e) {
    items.push({ id: 'routing-parse', ok: false, detail: `JSON 解析失败: ${routingFile}（${e.message}）` });
    return;
  }
  items.push({ id: 'routing-file', ok: true, detail: routingFile });
  for (const route of ROUTES) {
    const r = routing[route];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      items.push({ id: `routing-${route}`, ok: false, detail: `${route} 档缺失（routing.json 无该档）` });
      continue;
    }
    const violations = [];
    for (const field of ['agent', 'model', 'effort']) {
      if (typeof r[field] !== 'string' || r[field].length === 0) violations.push(`${field} 空/缺失`);
    }
    if (typeof r.agent === 'string' && r.agent.length > 0 && !AGENTS.includes(r.agent)) {
      violations.push(`agent=${r.agent} 不在 {${AGENTS.join(', ')}}`);
    }
    if (typeof r.effort === 'string' && r.effort.length > 0 && !EFFORTS.includes(r.effort)) {
      violations.push(`effort=${r.effort} 不在 {${EFFORTS.join(', ')}}`);
    }
    if (violations.length > 0) {
      items.push({ id: `routing-${route}`, ok: false, detail: `${route} 档: ${violations.join('; ')}` });
    } else {
      items.push({ id: `routing-${route}`, ok: true, detail: `${route} 档 agent/model/effort 齐全且枚举合法` });
    }
  }
}

// ---------- ② orca-fanout 脚本 ----------
function checkOrcaFanoutScripts(config, items) {
  for (const f of ['worktree-ledger.mjs', 'worktree-reclaim.mjs']) {
    const p = join(config.orcaFanoutScriptsRoot, f);
    const ok = existsSync(p);
    items.push({ id: `orca-fanout-${f.replace(/\.mjs$/, '')}`, ok, detail: ok ? p : `不存在: ${p}` });
  }
}

// ---------- ③ goal skill ----------
function checkGoalSkill(config, items) {
  const p = join(config.goalSkillRoot, 'SKILL.md');
  const ok = existsSync(p);
  items.push({ id: 'goal-skill-md', ok, detail: ok ? p : `不存在: ${p}` });
}

// ---------- ④ runLedgerDir 可创建可写 ----------
function checkRunLedgerDir(config, items) {
  if (!process.env.HOME) {
    items.push({ id: 'run-ledger-dir', ok: false, detail: 'HOME 未设置，无法展开 ~ 路径' });
    return;
  }
  const dir = expandHome(config.runLedgerDir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    items.push({ id: 'run-ledger-dir', ok: false, detail: `不可创建: ${dir}（${e.message}）` });
    return;
  }
  const probe = join(dir, `.selfcheck-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'probe');
    readFileSync(probe, 'utf8');
    unlinkSync(probe);
    items.push({ id: 'run-ledger-dir', ok: true, detail: `${dir} 可创建可写（探针已清理）` });
  } catch (e) {
    items.push({ id: 'run-ledger-dir', ok: false, detail: `不可写: ${dir}（${e.message}）` });
  }
}

// ---------- ⑤ --live：接线两处 ----------
function checkLiveSymlink(items) {
  let st;
  try {
    st = lstatSync(LIVE_LINK);
  } catch {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 不存在: ${LIVE_LINK}` });
    return;
  }
  if (!st.isSymbolicLink()) {
    items.push({ id: 'live-symlink', ok: false, detail: `${LIVE_LINK} 不是 symlink` });
    return;
  }
  let target;
  try {
    target = realpathSync(LIVE_LINK);
  } catch (e) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 解析失败: ${LIVE_LINK}（${e.message}）` });
    return;
  }
  if (!existsSync(join(target, 'SKILL.md'))) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 目标 ${target} 不含 SKILL.md（不是 approve-exec 本仓）` });
    return;
  }
  const mine = gitCommonDir(root);
  const theirs = gitCommonDir(target);
  if (!mine || !theirs || mine !== theirs) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 目标 ${target} 不是 approve-exec 本仓 checkout（git common dir 不一致）` });
    return;
  }
  items.push({ id: 'live-symlink', ok: true, detail: `${LIVE_LINK} → ${target}（本仓 checkout）` });
}

function checkTriggerLine(items) {
  if (!process.env.HOME) {
    items.push({ id: 'live-trigger-line', ok: false, detail: 'HOME 未设置，无法定位 ~/.claude/rules/skill-trigger-scan.md' });
    return;
  }
  const file = expandHome('~/.claude/rules/skill-trigger-scan.md');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    items.push({ id: 'live-trigger-line', ok: false, detail: `不可读: ${file}（${e.message}）` });
    return;
  }
  if (text.includes(TRIGGER_LINE)) {
    items.push({ id: 'live-trigger-line', ok: true, detail: `${file} 含「批准执行」触发行` });
  } else {
    items.push({ id: 'live-trigger-line', ok: false, detail: `${file} 缺「批准执行」触发行` });
  }
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));

  const configPath = join(root, 'config/defaults.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`selfcheck: config 不可读或不可解析（${configPath}）: ${e.message}`);
    process.exit(2);
  }
  const requiredKeys = ['routingPath', 'goalSkillRoot', 'orcaFanoutScriptsRoot', 'runLedgerDir'];
  const missingKeys = requiredKeys.filter((k) => typeof config[k] !== 'string' || config[k].length === 0);
  if (missingKeys.length > 0) {
    console.error(`selfcheck: config 缺必备路径键: ${missingKeys.join(', ')}`);
    process.exit(2);
  }

  const routingFile = args.routingFile !== null ? resolve(args.routingFile) : config.routingPath;

  const items = [];
  checkRouting(routingFile, items);
  checkOrcaFanoutScripts(config, items);
  checkGoalSkill(config, items);
  checkRunLedgerDir(config, items);
  if (args.live) {
    checkLiveSymlink(items);
    checkTriggerLine(items);
  }

  for (const item of items) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}: ${item.id}: ${item.detail}`);
  }
  const failed = items.filter((i) => !i.ok);
  if (failed.length > 0) {
    console.error(`selfcheck: ${failed.length} 项 FAIL（${failed.map((i) => i.id).join(', ')}），exit 2`);
    process.exit(2);
  }
  console.log('selfcheck: 全部检查通过（exit 0）');
}

main();
