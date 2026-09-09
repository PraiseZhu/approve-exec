#!/usr/bin/env node
// wrapup-cleanup.mjs — 远端 PR 已 open 后只清本地 worktree/分支。不删远端。不用 cleanup-branch。
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { relative, dirname, isAbsolute, join, resolve } from 'node:path';
import { LedgerError, latestGroupEvent, latestPrHandoffDelivery, parseTimestamp } from './run-ledger.mjs';
import { validateMivoV2, verifyDeliveryEpoch, deliveryGh } from './release-mivo-pr.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;

export function parseWrapupArgs(argv) {
  const flags = { remote: 'origin' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new LedgerError('ARGS', `参数 --${key} 缺值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function git(args, { cwd, allowFailure = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFailure) {
    throw new LedgerError('PRECONDITION', `git ${args.join(' ')} 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function requireStamp(value, name) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new LedgerError('ARGS', `${name} 必须是非负安全整数（当前: ${value}）`);
  }
  return n;
}

function parseWorktrees(value) {
  const rows = [];
  let row = null;
  for (const line of value.split('\n')) {
    if (line === '') { if (row) rows.push(row); row = null; continue; }
    const i = line.indexOf(' ');
    if (i < 0) continue;
    row ??= {};
    row[line.slice(0, i)] = line.slice(i + 1);
  }
  if (row) rows.push(row);
  return rows;
}

function parseRetainPaths(value) {
  if (value === undefined) return ['node_modules', 'cindyplugin/dist'];
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new LedgerError('ARGS', '--retain-paths 必须是 JSON 数组'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || new Set(parsed).size !== parsed.length) throw new LedgerError('ARGS', '--retain-paths 必须是非空唯一 JSON 数组');
  for (const path of parsed) {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.endsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new LedgerError('ARGS', `非法 --retain-paths 路径: ${path}`);
  }
  return parsed;
}

function ignoredRetentionPlan({ worktree, mainRepo, gitRunner, retainDir, retainPaths }) {
  const allIgnored = gitRunner(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: worktree }).split('\0').filter(Boolean);
  const covered = (entry) => retainPaths.some((path) => entry === path || entry === `${path}/` || entry.startsWith(`${path}/`) || `${path}/`.startsWith(entry));
  if (allIgnored.some((path) => !covered(path))) throw new LedgerError('PRECONDITION', `存在未显式保留的 ignored 内容: ${allIgnored.find((path) => !covered(path))}`);
  for (const entry of allIgnored.filter((path) => path.endsWith('/') && !retainPaths.includes(path.slice(0, -1)))) {
    const parent = join(worktree, entry);
    const allowedChildren = retainPaths.filter((path) => `${path}/`.startsWith(entry)).map((path) => path.slice(entry.length).split('/')[0]);
    for (const child of readdirSync(parent, { withFileTypes: true })) {
      if (!allowedChildren.includes(child.name)) throw new LedgerError('PRECONDITION', `ignored 父目录含未显式保留项: ${entry}${child.name}`);
    }
  }
  if (retainDir === undefined) {
    if (allIgnored.length > 0) throw new LedgerError('PRECONDITION', '存在 ignored 内容，必须显式提供 --retain-dir 与 --retain-paths');
    return { artifacts: [], retainDir: null };
  }
  if (typeof retainDir !== 'string' || !isAbsolute(retainDir)) throw new LedgerError('ARGS', '--retain-dir 必须是绝对路径');
  const destination = resolve(retainDir);
  const worktreeReal = realpathSync(worktree);
  const mainReal = realpathSync(mainRepo);
  const worktreesDir = join(mainReal, '.worktrees');
  if (!insidePath(worktreesDir, destination) || insidePath(worktreeReal, destination) || destination === worktreeReal || existsSync(destination)) throw new LedgerError('PRECONDITION', '--retain-dir 必须是 .worktrees 下不存在的新 sibling 目录');
  needExistingDirectory(dirname(destination), 'retain-dir 的父目录必须已存在且不是软链接');
  if (realpathSync(dirname(destination)) !== realpathSync(worktreesDir)) throw new LedgerError('PRECONDITION', '--retain-dir 父目录必须是仓内 .worktrees');
  const artifacts = [];
  for (const path of retainPaths) {
    const from = join(worktreeReal, path);
    if (!existsSync(from)) continue;
    let cursor = worktreeReal;
    for (const segment of path.split('/')) {
      cursor = join(cursor, segment);
      const segmentStat = lstatSync(cursor);
      if (segmentStat.isSymbolicLink()) throw new LedgerError('PRECONDITION', `保留路径中间段是软链接: ${path}`);
    }
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new LedgerError('PRECONDITION', `不能保留软链接或特殊文件: ${path}`);
    artifacts.push({ from, to: join(destination, path), path, type: stat.isDirectory() ? 'directory' : 'file', device: stat.dev, inode: stat.ino });
  }
  if (allIgnored.length > 0 && allIgnored.some((entry) => !artifacts.some((artifact) => entry === artifact.path || entry === `${artifact.path}/` || entry.startsWith(`${artifact.path}/`) || `${artifact.path}/`.startsWith(entry)))) throw new LedgerError('PRECONDITION', '显式保留路径未覆盖全部 ignored 根');
  for (const artifact of artifacts) {
    const status = gitRunner(['status', '--porcelain', '--ignored', '--', artifact.path], { cwd: worktreeReal });
    if (!status.split('\n').some((line) => line.startsWith('!! ') && line.slice(3).replace(/\/$/, '') === artifact.path)) throw new LedgerError('PRECONDITION', `保留路径不是 ignored: ${artifact.path}`);
  }
  return { artifacts, retainDir: destination };
}

function insidePath(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function needExistingDirectory(path, message) {
  if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new LedgerError('PRECONDITION', message);
}

function ghPr({ repo, branch, ghBin = process.env.GH_BIN ?? 'gh', runner = spawnSync }) {
  const result = runner(ghBin, ['pr', 'view', branch, '--repo', repo, '--json', 'state,isDraft,headRefOid,headRepositoryOwner,headRepository'], { encoding: 'utf8' });
  if (result.status !== 0) throw new LedgerError('PRECONDITION', `gh pr view 失败: ${(result.stderr || result.stdout || '').trim()}`);
  return JSON.parse(result.stdout);
}

function assertDeliveredEvidence({ delivery, branch, localSha, ledgerPath, group, repo, ghBin, ghRunner = spawnSync }) {
  if (repo !== 'xindong/mivo-canvas-plugin') throw new LedgerError('PRECONDITION', 'delivered-local-only 仅允许指定 Mivo 仓库');
  if (typeof ledgerPath !== 'string' || typeof group !== 'string') throw new LedgerError('ARGS', 'newmode 必须提供 --ledger 与 --group');
  let ledger;
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch (err) { throw new LedgerError('PRECONDITION', `无法读取 ledger: ${err.message}`); }
  const groups = ledger.waves?.flatMap((wave) => wave.groups ?? []) ?? [];
  const record = groups.find((item) => item.group_id === group);
  const deliveryEvidence = latestPrHandoffDelivery(ledger, group);
  const prEvent = latestGroupEvent(ledger, group, 'pr_ready');
  let prReceipt;
  try { prReceipt = prEvent?.detail?.receipt ? JSON.parse(readFileSync(prEvent.detail.receipt, 'utf8')) : null; } catch (err) { throw new LedgerError('PRECONDITION', `无法读取 PR receipt: ${err.message}`); }
  const e2e = deliveryEvidence?.e2e;
  const acceptedSha = record?.tip_sha;
  if (prReceipt?.schemaVersion === 2) validateMivoV2(prReceipt);
  if (!record || !['pr-open', 'local-cleaned'].includes(record.state) || !SHA_RE.test(acceptedSha) || e2e?.status !== 'pass' || e2e.candidate_sha !== acceptedSha || deliveryEvidence?.tip_sha !== acceptedSha || !prReceipt || prReceipt.branch !== branch || (prReceipt.deliveryHeadSha ?? prReceipt.headRefOid) !== acceptedSha || prReceipt.isDraft !== false || prReceipt.state !== 'OPEN') {
    throw new LedgerError('PRECONDITION', 'ledger 未证明本组同一提交已通过 e2e 且已建立 PR 回执');
  }
  if (prReceipt.schemaVersion === 2) {
    if (localSha !== acceptedSha) throw new LedgerError('PRECONDITION', 'v2 cleanup requires local HEAD equal to delivery A');
    const pr = verifyDeliveryEpoch(prReceipt, args => deliveryGh(args, (binary, argv, options) => ghRunner(ghBin ?? binary, argv, options)));
    if (delivery !== undefined) throw new LedgerError('PRECONDITION', 'newmode 不接受调用者 delivery 证据');
    return { acceptedSha, livePrHeadSha: pr.headRefOid, prReceipt };
  }
  const pr = ghPr({ repo, branch, ghBin, runner: ghRunner });
  if (pr.state !== 'OPEN' || pr.isDraft !== false || !SHA_RE.test(pr.headRefOid) || pr.headRepositoryOwner?.login !== 'xindong' || pr.headRepository?.name !== 'mivo-canvas-plugin') throw new LedgerError('PRECONDITION', '实时 PR 已漂移、关闭、draft 或仓库不匹配');
  if (delivery !== undefined) throw new LedgerError('PRECONDITION', 'newmode 不接受调用者 delivery 证据');
  return { acceptedSha, livePrHeadSha: pr.headRefOid };
}

export function wrapupCleanup({ worktree, branch, remote = 'origin', gitRunner = git, now, ledgerVersion, assignmentSeq, mode, delivery, ledgerPath, group, repo, ghBin, ghRunner, retainDir, retainPaths } = {}) {
  if (typeof worktree !== 'string' || !worktree.startsWith('/')) {
    throw new LedgerError('ARGS', `worktree 必须是绝对路径（当前: ${worktree}）`);
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new LedgerError('ARGS', 'branch 必须是非空字符串');
  }
  if (branch === 'main' || branch === 'master') {
    throw new LedgerError('PRECONDITION', `拒绝清理主分支 ${branch}`);
  }
  parseTimestamp(now, 'wrapup-cleanup --now');
  const version = requireStamp(ledgerVersion, 'ledger-version');
  const seq = requireStamp(assignmentSeq, 'assignment-seq');
  if (mode === 'delivered-local-only') {
    if (delivery !== undefined) throw new LedgerError('PRECONDITION', 'newmode 不接受调用者 delivery 证据');
  } else if (mode !== undefined) throw new LedgerError('ARGS', `不支持的 wrapup mode: ${mode}`);
  const currentBranch = gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
  if (currentBranch !== branch) {
    throw new LedgerError('PRECONDITION', `worktree 当前分支 ${currentBranch} 对不上 ${branch}`);
  }
  const porcelain = gitRunner(['status', '--porcelain'], { cwd: worktree });
  if (porcelain.length > 0) {
    throw new LedgerError('PRECONDITION', `worktree dirty，拒绝清理（${porcelain.split('\n')[0]}）`);
  }
  const localSha = gitRunner(['rev-parse', 'HEAD'], { cwd: worktree });
  if (!SHA_RE.test(localSha)) {
    throw new LedgerError('PRECONDITION', `本地 HEAD 不是 40hex: ${localSha}`);
  }
  let acceptedSha = localSha;
  let livePrHeadSha;
  let deliveryReceipt;
  if (mode === 'delivered-local-only') {
    const evidence = assertDeliveredEvidence({ delivery, branch, localSha, ledgerPath, group, repo, ghBin, ghRunner });
    acceptedSha = evidence.acceptedSha;
    livePrHeadSha = evidence.livePrHeadSha;
    deliveryReceipt = evidence.prReceipt;
  }
  let mainRepo;
  if (mode === 'delivered-local-only') {
    const commonDir = gitRunner(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree });
    mainRepo = commonDir.replace(/\/\.git$/, '');
    const realWorktree = realpathSync(worktree);
    const trees = parseWorktrees(gitRunner(['worktree', 'list', '--porcelain'], { cwd: mainRepo }));
    const tree = trees.find((item) => item.worktree && realpathSync(item.worktree) === realWorktree);
    if (!tree || tree.branch !== `refs/heads/${branch}` || tree.HEAD !== localSha || realWorktree === realpathSync(mainRepo)) throw new LedgerError('PRECONDITION', '目标不是该仓库的独立非主 worktree');
    if (gitRunner(['status', '--porcelain'], { cwd: worktree }).length > 0) throw new LedgerError('PRECONDITION', '存在未跟踪内容，拒绝删除');
    if (existsSync(`${realWorktree}/.keep`) || existsSync(`${realWorktree}/.worktree-keep`) || existsSync(`${realWorktree}/.cleanup.lock`) || tree.locked !== undefined) throw new LedgerError('PRECONDITION', 'worktree 被 keep/lock 占用');
  } else {
    const commonDir = gitRunner(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree });
    mainRepo = commonDir.replace(/\/\.git$/, '');
  }
  if (mode === 'delivered-local-only') {
    try { gitRunner(['merge-base', '--is-ancestor', acceptedSha, localSha], { cwd: mainRepo }); }
    catch { throw new LedgerError('PRECONDITION', '本地提交不是原交付候选的 Git 后代'); }
  }
  const retained = ignoredRetentionPlan({ worktree, mainRepo, gitRunner, retainDir, retainPaths: parseRetainPaths(retainPaths) });
  const remoteLine = gitRunner(['ls-remote', remote, branch], { cwd: worktree });
  const remoteSha = (remoteLine.split(/\s+/)[0] || '').trim();
  if (!SHA_RE.test(remoteSha)) {
    throw new LedgerError('PRECONDITION', `远端 ${remote}/${branch} 读不到 SHA（当前: ${remoteLine || '空'}）`);
  }
  if (remoteSha !== localSha) {
    if (deliveryReceipt) gitRunner(['fetch', '--no-tags', '--no-write-fetch-head', remote, remoteSha], { cwd: mainRepo });
    try { gitRunner(['merge-base', '--is-ancestor', localSha, remoteSha], { cwd: mainRepo }); }
    catch { return { ok: false, skipped: true, reason: `远端 SHA ${remoteSha} 不是本地 ${localSha} 的后代，跳过删除`, branch, worktree, checked_at: now, ledger_version: version, assignment_seq: seq }; }
  }
  const finalBranch = gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
  const finalSha = gitRunner(['rev-parse', 'HEAD'], { cwd: worktree });
  const finalStatus = gitRunner(['status', '--porcelain'], { cwd: worktree });
  const finalRemoteLine = gitRunner(['ls-remote', remote, `refs/heads/${branch}`], { cwd: worktree });
  const finalRemoteSha = (finalRemoteLine.split(/\s+/)[0] || '').trim();
  if (finalBranch !== branch || finalSha !== localSha || finalStatus.length > 0 || !SHA_RE.test(finalRemoteSha)) throw new LedgerError('PRECONDITION', '删除前末刻复核失败，保留本地内容');
  if (mode === 'delivered-local-only' && livePrHeadSha !== finalRemoteSha) throw new LedgerError('PRECONDITION', '实时 PR head 与远端分支 SHA 不一致');
  if (deliveryReceipt) {
    const latest = verifyDeliveryEpoch(deliveryReceipt, args => deliveryGh(args, (binary, argv, options) => (ghRunner ?? spawnSync)(ghBin ?? binary, argv, options)));
    if (latest.headRefOid !== finalRemoteSha) throw new LedgerError('PRECONDITION', 'v2 PR changed before cleanup');
  }
  if (finalRemoteSha !== localSha) {
    try { gitRunner(['merge-base', '--is-ancestor', localSha, finalRemoteSha], { cwd: mainRepo }); }
    catch { throw new LedgerError('PRECONDITION', '删除前远端已分叉，保留本地内容'); }
  }
  const moved = [];
  const manifestPath = retained.retainDir ? join(retained.retainDir, '.approve-exec-retain-manifest.json') : null;
  const writeManifest = (status, artifacts, extra = {}) => {
    if (!manifestPath || !existsSync(dirname(manifestPath))) return;
    writeFileSync(manifestPath, `${JSON.stringify({ schema: 'approve-exec-retain-v1', status, checked_at: now, artifacts, ...extra }, null, 2)}\n`);
  };
  try {
    if (retained.artifacts.length > 0) {
      mkdirSync(retained.retainDir, { recursive: true });
      writeFileSync(manifestPath, `${JSON.stringify({ schema: 'approve-exec-retain-v1', status: 'prepared', checked_at: now, artifacts: retained.artifacts }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      for (const artifact of retained.artifacts) {
        const before = lstatSync(artifact.from);
        if (before.dev !== artifact.device || before.ino !== artifact.inode || before.isSymbolicLink() || existsSync(artifact.to)) throw new LedgerError('PRECONDITION', `保留路径在删除前发生变化: ${artifact.path}`);
        mkdirSync(dirname(artifact.to), { recursive: true });
        renameSync(artifact.from, artifact.to);
        moved.push(artifact);
        writeManifest('moving', moved);
      }
      for (const artifact of moved) {
        if (existsSync(artifact.from)) throw new LedgerError('PRECONDITION', `保留源路径移动后仍存在: ${artifact.path}`);
        const after = lstatSync(artifact.to);
        if (after.dev !== artifact.device || after.ino !== artifact.inode || after.isSymbolicLink()) throw new LedgerError('PRECONDITION', `保留目标 inode 移动后不匹配: ${artifact.path}`);
      }
      writeManifest('moved', moved);
    }
  } catch (error) {
    const canRollback = existsSync(worktree);
    if (canRollback) for (const artifact of [...moved].reverse()) { if (!existsSync(artifact.from) && existsSync(artifact.to)) renameSync(artifact.to, artifact.from); }
    writeManifest(canRollback ? 'rolled_back' : 'retained_after_partial_cleanup', retained.artifacts, { moved_paths: moved.map((artifact) => artifact.path), error: error.message });
    throw error;
  }
  try {
    if (gitRunner(['status', '--porcelain', '--ignored'], { cwd: worktree }).length > 0) throw new LedgerError('PRECONDITION', '保留内容移动后仍有本地内容');
    const finalTree = parseWorktrees(gitRunner(['worktree', 'list', '--porcelain'], { cwd: mainRepo })).find((tree) => tree.worktree === worktree);
    if (['.keep', '.worktree-keep', '.cleanup.lock'].some((path) => existsSync(join(worktree, path))) || finalTree?.locked) throw new LedgerError('PRECONDITION', '删除前末刻出现 keep/lock');
    if (mode === 'delivered-local-only') {
      gitRunner(['worktree', 'remove', worktree], { cwd: mainRepo });
      gitRunner(['update-ref', '-d', `refs/heads/${branch}`, localSha], { cwd: mainRepo });
    } else {
      gitRunner(['worktree', 'remove', worktree], { cwd: mainRepo });
      gitRunner(['branch', '-D', branch], { cwd: mainRepo });
    }
  } catch (error) {
    const canRollback = existsSync(worktree);
    if (canRollback) for (const artifact of [...moved].reverse()) { if (!existsSync(artifact.from) && existsSync(artifact.to)) renameSync(artifact.to, artifact.from); }
    writeManifest(canRollback ? 'rolled_back' : 'retained_after_partial_cleanup', retained.artifacts, { moved_paths: moved.map((artifact) => artifact.path), error: error.message });
    throw error;
  }
  const remainingTrees = gitRunner(['worktree', 'list', '--porcelain'], { cwd: mainRepo });
  if (remainingTrees.split('\n').some((line) => line === `worktree ${worktree}`)) {
    throw new LedgerError('PRECONDITION', `worktree 删除后仍在 git worktree list：${worktree}`);
  }
  const remainingBranch = gitRunner(['branch', '--list', branch], { cwd: mainRepo });
  if (remainingBranch.length > 0) {
    throw new LedgerError('PRECONDITION', `本地分支删除后仍在：${remainingBranch}`);
  }
  if (existsSync(worktree)) {
    throw new LedgerError('PRECONDITION', `worktree 路径删除后仍存在：${worktree}`);
  }
  return {
    ok: true,
    skipped: false,
    branch,
    worktree,
    sha: localSha,
    remoteDeleted: false,
    checked_at: now,
    ledger_version: version,
    assignment_seq: seq,
  };
}

function runCli(argv) {
  try {
    const flags = parseWrapupArgs(argv);
    const out = wrapupCleanup({
      worktree: flags.worktree,
      branch: flags.branch,
      remote: flags.remote ?? 'origin',
      now: flags.now,
      ledgerVersion: flags['ledger-version'],
      assignmentSeq: flags['assignment-seq'],
      mode: flags.mode,
      ledgerPath: flags.ledger,
      group: flags.group,
      repo: flags.repo,
      ghBin: flags['gh-bin'],
      retainDir: flags['retain-dir'],
      retainPaths: flags['retain-paths'],
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return out.ok ? 0 : 2;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`wrapup-cleanup: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`wrapup-cleanup: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`wrapup-cleanup: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}
