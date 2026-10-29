#!/usr/bin/env node
// selfcheck.mjs — approve-exec 派会话前的 fail-closed 环境自检（机器化前置）。
//
// 检查（exact 枚举，逐项独立报告，不因前项失败跳过后项）：
//   ① goal skill：SKILL.md 存在（config.goalSkillRoot）；它也是 ② a 推导 live 链接位置的锚点。
//   ② --live 模式追加两处接线检查：
//      a. skills/claude-active/approve-exec symlink 指向 approve-exec 仓根（realpath 含 SKILL.md
//         + 同一 git common dir 或同一 origin + show-toplevel 严格等于 target 自身——
//         工程仓与 live 是两份独立 clone，common dir 不同不算接线错误；嵌套子目录不能冒充仓根）；
//      b. config.skillTriggerScanPath 指向的文件含「批准执行」触发行（整行逐字匹配；
//         路径来自 config 而非硬编码——改动触发词规则文件位置只改 config，不改脚本）。
//
// 输出与退出：逐项 PASS/FAIL 行；任一 FAIL → 汇总点名（exit 2）；全过 → exit 0。
//
// CLI: node scripts/selfcheck.mjs [--live]
// 只依赖 node 内置模块；路径一律来自 config，不写死。
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 「批准执行」触发行原文（整行逐字匹配，防描述被改写后入口失效）；2026-10-29 改为 issue 入口（PraiseZhu/approve-exec#69）
export const TRIGGER_LINE = '| 批准执行 | `approve-exec` | 直接执行不确认。接在「开 issue」之后：吃总 issue（或独立 issue / 单个子 issue），缺模板 fail-closed 指路「开 issue」；lead 按并行/串行原则给每个子 issue 开一个独立会话（1 子 issue = 1 PR = 1 会话），派会话不带模型参数；owner 用 KEEL 的 keel_run 推进到验收点写 checkpoint，零 token 续跑脚本叫醒 lead；lead 跑 accept-check 后判通过或要改（最多 2 轮），通过后交接车道才转 Ready，Ready 后清本地并归档会话，依赖合入后开下一批。本 skill 不合入 |';
// LIVE_LINK 推导：从 config.goalSkillRoot 派生 —— dirname(goalSkillRoot) 即 skills/claude-active 目录，
// approve-exec 与 goal 同处该目录（skills 目录内 symlink）。
// 禁止按仓库在磁盘上的嵌套深度猜层级（'../..' 相对 root）：主 checkout（approve-exec-src）与 worktree
// （approve-exec-worktrees/g2）深度不同，相对层级推导必然在其中一个 checkout 上拼错路径
// （V 阶段集成暴露：g2 上恰好绿、主 checkout 上 live-symlink FAIL）。
// 选 config 派生而非新增显式配置键：① 锚点 goalSkillRoot 已被检查①（goal-skill-md）独立验证，
//   锚点错时③会先红——显式新键反而无人验证其自身；② 不加键即零配置漂移面，claude-active 整体迁移时自动跟随。
// root 参数仅作测试注入（组B-2 用不同嵌套深度的 root 反证推导与仓库深度无关），正式实现不读它。
export function deriveLiveLink(config, root) {
  return join(dirname(config.goalSkillRoot), 'approve-exec');
}

// ---------- CLI 解析 ----------
function parseArgs(argv) {
  const args = { live: false };
  for (const a of argv) {
    if (a === '--live') {
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

// 必须是常规文件：existsSync 对同名目录也返回 true，会放行"目录冒充脚本/SKILL.md"。
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// git 仓库同一性：--git-common-dir 解析到绝对路径（worktree 与主 checkout 共享同一 common dir）。
// 输出可能是相对路径（如 .git），先按运行目录 resolve 再 realpath 归一。
function gitCommonDir(dir) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  const resolved = resolve(dir, r.stdout.trim());
  try { return realpathSync(resolved); } catch { return resolved; }
}

// git 仓库根：--show-toplevel 解析为 realpath。common-dir 只证明「同一仓库」，
// 证明不了 target 本身是仓根——仓内任意带 SKILL.md 的嵌套子目录都能与 root 共享 common dir。
// target 必须是仓根本身（接线位点 exact 前置），否则「检查不到却当通过」。
function gitTopLevel(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  try { return realpathSync(r.stdout.trim()); } catch { return null; }
}

// origin 归一：git@ / https / ssh 三种写法收成 host/owner/repo（小写、去 .git）。
// 工程仓与 live 是两份独立 clone，common dir 必然不同；同一 GitHub 仓即接线正确。
export function normalizeGitHubOrigin(url) {
  let s = String(url).trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  let m = s.match(/^git@([^:]+):(.+)$/i);
  if (m) return `${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '').toLowerCase()}`;
  m = s.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/i);
  if (m) return `${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '').toLowerCase()}`;
  m = s.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (m) return `${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '').toLowerCase()}`;
  return s.toLowerCase();
}

function gitOriginIdentity(dir) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  return normalizeGitHubOrigin(r.stdout.trim());
}

function sameRepoIdentity(mineRoot, target) {
  const mineCommon = gitCommonDir(mineRoot);
  const theirsCommon = gitCommonDir(target);
  if (mineCommon && theirsCommon && mineCommon === theirsCommon) return { ok: true, via: 'common-dir' };
  const mineOrigin = gitOriginIdentity(mineRoot);
  const theirsOrigin = gitOriginIdentity(target);
  if (mineOrigin && theirsOrigin && mineOrigin === theirsOrigin) return { ok: true, via: 'origin' };
  return { ok: false, via: null };
}

// ---------- ① goal skill ----------
function checkGoalSkill(config, items) {
  const p = join(config.goalSkillRoot, 'SKILL.md');
  const ok = isFile(p);
  items.push({ id: 'goal-skill-md', ok, detail: ok ? p : `不存在或非文件: ${p}` });
}

// ---------- ② --live：接线两处 ----------
// 导出以便测试注入（组B-4 负向/正向夹具）：liveLink 是待验 symlink 路径，mineRoot 是「本仓」一侧。
// 三段判据（加强不是替换，任一段 FAIL 即拒）：
//   ① target 含 SKILL.md 文件（目标确实是 skill 目录）；
//   ② target 与 mineRoot 同一 git common dir，或同一 origin（工程仓 / live 双份 clone 走 origin）；
//   ③ target 自身就是仓根——realpath(--show-toplevel) 严格等于 target 自身 realpath
//     （防「仓内任意带 SKILL.md 的嵌套子目录冒充仓根」：common dir / origin 同源拦不住它）。
export function checkLiveSymlink(liveLink, mineRoot, items) {
  let st;
  try {
    st = lstatSync(liveLink);
  } catch {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 不存在: ${liveLink}` });
    return;
  }
  if (!st.isSymbolicLink()) {
    items.push({ id: 'live-symlink', ok: false, detail: `${liveLink} 不是 symlink` });
    return;
  }
  let target;
  try {
    target = realpathSync(liveLink);
  } catch (e) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 解析失败: ${liveLink}（${e.message}）` });
    return;
  }
  if (!isFile(join(target, 'SKILL.md'))) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 目标 ${target} 不含 SKILL.md 文件（不是 approve-exec 本仓）` });
    return;
  }
  const ident = sameRepoIdentity(mineRoot, target);
  if (!ident.ok) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 目标 ${target} 不是 approve-exec 仓（git common dir 与 origin 都不一致）` });
    return;
  }
  const top = gitTopLevel(target);
  if (!top || top !== target) {
    items.push({ id: 'live-symlink', ok: false, detail: `symlink 目标 ${target} 不是本仓 checkout 根目录（git top-level 为 ${top ?? '不可解析'}）` });
    return;
  }
  const via = ident.via === 'origin' ? '同源 origin' : '同源 git common dir';
  items.push({ id: 'live-symlink', ok: true, detail: `${liveLink} → ${target}（仓根，${via}）` });
}

// 路径来自 config.skillTriggerScanPath（配置键化：触发词规则文件位置变更只改 config，
// 脚本不写死用户主目录下的具体路径；~ 前缀经 expandHome 展开，与 runLedgerDir 同款处理）。
// 导出以便测试注入任意路径（组B-6 用不存在路径/含触发行临时文件正反验证读取点）。
export function checkTriggerLine(config, items) {
  if (!process.env.HOME) {
    items.push({ id: 'live-trigger-line', ok: false, detail: 'HOME 未设置，无法展开 ~ 路径' });
    return;
  }
  const file = expandHome(config.skillTriggerScanPath);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    items.push({ id: 'live-trigger-line', ok: false, detail: `不可读: ${file}（${e.message}）` });
    return;
  }
  // 整行逐字匹配：includes 子串匹配会被"改写过但仍含原文前缀"的行蒙混通过
  if (text.split(/\r?\n/).includes(TRIGGER_LINE)) {
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
  const requiredKeys = ['goalSkillRoot', 'skillTriggerScanPath'];
  const missingKeys = requiredKeys.filter((k) => typeof config[k] !== 'string' || config[k].length === 0);
  if (missingKeys.length > 0) {
    console.error(`selfcheck: config 缺必备路径键: ${missingKeys.join(', ')}`);
    process.exit(2);
  }

  const items = [];
  checkGoalSkill(config, items);
  if (args.live) {
    checkLiveSymlink(deriveLiveLink(config, root), root, items);
    checkTriggerLine(config, items);
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

// main-module guard：作为 CLI 入口才执行主流程；被测试 import（组B-2 注入 root 调 deriveLiveLink）时静默返回。
// import.meta.url 已被 ESM loader 规范化（symlink/逻辑路径解析后的真实路径），而 process.argv[1] 是调用方原样
// 路径——macOS 上 /var → /private/var 这类 symlink 会让两者恒不相等，main 静默不执行（exit 0 + 零输出，
// 与全 PASS 长得一模一样，自检直接变假）。必须先用 realpathSync 归一 argv[1] 再比较；realpath 失败 fail-closed。
let entryReal;
try {
  entryReal = realpathSync(process.argv[1]);
} catch (e) {
  console.error(`selfcheck: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
  process.exit(2);
}
if (import.meta.url === pathToFileURL(entryReal).href) {
  main();
}
