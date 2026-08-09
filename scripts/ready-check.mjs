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
//   ① ledger-partition  全部组 ∈ {verified}；组数 == manifest dispatch.packets 数 == 派出记录数；
//                        ledger groups / manifest packets / dispatch 事件三方的 group_id 集合严格相等
//                        （只比数量会被「换成未知 gX 数量仍相同」蒙混）；各组 tip_sha 与台账 delivery 事件对账；
//                        零组（零工作运行）直接拒绝——空集全分区恒真，不能当 READY 放行
//   ② verdict-anchors   manifest.scs fail-closed（非空数组、SC id 唯一）且与 dispatch packets scs_inline /
//                        ledger groups sc_ids 三集合对账一致后才遍历；每条 SC 在 verdict 中 status=pass；
//                        verdict.candidate_sha == HEAD；证据锚点强校验：evidence.file realpath 后在 repo 内
//                        （防仓内 symlink 指向仓外文件冒充锚点）+ summary 与 output_records 内嵌记录逐字一致
//   ③ review-clean      每组 review.rounds ≤ config.reviewMaxRounds 且 unresolved==0；
//                        每组最后一条 delivery 事件的 detail.candidate_sha == HEAD（审查交卷绑定）
//   ④ e2e-report        报告存在、status=pass、candidate_sha == HEAD
//   ⑤ presubmit-gates   三闸结果存在、各自 result pass 语义、各自 candidate_sha == HEAD
//   ⑥ git-clean         候选仓 git status --porcelain 为空
//   ⑦ feature-branch    HEAD 在具名 feature 分支（非 main/master、非 detached）
//
// 输出与退出：
//   全过（且 --now/--receipt 已传）→ 原子写入 →ready receipt（exact schema 见 run-ledger.mjs
//   READY_RECEIPT_KEYS 契约；ledger_version = 检查时读到的台账 version，非 +1），随后 stdout 单行
//   `READY_FOR_SUBMIT_PR <branch> <HEAD_SHA>`。receipt 未落盘时不得输出 READY 行（写失败 → exit 2 点名）。
//   ready-check 只检查不写台账：phase→ready 的唯一写入者是 run-ledger set-state --phase ready
//   --ready-receipt <path>（锁/CAS/phase 单步/全波集成/manifest hash 绑定都在它那边，本脚本不复制）。
//   任一缺 → exit 2，每行 `GAP: <gate>: <detail>`（全部 gap 列出）
//
// CLI: node scripts/ready-check.mjs --repo <R> --ledger <L> --manifest <M> --verdict <V>
//      --e2e-report <E> --presubmit-dir <D> [--now <ISO时间戳>] [--receipt <receipt 路径>]
//      [--config <C 默认 config/defaults.json>]
//
// 输入容错：ledger/manifest/verdict/e2e-report 任一不可解析 → 转对应 gate 的 gap 占位，
// 不依赖其内容的 gate 照常运行（前项失败不跳过后项），全部收束后再 exit 2。

import { readFileSync, writeFileSync, renameSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// tmpPath 复用 run-ledger.mjs（同仓同语义，不另写一套）——receipt 原子写盘用唯一 tmp
// 名 <path>.tmp.<pid>.<随机nonce>（固定 tmp 会让并发写者互相覆盖）。
// ready-check 只检查不写台账：phase→ready 的唯一写入者是 run-ledger set-state
// --phase ready --ready-receipt（锁/CAS/phase 单步/全波集成/manifest hash 绑定都在它那边）。
// readManifest 一并复用：manifest 在场/形状契约与 run-ledger 全部消费入口同判据（同一份实现，
// 不在 ready-check 另写一套存在性检查——receipts 在 core hash 黑名单之外，删它 hash 不变，
// 出口门不能只靠 hash 兜底）。
import { tmpPath, readManifest } from './run-ledger.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- CLI 解析 ----------
function parseArgs(argv) {
  const args = { repo: null, ledger: null, manifest: null, verdict: null, e2eReport: null, presubmitDir: null, now: null, receipt: null, config: join(root, 'config/defaults.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--verdict') args.verdict = argv[++i];
    else if (a === '--e2e-report') args.e2eReport = argv[++i];
    else if (a === '--presubmit-dir') args.presubmitDir = argv[++i];
    else if (a === '--now') args.now = argv[++i];
    else if (a === '--receipt') args.receipt = argv[++i];
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

// 集合工具（F-N / F-M 的三方集合严格相等对账）
function setsEqual(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
function diffIds(a, b) {
  return [...a].filter((x) => !b.has(x)).map(String).join(',') || '无';
}

// F-L: 证据锚点仓内校验必须 realpath 双侧归一后再判前缀。
// 旧实现只做词法 resolve：仓内以 symlink 提交的锚点指向仓外文件时，existsSync 跟随链接返回 true，
// 而真实文件在 repo 外——锚点「存在」成了假。realpath 失败（文件不存在/断链）一律视为越界（fail-closed）。
function isInsideRepo(repoRoot, relPath) {
  const resolved = resolve(repoRoot, relPath);
  let repoReal;
  let anchorReal;
  try {
    repoReal = realpathSync(repoRoot);
    anchorReal = realpathSync(resolved);
  } catch {
    return false;
  }
  return anchorReal === repoReal || anchorReal.startsWith(repoReal + sep);
}

// ---------- 七项判据（每项独立函数，变异点字符串唯一） ----------

// ① 台账互斥全分区对账
function checkLedgerPartition(ledger, manifest, manifestError, gaps) {
  // F-O: 输入不可解析转 gap 占位而非提前 exit——不依赖其内容的后项（④⑤⑥⑦）照常运行
  if (!ledger) { gaps.push({ gate: 'ledger-partition', detail: '台账文件不存在或不可解析' }); return; }
  if (!manifest) {
    gaps.push({ gate: 'ledger-partition', detail: manifestError ? `manifest 不合约: ${manifestError}` : 'manifest 文件不存在或不可解析' });
    return;
  }
  const groups = (ledger.waves || []).flatMap((w) => w.groups || []);
  const packets = manifest.dispatch?.packets || [];
  const events = ledger.events || [];

  // 零工作守卫：空台账 + 空 packets + 空 dispatch 会让三条对账全部空洞通过（0==0==0），
  // 拒绝「什么都没验收」的候选被判 READY（空集的全分区恒真，但作为出口门必须非空）
  if (groups.length === 0) {
    gaps.push({ gate: 'ledger-partition', detail: '台账无任何组（零工作运行，拒绝 READY）' });
  }

  const notVerified = groups.filter((g) => g.state !== 'verified');
  if (notVerified.length > 0) {
    gaps.push({ gate: 'ledger-partition', detail: `组非 verified: ${notVerified.map((g) => `${g.group_id}=${g.state}`).join(', ')}` });
  }

  // 组数对账：组数 == manifest dispatch.packets 数（sc-p1g 变异②挖掉点）
  if (groups.length !== packets.length) {
    gaps.push({ gate: 'ledger-partition', detail: `组数对账: 台账 ${groups.length} 组 != manifest dispatch.packets ${packets.length} 组` });
  }

  // 派出记录数：dispatch 事件去重数 == 组数（sc-p1g 变异②挖掉点）；
  // 不 filter(Boolean)：缺 group_id 的 dispatch 事件以 undefined 参与计数与集合比较，被如实点名
  const dispatchGroupIds = new Set(events.filter((e) => e.type === 'dispatch').map((e) => e.detail?.group_id));
  if (dispatchGroupIds.size !== groups.length) {
    gaps.push({ gate: 'ledger-partition', detail: `派出记录数对账: dispatch 去重 ${dispatchGroupIds.size} != 台账组数 ${groups.length}` });
  }

  // F-N: 数量对账通过后仍须三方 group_id 集合严格相等——把 g2 的 dispatch 事件换成未知 gX 时去重数量
  // 仍为 2，旧实现只看数量会放行「g2 从未被派出」。数量已不等时根因已由上方数量对账点名，不重复报。
  const ledgerGroupIds = new Set(groups.map((g) => g.group_id));
  const packetGroupIds = new Set(packets.map((p) => p.group_id));
  if (groups.length === packets.length && dispatchGroupIds.size === groups.length
      && (!setsEqual(ledgerGroupIds, packetGroupIds) || !setsEqual(ledgerGroupIds, dispatchGroupIds))) {
    gaps.push({ gate: 'ledger-partition', detail: `组集合对账: manifest packets 缺 ${diffIds(ledgerGroupIds, packetGroupIds)} / 多 ${diffIds(packetGroupIds, ledgerGroupIds)}; dispatch 事件缺 ${diffIds(ledgerGroupIds, dispatchGroupIds)} / 多 ${diffIds(dispatchGroupIds, ledgerGroupIds)}` });
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

// F-M: manifest.scs fail-closed 校验 + 与 dispatch packets scs_inline / ledger groups sc_ids 对账。
// 「manifest.scs 空全集」会让 ② 的遍历零次执行、空洞放行（与 ① 零组守卫同一类，那条已修、这条漏了）；
// 对账要求三处 SC 集合严格一致，缺一或多一都拒绝遍历 verdict。
// ledger 不可用（F-O 占位）时跳过台账侧对账——其不可用已由 ①③ 各自点名，不在此重复。
function validateScs(manifest, ledger) {
  const scs = manifest.scs;
  if (!Array.isArray(scs) || scs.length === 0) {
    return { ok: false, detail: 'manifest.scs 为空或非数组（无任何 SC，拒绝 READY）' };
  }
  const ids = new Set();
  for (const s of scs) {
    if (!s || typeof s.id !== 'string' || s.id.length === 0) {
      return { ok: false, detail: 'manifest.scs 含缺 id 或 id 非字符串的条目' };
    }
    if (ids.has(s.id)) {
      return { ok: false, detail: `manifest.scs SC id 重复: ${s.id}` };
    }
    ids.add(s.id);
  }
  const packetScIds = new Set((manifest.dispatch?.packets || []).flatMap((p) => (p.scs_inline || []).map((s) => s && s.id)).filter((id) => typeof id === 'string' && id.length > 0));
  const ledgerScIds = new Set((ledger?.waves || []).flatMap((w) => (w.groups || []).flatMap((g) => (g.sc_ids || []))).filter((id) => typeof id === 'string' && id.length > 0));
  const mismatches = [];
  if (ledger && !setsEqual(ids, ledgerScIds)) {
    mismatches.push(`台账组 sc_ids 缺 ${diffIds(ids, ledgerScIds)} / 多 ${diffIds(ledgerScIds, ids)}`);
  }
  if (!setsEqual(ids, packetScIds)) {
    mismatches.push(`dispatch packets scs_inline 缺 ${diffIds(ids, packetScIds)} / 多 ${diffIds(packetScIds, ids)}`);
  }
  if (mismatches.length > 0) {
    return { ok: false, detail: `SC 集合对账失败: ${mismatches.join('; ')}` };
  }
  return { ok: true, ids };
}

// ② 每条 SC 验收 verdict + 证据锚点强校验
function checkVerdictAnchors(verdict, manifest, manifestError, ledger, repoRoot, headSha, gaps) {
  if (!verdict) { gaps.push({ gate: 'verdict-anchors', detail: 'verdict 文件不存在或不可解析' }); }
  if (!manifest) {
    gaps.push({ gate: 'verdict-anchors', detail: manifestError ? `manifest 不合约: ${manifestError}` : 'manifest 文件不存在或不可解析' });
  }
  if (!verdict || !manifest) return;
  const scv = validateScs(manifest, ledger);
  if (!scv.ok) {
    gaps.push({ gate: 'verdict-anchors', detail: scv.detail });
    return;
  }
  if (verdict.candidate_sha !== headSha) {
    gaps.push({ gate: 'verdict-anchors', detail: `verdict.candidate_sha ${verdict.candidate_sha} != 候选仓 HEAD ${headSha}` });
  }

  const verdictScs = verdict.scs || [];
  const manifestScIds = scv.ids;
  for (const scId of manifestScIds) {
    const entry = verdictScs.find((s) => s.sc_id === scId);
    if (!entry) { gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 在 verdict 中缺失` }); continue; }
    if (entry.status !== 'pass') { gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} verdict status=${entry.status} != pass` }); continue; }
    const evidence = entry.evidence || [];
    if (evidence.length === 0) { gaps.push({ gate: 'verdict-anchors', detail: `SC ${scId} 无证据锚点` }); continue; }
    for (const ev of evidence) {
      // sc-p1g 变异③挖掉点（回退为字符串非空）；F-L: isInsideRepo 已做 realpath 双侧仓内校验（防 symlink 逃逸）
      const anchorFileExists = typeof ev.file === 'string' && ev.file.length > 0 && isInsideRepo(repoRoot, ev.file);
      if (!anchorFileExists) {
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
  // F-O: 台账不可解析时本 gate 自身点名不可用，不拖垮不依赖台账的后项
  if (!ledger) { gaps.push({ gate: 'review-clean', detail: '台账不可用（文件不存在或不可解析）' }); return; }
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

// ---------- →ready receipt 写入（run-ledger READY_RECEIPT_KEYS 消费契约的对端） ----------
// exact schema：{candidate_sha: <40hex>, ledger_version: <非负整数>, checked_at: <非空字符串>}，
// 未知键拒。原子写盘：同目录唯一 tmp（pid + 随机 nonce）+ renameSync。
// ledger_version = 检查时读到的台账 version（不是 +1——ready-check 不驱动台账）；
// run-ledger 消费时要求 receipt.ledger_version == 当前台账 version，检查后任何写操作
// 都会使 receipt 失效（防重放）。返回 null = 成功；字符串 = 失败原因。
function writeReadyReceipt(receiptPath, { candidateSha, ledgerVersion, checkedAt }) {
  const receipt = { candidate_sha: candidateSha, ledger_version: ledgerVersion, checked_at: checkedAt };
  const tmp = tmpPath(receiptPath);
  try {
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(tmp, resolve(receiptPath));
  } catch (e) {
    return `receipt 写入失败: ${e.message}`;
  }
  return null;
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.now !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(args.now)) {
    console.error(`ready-check: --now 必须是 ISO 时间戳（形如 2026-08-09T04:00:00.000Z）: ${args.now}`);
    process.exit(2);
  }
  const config = readJsonOrNull(args.config);
  if (!config || typeof config.reviewMaxRounds !== 'number') {
    console.error('ready-check: config 缺失或 reviewMaxRounds 非数字（fail-closed，拒绝猜测默认值）');
    process.exit(2);
  }
  const reviewMaxRounds = config.reviewMaxRounds;

  const ledger = readJsonOrNull(args.ledger);
  // manifest 经 readManifest 统一收口（receipts 在场/形状契约与 run-ledger 全部消费入口同判据）：
  // 不合约/不可解析 → 转 gap 占位（F-O：不提前 exit，后项照常运行），错误原文随 manifestError
  // 进 gap detail——「可解析但不合约」不得被笼统说成「不可解析」。
  let manifest = null;
  let manifestError = null;
  try { manifest = readManifest(args.manifest); } catch (err) { manifestError = err.message; }

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
  checkLedgerPartition(ledger, manifest, manifestError, gaps);
  checkVerdictAnchors(verdict, manifest, manifestError, ledger, args.repo, headSha, gaps);
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
    console.error('GAP: ready-receipt: 七项全过但未传 --now，拒绝写 receipt（checked_at 需时间戳注入）');
    process.exit(2);
  }
  if (args.receipt === null) {
    // →ready 的消费侧（run-ledger set-state --phase ready）只认 receipt 凭据；不写 receipt
    // 会让 →ready 走不通——fail-closed：无 --receipt 直接拒，与缺 --now 同一档
    console.error('GAP: ready-receipt: 七项全过但未传 --receipt <path>，拒绝输出 READY（→ready 凭据需 ready-check 原子写入 receipt）');
    process.exit(2);
  }
  // 打印 READY 之前写 receipt：内容三项在此处全部可得（candidate_sha=headSha、
  // ledger_version=检查时读到的台账 version、checked_at=注入的 ISO 时间戳）。
  // ready-check 不写台账——phase→ready 由 run-ledger set-state --phase ready
  // --ready-receipt 驱动（锁/CAS/phase 单步/全波集成校验都在它那边）。
  // receipt 未落盘时不得输出 READY 行（写失败 → exit 2 点名）。
  const receiptError = writeReadyReceipt(args.receipt, { candidateSha: headSha, ledgerVersion: ledger.version, checkedAt: args.now });
  if (receiptError !== null) {
    console.error(`GAP: ready-receipt: ${receiptError}`);
    process.exit(2);
  }

  const branchResult = runGit(args.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.status === 0 ? branchResult.stdout : 'unknown';
  console.log(`READY_FOR_SUBMIT_PR ${branch} ${headSha}`);
  process.exit(0);
}

main();
