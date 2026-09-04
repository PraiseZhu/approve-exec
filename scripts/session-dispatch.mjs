#!/usr/bin/env node
// session-dispatch.mjs — 独立 PI session 派发参数。
// --dry-run 写出将要 create 的 {title, working_dir, agent_kind, model, effort}，不调 send_to_session。
import { writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LedgerError } from './run-ledger.mjs';
import { assertOwnerTitle, assertCreateGatewayOrFailClosed } from './vnext-owner-contract.mjs';

const TITLE_RE = /^.+丨 \d{4}$/;
const REPO_PREFIX = Object.freeze({
  'xindong/mivo-canvas-plugin': 'MivoPlugin',
  'xindong/mivo-canvas': 'MivoCanvas',
  'makecindy/cindy': 'Cindy',
});

export function sessionTitle({ project, task, mmdd }) {
  if (typeof project !== 'string' || project.length === 0) {
    throw new LedgerError('ARGS', 'sessionTitle 缺 project');
  }
  if (typeof task !== 'string' || task.length === 0) {
    throw new LedgerError('ARGS', 'sessionTitle 缺 task');
  }
  if (!/^\d{4}$/.test(String(mmdd))) {
    throw new LedgerError('ARGS', `sessionTitle.mmdd 必须是 MMDD 四位（当前: ${mmdd}）`);
  }
  const title = `${project}-${task}丨 ${mmdd}`;
  assertOwnerTitle(title);
  return title;
}

export function titlePrefixForRepo(repo) {
  if (REPO_PREFIX[repo]) return REPO_PREFIX[repo];
  if (typeof repo === 'string' && repo.startsWith('Project ')) {
    return repo.slice('Project '.length);
  }
  if (typeof repo === 'string' && repo.includes('/')) {
    const name = repo.split('/').pop();
    return name;
  }
  return repo;
}

export function wouldCreate({ title, working_dir, agent_kind = 'pi', model = 'grok-4.6', effort = 'high' }) {
  if (typeof title !== 'string' || !TITLE_RE.test(title)) {
    throw new LedgerError('ARGS', `title 必须是 {项目名}-{中文任务名}丨 {MMDD}（当前: ${title}）`);
  }
  assertOwnerTitle(title);
  if (typeof working_dir !== 'string' || !working_dir.startsWith('/')) {
    throw new LedgerError('ARGS', `working_dir 必须是绝对路径（当前: ${working_dir}）`);
  }
  if (agent_kind !== 'pi') {
    throw new LedgerError('ARGS', `agent_kind 必须是 pi（当前: ${agent_kind}）`);
  }
  if (model !== 'grok-4.6') {
    throw new LedgerError('ARGS', `model 必须是 grok-4.6（当前: ${model}）`);
  }
  if (effort !== 'high') {
    throw new LedgerError('ARGS', `effort 必须是 high（当前: ${effort}）`);
  }
  return {
    title,
    working_dir,
    agent_kind,
    model,
    effort,
    use_worktree: true,
  };
}

export function artPinSteps(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new LedgerError('ARGS', 'artPinSteps 缺 session_id');
  }
  return [
    { tool: 'get_session_runtime', args: { session_id: sessionId } },
    { tool: 'set_session_runtime', args: { session_id: sessionId, provider_id: 'art', expected_generation: '<from get>' } },
    { tool: 'get_session_runtime', args: { session_id: sessionId }, assert: 'effective.provider_id === "art"' },
  ];
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') { flags['dry-run'] = true; continue; }
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const key = a.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new LedgerError('ARGS', `参数 --${key} 缺值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function runCli(argv) {
  try {
    const flags = parseFlags(argv);
    const created = wouldCreate({
      title: flags.title,
      working_dir: flags['working-dir'],
      agent_kind: flags['agent-kind'] ?? 'pi',
      model: flags.model ?? 'grok-4.6',
      effort: flags.effort ?? 'high',
    });
    assertCreateGatewayOrFailClosed({ dryRun: Boolean(flags['dry-run']) });
    if (!flags['dry-run']) {
      throw new LedgerError('HOST_GATEWAY_MISSING', '真派必须等宿主 create gateway；本脚本只支持 --dry-run');
    }
    const out = flags.out ? resolve(flags.out) : null;
    const json = `${JSON.stringify(created, null, 2)}\n`;
    if (out) writeFileSync(out, json);
    else process.stdout.write(json);
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`session-dispatch: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`session-dispatch: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`session-dispatch: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}
