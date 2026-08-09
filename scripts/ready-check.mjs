#!/usr/bin/env node
// ready-check.mjs — approve-exec 出口门：七项 exact 合取，全过才输出 READY_FOR_SUBMIT_PR。
//
// 消费契约（g4 run-ledger 后续对齐；形状见 tests/fixtures/ready-full/ 与 ready-gaps/README.md）：
//   --ledger 台账（g4 run-ledger schema）：schema_version/run_id/slug/manifest_path/manifest_core_hash/
//            version(乐观锁计数)/phase/waves[].groups[]{group_id,state,sc_ids,tip_sha,review{rounds,unresolved}}/
//            events[]{type,at,detail}；type ∈ {dispatch,delivery,...}
//   --manifest task-priority manifest：scs[]{id,...} + dispatch.packets[]{group_id,...}
//   --verdict 验收 verdict：candidate_sha + scs[]{sc_id,status,evidence[]{file,command,summary}} +
//            output_records{file: summary}（内嵌输出摘要；evidence.summary 必须与 output_records[file] 逐字一致）
//   --e2e-report e2e 报告：status∈{pass,fail} + candidate_sha
//   --presubmit-dir 目录内三文件 size.json/format.json/intent.json：result 各自 pass 语义
//            （size≠STOP / format≠FAIL / intent∈{OK,REBUILT}）+ 各自 candidate_sha
//   --repo 候选仓（git status / HEAD 分支 / SHA 的真实来源）
//
// 七项判据（逐项独立报告，不因前项失败跳过后项）：
//   ① ledger-partition  全部组 ∈ {verified}；组数 == manifest dispatch.packets 数 == 派出记录数
//                        （dispatch 事件去重）；各组 tip_sha 与台账 delivery 事件对账
//   ② verdict-anchors   每条 SC（manifest.scs 全集）在 verdict 中 status=pass；verdict.candidate_sha == HEAD；
//                        证据锚点强校验：evidence.file 真实存在（resolve 后在 repo 内）+ summary 与
//                        output_records 内嵌记录逐字一致（不是字符串非空就过）
//   ③ review-clean      每组 review.rounds ≤ config.reviewMaxRounds 且 unresolved==0；
//                        每组最后一条 delivery 事件的 detail.candidate_sha == HEAD（审查交卷绑定）
//   ④ e2e-report        报告存在、status=pass、candidate_sha == HEAD
//   ⑤ presubmit-gates   三闸结果存在、各自 result pass 语义、各自 candidate_sha == HEAD
//   ⑥ git-clean         候选仓 git status --porcelain 为空
//   ⑦ feature-branch    HEAD 在具名 feature 分支（非 main/master、非 detached）
//
// 输出与退出：
//   全过（且 --now 已传）→ stdout 单行 `READY_FOR_SUBMIT_PR <branch> <HEAD_SHA>`，驱动台账 phase→ready
//   （CAS：写前重读比对 version；tmp+rename 原子替换；写失败/无 --now → GAP: ledger-write-conflict + exit 2）
//   任一缺 → exit 2，每行 `GAP: <gate>: <detail>`（全部 gap 列出）
//
// CLI: node scripts/ready-check.mjs --repo <R> --ledger <L> --manifest <M> --verdict <V>
//      --e2e-report <E> --presubmit-dir <D> [--now <ISO时间戳>] [--config <C 默认 config/defaults.json>]

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- CLI 解析 ----------
function parseArgs(argv) {
  const args = { repo: null, ledger: null, manifest: null, verdict: null, e2eReport: null, presubmitDir: null, now: null, config: join(root, 'config/defaults.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--verdict') args.verdict = argv[++i];
    else if (a === '--e2e-report') args.e2eReport = argv[++i];
    else if (a === '--presubmit-dir') args.presubmitDir = argv[++i];
    else if (a === '--now') args.now = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else { console.error(`ready-check: 未知参数 ${a}`); process.exit(2); }
  }
  const missing = ['repo', 'ledger', 'manifest', 'verdict', 'e2eReport', 'presubmitDir'].filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`ready-check: 缺少必备参数 --${missing.join(' / --')}`);
    process.exit(2);
  }
  return args;
}

// ---------- 工具 ----------
function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function runGit(repoDir, gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function isInsideRepo(repoRoot, relPath) {
  const resolved = resolve(repoRoot, relPath);
  return resolved.startsWith(repoRoot + sep) || resolved === repoRoot;
}

// ---------- 七项判据（每项独立函数，变异点字符串唯一） ----------

// ① 台账互斥全分区对账
function checkLedgerPartition(ledger, manifest, gaps) {
  const groups = (ledger.waves || []).flatMap((w) => w.groups || []);
  const packets = manifest.dispatch?.packets || [];
  const events = ledger.events || [];

  const notVerified = groups.filter((g) => g.state !== 'verified');
  if (notVerified.length > 0) {
    gaps.push({ gate: 'ledger-partition', detail: `组非 verified: ${notVerified.map((g) => `${g.group_id}=${g.state}`).join(', ')}` });
  }

  // 组数对账：组数 == manifest dispatch.packets 数（sc-p1g 变异②挖掉点）
  if (groups.length !== packets.length) {
    gaps.push({ gate: 'ledger-partition', detail: `组数对账: 台账 ${groups.length} 组 != manifest dispatch.packets ${packets.length} 组` });
  }

  // 派出记录数：dispatch 事件去重数 == 组数（sc-p1g 变异②挖掉点）
  const dispatchedGroupIds = new Set(events.filter((e) => e.type === 'dispatch').map((e) => e.detail?.group_id).filter(Boolean));
  if (dispatchedGroupIds.size !== groups.length) {
    gaps.push({ gate: 'ledger-partition', detail: `派出记录数对账: dispatch 去重 ${dispatchedGroupIds.size} != 台账组数 ${groups.length}` });
  }

  // 各组 tip_sha 与台账 delivery 事件对账
  for (const g of groups) {
    const deliveries = events.filter((e) => e.type === 'delivery' && e.detail?.group_id === g.group_id);
    const matched = deliveries.find((d) => d.detail.tip_sha === g.tip_sha);
    if (deliveries.length === 0) {
      gaps.push({ gate: 'ledger-partition', detail: `${g.group_id} 无 delivery 事件` });
    } else if (!matched) {
      gaps.push({ gate: 'ledger-partition', detail: `${g.group_id} tip_sha 与 delivery 事件对账失败（台账 ${g.tip_sha}）` });
    }
  }
}

// ② 每条 SC 验收 verdict + 证据锚点强校验
function checkVerdictAnchors(verdict, manifest, repoRoot, headSha, gaps) {
  if (!verdict) { gaps.push({ gate: 'verdict-anchors', detail: 'verdict 文件不存在或不可解析' }); return; }
  if (verdict.candidate_sha !== headSha) {
    gaps.push({ gate: 'verdict-anchors', detail: `verdict.candidate_sha ${verdict.candidate_sha} != 候选仓 HEAD ${headSha}` });
  }

  const verdictScs = verdict.scs || [];
  const manifestScIds = (manifest.scs || []).map((s) => s.id);
  for (const scId of manifestScIds) {
    const entry = verdictScs.find((s) => s.sc_id === scId);
    if (!entry) { gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 在 verdict 中缺失` }); continue; }
    if (entry.status !== 'pass') { gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} verdict status=${entry.status} != pass` }); continue; }
    const evidence = entry.evidence || [];
    if (evidence.length === 0) { gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 无证据锚点` }); continue; }
    for (const ev of evidence) {
      const anchorFileExists = typeof ev.file === 'string' && ev.file.length > 0
        && isInsideRepo(repoRoot, ev.file) && existsSync(join(repoRoot, ev.file));
      if (!anchorFileExists) {  // sc-p1g 变异③挖掉点（回退为字符串非空）
        gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 证据锚点文件不存在或越出候选仓: ${ev.file}` });
        continue;
      }
      const recorded = (verdict.output_records || {})[ev.file];
      if (typeof ev.summary !== 'string' || ev.summary.length === 0) {
        gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 证据 ${ev.file} 输出摘要为空` });
      } else if (recorded !== ev.summary) {
        gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 证据 ${ev.file} 输出摘要与 verdict 内嵌 output_records 不一致` });
      }
    }
  }
}

// ③ 每组审查收敛 + 审查交卷 candidate 绑定
function checkReviewClean(ledger, headSha, reviewMaxRounds, gaps) {
  const groups = (ledger.waves || []).flatMap((w) => w.groups || []);
  const events = ledger.events || [];
  for (const g of groups) {
    const review = g.review || {};
    if (typeof review.unresolved !== 'number' || review.unresolved !== 0) {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} review.unresolved=${review.unresolved} != 0` });
    }
    if (typeof review.rounds !== 'number' || review.rounds > reviewMaxRounds) {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} review.rounds=${review.rounds} > reviewMaxRounds=${reviewMaxRounds}` });
    }
    const deliveries = events.filter((e) => e.type === 'delivery' && e.detail?.group_id === g.group_id);
    const lastDelivery = deliveries[deliveries.length - 1];
    if (!lastDelivery || typeof lastDelivery.detail.candidate_sha !== 'string') {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} 审查交卷（delivery 入账）缺 candidate_sha 绑定` });
    } else if (lastDelivery.detail.candidate_sha !== headSha) {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} 审查交卷 candidate_sha ${lastDelivery.detail.candidate_sha} != 当前 HEAD ${headSha}` });
    }
  }
}

// ④ e2e 报告
function checkE2eReport(e2eReport, headSha, gaps) {
  if (!e2eReport) { gaps.push({ gate: 'e2e-report', detail: 'e2e 报告文件不存在或不可解析' }); return; }
  if (e2eReport.status !== 'pass') { gaps.push({ gate: 'e2e-report', detail: `e2e 报告 status=${e2eReport.status} != pass` }); }
  if (e2eReport.candidate_sha !== headSha) {
    gaps.push({ gate: 'e2e-report', detail: `e2e 报告 candidate_sha ${e2eReport.candidate_sha} != 候选仓 HEAD ${headSha}` });
  }
}

// ⑤ presubmit 三闸（size/format/intent）
const PRESUBMIT_FILES = ['size', 'format', 'intent'];
const PRESUBMIT_PASS = { size: (r) => r !== 'STOP', format: (r) => r !== 'FAIL', intent: (r) => r === 'OK' || r === 'REBUILT' };

function checkPresubmitGates(presubmitDir, headSha, gaps) {
  for (const name of PRESUBMIT_FILES) {
    const file = join(presubmitDir, `${name}.json`);
    const result = readJsonOrNull(file);
    if (!result) { gaps.push({ gate: 'presubmit-gates', detail: `presubmit 结果缺失: ${name}.json` }); continue; }
    if (!PRESUBMIT_PASS[name](result.result)) {
      gaps.push({ gate: 'presubmit-gates', detail: `${name} 闸 result=${result.result} 非通过语义` });
    }
    if (result.candidate_sha !== headSha) {  // sc-p1g 变异①挖掉点
      gaps.push({ gate: 'presubmit-gates', detail: `${name} 闸 candidate_sha ${result.candidate_sha} != 候选仓 HEAD ${headSha}` });
    }
  }
}

// ⑥ 候选仓 git status 干净
function checkGitClean(repoRoot, gaps) {
  const r = runGit(repoRoot, ['status', '--porcelain']);
  if (r.status !== 0) { gaps.push({ gate: 'git-clean', detail: `git status 执行失败: ${r.stderr}` }); return; }
  if (r.stdout.length > 0) {
    gaps.push({ gate: 'git-clean', detail: `候选仓工作树不干净（${r.stdout.split('\n').length} 条变更）` });
  }
}

// ⑦ HEAD 在具名 feature 分支
function checkFeatureBranch(repoRoot, gaps) {
  const r = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = r.status === 0 ? r.stdout : '';
  if (branch === '' || branch === 'HEAD') { gaps.push({ gate: 'feature-branch', detail: `HEAD 处于 detached 状态（${branch}）` }); return; }
  if (branch === 'main' || branch === 'master') { gaps.push({ gate: 'feature-branch', detail: `HEAD 在 ${branch}（非 feature 分支）` }); }
}

// ---------- 驱动台账 phase→ready（CAS + tmp+rename 原子写） ----------
function drivePhaseReady(ledgerPath, ledger, now) {
  const current = readJsonOrNull(ledgerPath);
  if (!current) return '台账文件写前重读失败（不可解析）';
  if (current.version !== ledger.version) {
    return `CAS 冲突: 读时 version=${ledger.version}，写前重读 version=${current.version}，拒绝覆盖`;
  }
  const next = { ...current, version: current.version + 1, phase: 'ready', phase_at: now };
  const tmp = `${ledgerPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, ledgerPath);
  } catch (e) {
    return `台账写入失败: ${e.message}`;
  }
  return null;
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJsonOrNull(args.config);
  if (!config || typeof config.reviewMaxRounds !== 'number') {
    console.error('ready-check: config 缺失或 reviewMaxRounds 非数字（fail-closed，拒绝猜测默认值）');
    process.exit(2);
  }
  const reviewMaxRounds = config.reviewMaxRounds;

  const ledger = readJsonOrNull(args.ledger);
  if (!ledger) { console.error('GAP: ledger-partition: 台账文件不存在或不可解析'); process.exit(2); }
  const manifest = readJsonOrNull(args.manifest);
  if (!manifest) { console.error('GAP: ledger-partition: manifest 文件不存在或不可解析'); process.exit(2); }

  const headResult = runGit(args.repo, ['rev-parse', 'HEAD']);
  if (headResult.status !== 0) {
    console.error(`GAP: git-clean: 无法读取候选仓 HEAD: ${headResult.stderr}`);
    process.exit(2);
  }
  const headSha = headResult.stdout;
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    console.error(`GAP: git-clean: 候选仓 HEAD 非 40 位十六进制: ${headSha}`);
    process.exit(2);
  }

  const verdict = readJsonOrNull(args.verdict);
  const e2eReport = readJsonOrNull(args.e2eReport);

  // 七项逐项独立检查，全部跑完再收束（不因前项失败跳过后项）
  const gaps = [];
  checkLedgerPartition(ledger, manifest, gaps);
  checkVerdictAnchors(verdict, manifest, args.repo, headSha, gaps);
  checkReviewClean(ledger, headSha, reviewMaxRounds, gaps);
  checkE2eReport(e2eReport, headSha, gaps);
  checkPresubmitGates(args.presubmitDir, headSha, gaps);
  checkGitClean(args.repo, gaps);
  checkFeatureBranch(args.repo, gaps);

  if (gaps.length > 0) {
    for (const g of gaps) console.error(`GAP: ${g.gate}: ${g.detail}`);
    console.error(`ready-check: ${gaps.length} 项 gap，出口门未通过（exit 2）`);
    process.exit(2);
  }

  if (args.now === null) {
    console.error('GAP: ledger-write-conflict: 七项全过但未传 --now，拒绝驱动台账 phase→ready（写操作需时间戳注入）');
    process.exit(2);
  }
  const writeError = drivePhaseReady(args.ledger, ledger, args.now);
  if (writeError !== null) {
    console.error(`GAP: ledger-write-conflict: ${writeError}`);
    process.exit(2);
  }

  const branchResult = runGit(args.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.status === 0 ? branchResult.stdout : 'unknown';
  console.log(`READY_FOR_SUBMIT_PR ${branch} ${headSha}`);
  process.exit(0);
}

main();
