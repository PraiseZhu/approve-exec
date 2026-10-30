#!/usr/bin/env node
// root-check.mjs — lead 验收总 issue 前的确定性检查与集成预览（PraiseZhu/approve-exec#79）。只读 GitHub，不推送、不改台账。
// 检查：每个收工的子 PR 非 Draft、当前 CI 全绿、还开着或已合并（关了没合不过，和 cleanup 一致）；
// personal 车道 head 和 lead 判通过时不同就不过，交接车道 head 变了只记 head_moved（Ready 后归盯梢推）。
// --preview：每个涉及的仓从 origin/<目标分支> 开临时 worktree（<仓>/.worktrees/approve-exec-preview-<run>），
//   按批次依次合入各子 PR 当前的 head，给 lead 在里面按目标仓规则跑测试。有冲突就报 PR 号和文件、恢复干净、停在那里。
// --cleanup：删掉本 run 的预览 worktree。
//
// CLI: node scripts/root-check.mjs --ledger <ledger.json> [--preview | --cleanup] [--out <结果.json>] [--gh-fixture <夹具>]
// 输出一行 JSON；ok exit 0，否则 exit 2。
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isMain, nowIso, parseArgs, readJson, sha256, writeJsonAtomic } from './lib/common.mjs';
import { ghRunner } from './issue-plan.mjs';
import { ciVerdict, ghChecksRunner } from './accept-check.mjs';

export const PREVIEW_PREFIX = 'approve-exec-preview-';
/** Ready 之后归盯梢的车道：head 会因为审查意见继续变（KEEL postReadyOwner=automation）。 */
export const HANDOFF_LANES = Object.freeze(['gated-handoff', 'draft-gated-handoff']);
const MERGE_ID = ['-c', 'user.name=approve-exec', '-c', 'user.email=approve-exec@localhost', '-c', 'commit.gpgsign=false'];

/**
 * 预览目录名：完整 run id（不同 run 不会撞名，cleanup 不会删到别的 run）；目标分支不是 main 时再加
 * 「可读分支名 + 分支名哈希」，`release/foo` 和 `release-foo` 也落到不同目录（review-pr82 第 2 轮）。
 */
export function previewName(ledger, base = 'main') {
  const name = `${PREVIEW_PREFIX}${ledger.run_id}`;
  if (base === 'main') return name;
  return `${name}--${String(base).replace(/[^A-Za-z0-9._-]+/g, '-')}-${sha256(String(base)).slice(0, 12)}`;
}

function gitRunner() {
  return (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// check

/** 每个子 issue 一行：计划时已关闭的直接算过；其余要已归档、有 PR，并过 PR 状态、Draft、CI、head 检查。 */
export function rootCheck({ ledger, gh, checks, now = nowIso() }) {
  const rows = [];
  for (const item of Object.values(ledger.items)) {
    if (item.state === 'closed') {
      rows.push({ ref: item.ref, state: 'closed', wave: item.wave, pr: null, ok: true, problems: [], note: '计划时已关闭' });
      continue;
    }
    const problems = [];
    if (item.state !== 'archived') problems.push(`子 issue 还没收工（${item.state}）`);
    const cp = item.checkpoint;
    if (!cp?.pr) {
      rows.push({ ref: item.ref, state: item.state, wave: item.wave, pr: null, ok: false, problems: [...problems, '台账里没有 PR'] });
      continue;
    }
    const pr = gh(['api', `repos/${item.repo}/pulls/${cp.pr}`]);
    const merged = pr?.merged === true;
    const head = pr?.head?.sha ?? null;
    if (pr?.state !== 'open' && !merged) problems.push(`PR #${cp.pr} 关了没合（状态 ${pr?.state ?? '未知'}）`);
    if (pr?.draft !== false) problems.push(`PR #${cp.pr} 还是 Draft`);
    const ci = ciVerdict(checks, item.repo, cp.pr);
    if (!ci.ok) problems.push(`PR #${cp.pr} ${ci.detail}`);
    const handoffLane = HANDOFF_LANES.includes(cp.lane);
    const headMoved = Boolean(head && cp.head && head !== cp.head);
    if (headMoved && !handoffLane) problems.push(`PR #${cp.pr} 的 head 从 lead 判通过时的 ${cp.head} 变成了 ${head}：新提交没验收过`);
    rows.push({
      ref: item.ref, state: item.state, wave: item.wave, repo: item.repo, pr: cp.pr, lane: cp.lane ?? null,
      accepted_head: cp.head, current_head: head, merged, head_moved: headMoved, pushed_after_ready: handoffLane,
      ci: ci.detail, ok: problems.length === 0, problems,
    });
  }
  return { ok: rows.every((r) => r.ok), root: ledger.root.ref, run_id: ledger.run_id, rows, checked_at: now };
}

// preview

/** 每个仓（同一目标分支）一个预览 worktree，按批次、再按子 issue 号依次合入各子 PR 当前的 head。 */
export function preview({ ledger, plan, check, git = gitRunner() }) {
  const groups = new Map();
  for (const row of check.rows.filter((r) => r.pr && r.current_head)) {
    const planItem = plan.items.find((i) => i.ref === row.ref);
    const dir = planItem.keel_run.repo_dir;
    const base = planItem.keel_run.base_ref ?? 'main';
    const key = `${dir}\n${base}`;
    if (!groups.has(key)) groups.set(key, { repo: row.repo, dir, base, rows: [] });
    groups.get(key).rows.push(row);
  }
  const out = [];
  for (const { repo, dir, base, rows } of groups.values()) {
    const wt = join(dir, '.worktrees', previewName(ledger, base));
    if (existsSync(wt)) git(['-C', dir, 'worktree', 'remove', '--force', wt]);
    git(['-C', dir, 'fetch', '--quiet', 'origin', base]);
    git(['-C', dir, 'worktree', 'add', '--quiet', '--detach', wt, `origin/${base}`]);
    const merged = [];
    let conflict = null;
    let moved = null;
    const ordered = rows.slice().sort((a, b) => (a.wave - b.wave) || a.ref.localeCompare(b.ref, 'en', { numeric: true }));
    for (const row of ordered) {
      git(['-C', dir, 'fetch', '--quiet', 'origin', `refs/pull/${row.pr}/head`]);
      // 检查之后 PR 又推了提交：合进去的就不是检查过的那个，停下让 lead 重跑（review-pr82）。
      const fetched = git(['-C', dir, 'rev-parse', 'FETCH_HEAD']);
      if (fetched !== row.current_head) {
        moved = { pr: row.pr, ref: row.ref, checked: row.current_head, now: fetched };
        break;
      }
      try {
        git(['-C', wt, ...MERGE_ID, 'merge', '--no-ff', '--no-edit', '--quiet', row.current_head]);
        merged.push(row.pr);
      } catch {
        const files = git(['-C', wt, 'diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
        git(['-C', wt, 'merge', '--abort']);
        conflict = { pr: row.pr, ref: row.ref, files };
        break;
      }
    }
    out.push({ repo, base, dir: wt, merged, conflict, head_moved: moved });
  }
  return { ok: out.every((o) => !o.conflict && !o.head_moved), repos: out };
}

/** 删掉本 run 的预览 worktree（只删 approve-exec-preview-<run id> 与它带目标分支的 `--…` 变体）。 */
export function cleanupPreview({ ledger, plan, git = gitRunner() }) {
  const removed = [];
  const name = previewName(ledger);
  for (const dir of new Set(plan.items.map((i) => i.keel_run.repo_dir))) {
    const root = join(dir, '.worktrees');
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).filter((e) => e === name || e.startsWith(`${name}--`))) {
      git(['-C', dir, 'worktree', 'remove', '--force', join(root, entry)]);
      removed.push(join(root, entry));
    }
  }
  return { ok: true, removed };
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixture = typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null;
  try {
    const ledger = readJson(String(args.ledger));
    const plan = readJson(ledger.plan.path);
    let res;
    if (args.cleanup === true) {
      res = cleanupPreview({ ledger, plan });
    } else {
      res = rootCheck({ ledger, gh: ghRunner(fixture), checks: ghChecksRunner(fixture), now: typeof args.now === 'string' ? args.now : nowIso() });
      if (args.preview === true) {
        res.preview = preview({ ledger, plan, check: res });
        res.ok = res.ok && res.preview.ok;
      }
    }
    if (typeof args.out === 'string') writeJsonAtomic(args.out, res);
    process.stdout.write(JSON.stringify(res) + '\n');
    return res.ok ? 0 : 2;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());
