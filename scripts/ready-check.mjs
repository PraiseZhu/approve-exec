#!/usr/bin/env node
// ready-check.mjs — approve-exec 出口门：七项 exact 合取，全过才输出 READY_FOR_LATER_SUBMIT_PR_SKILL。
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
//   ① ledger-partition  全部组 ∈ {accepted}；组数 == manifest dispatch.packets 数 == 派出记录数；
//                        ledger groups / manifest packets / dispatch 事件三方的 group_id 集合严格相等
//                        （只比数量会被「换成未知 gX 数量仍相同」蒙混）；各组 tip_sha 与台账 delivery 事件对账；
//                        零组（零工作运行）直接拒绝——空集全分区恒真，不能当 READY 放行
//   ② verdict-anchors   manifest.scs fail-closed（非空数组、SC id 唯一）且与 dispatch packets scs_inline /
//                        ledger groups sc_ids 三集合对账一致后才遍历；每条 SC 在 verdict 中 status=pass；
//                        verdict.candidate_sha == HEAD；证据锚点强校验：evidence.file realpath 后在 repo 内
//                        （防仓内 symlink 指向仓外文件冒充锚点）+ summary 与 output_records 内嵌记录逐字一致
//   ③ review-clean      每组 review.rounds ≤ config.reviewMaxRounds 且 unresolved==0；
//                        两层内容等值（修复 sc-p2e：组级审查绑各组 worktree tip → V 波集成
//                        squash/rebase → P 席打包 commit 必然产生新 HEAD，旧「结论交卷
//                        candidate_sha == HEAD」的 SHA 精确等值判据让 READY 结构上不可达；
//                        要守的语义是「审过的内容 == 最终提交的内容」）：
//                          L1 组路径域内容等值——每组「该类组的结论交卷」绑定的 candidate_sha
//                              （已审 tip，执行组 = review 类交卷同类多条取最后一条；验收组 =
//                              verify 类交卷，组类型按 manifest packet.scs_inline 全 kind=verify
//                              判定，同 render-packet；结论交卷缺失 → fail-closed 点名组名与
//                              delivery 类别序列）到当前 HEAD 的 diff 落在该组 packet.allowed_paths
//                              内必须为空；不为空 → FAIL 点名组名与路径；
//                          L2 全树封闭性——HEAD 相对台账 baseline_tip 的 diff 必须全部落在
//                              「全组 allowed_paths 并集 ∪ P 席打包白名单（graph.json
//                              phases.P.packaging_paths）」内；baseline_tip=null（兼容模式）
//                              → stderr WARN 点名跳过（与 run-ledger init 兼容模式同风格）
//   ④ e2e-report        报告存在、status=pass、candidate_sha == HEAD
//   ⑤ presubmit-gates   三闸结果存在、各自 result pass 语义、各自 candidate_sha == HEAD
//   ⑥ git-clean         候选仓 git status --porcelain 为空
//   ⑦ feature-branch    HEAD 在具名 feature 分支（非 main/master、非 detached）
//
// 输出与退出：
//   全过（且 --now/--receipt 已传）→ 原子写入 →ready receipt（exact schema 见 run-ledger.mjs
//   READY_RECEIPT_KEYS 契约；ledger_version = 检查时读到的台账 version，非 +1），随后 stdout 单行
//   `READY_FOR_LATER_SUBMIT_PR_SKILL <branch> <HEAD_SHA>`。receipt 未落盘时不得输出 READY 行（写失败 → exit 2 点名）。
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
import { tmpPath, readManifest, readExecutionManifest, assertManifestBound, assertBaselineReady, findGroup, findPacket, latestPrHandoffDelivery } from './run-ledger.mjs';

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
    else if (a === '--group') args.group = argv[++i];
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

  const notAccepted = groups.filter((g) => g.state !== 'accepted');
  if (notAccepted.length > 0) {
    gaps.push({ gate: 'ledger-partition', detail: `组非 accepted: ${notAccepted.map((g) => `${g.group_id}=${g.state}`).join(', ')}` });
  }
  for (const g of groups) {
    const hasGoal = events.some((e) => e.type === 'gate_goal' && e.detail?.group_id === g.group_id);
    const hasRouting = events.some((e) => e.type === 'gate_routing' && e.detail?.group_id === g.group_id);
    if (!hasGoal) {
      gaps.push({ gate: 'ledger-partition', detail: `${g.group_id} 缺 gate_goal` });
    }
    if (!hasRouting) {
      gaps.push({ gate: 'ledger-partition', detail: `${g.group_id} 缺 gate_routing` });
    }
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

// delivery 事件落盘时无显式类别字段（run-ledger 各写点分别落不同键），类别按 detail 形状判：
//   review:    rounds（record-delivery 审查交卷；validateReviewDelivery 强制非负安全整数）
//   verify:    integration_review_status（record-delivery 验收交卷）
//   exec:      status + tip_sha + scs（record-delivery 执行交卷）
//   prewalk:   first_edit + read_paths + landmines + open_unknowns（第 4 类现场，不绑审查）
//   delivered: 仅 tip_sha + candidate_sha（set-state --to delivered 的交付登记，非 worker 交卷）
// 五者互斥；其余形状一律 unknown（fail-closed 点名，不猜测）。
function deliveryCategory(d) {
  const detail = d?.detail || {};
  if (detail.pr_url && detail.e2e && detail.review && detail.size_gate) return 'pr-handoff';
  if (typeof detail.rounds === 'number') return 'review';
  if (typeof detail.integration_review_status === 'string') return 'verify';
  if (
    detail.first_edit && typeof detail.first_edit === 'object'
    && Array.isArray(detail.read_paths)
    && Array.isArray(detail.landmines)
    && Array.isArray(detail.open_unknowns)
  ) return 'prewalk';
  if (Array.isArray(detail.scs) && typeof detail.tip_sha === 'string') return 'exec';
  if (typeof detail.tip_sha === 'string' && typeof detail.candidate_sha === 'string') return 'delivered';
  return 'unknown';
}

// 组类型判别（与 run-ledger render-packet 同一判据）：packet.scs_inline 全部 kind=verify →
// 验收组；含 fix 或无法判别 → 执行组。验收组没有 review 阶段（delivered 后直接出验收交卷，
// DELIVERY_LIFECYCLE 注释「验收组（kind=verify）在 delivered 后立即出 verdict 是其交付物」），
// 其「审查结论」的绑定对象是 verify 交卷；执行组才有 review 交卷。空 scs_inline 恒非验收组
// （every 对空数组恒真，必须 length>0 守卫，与 run-ledger PACKET_INCOMPLETE 同向 fail-closed）。
function isVerifyGroup(packet) {
  const scs = packet?.scs_inline;
  if (!Array.isArray(scs) || scs.length === 0) return false;
  return scs.every((s) => s && typeof s === 'object' && s.kind === 'verify');
}

// ③ 每组审查收敛 + 两层内容等值出口门（sc-p2e 修复：组级审查绑各组 worktree tip → V 波
// 集成 squash/rebase → P 席打包 commit 必然产生新 HEAD，「结论交卷 candidate_sha == 当前
// HEAD」的 SHA 精确等值判据让 READY 成为结构上不可达终态。要守的语义是「审过的内容 ==
// 最终提交的内容」，改为两层内容等值，均为确定性 git 命令、fail-closed）：
//   L1 组路径域内容等值——每组结论交卷绑定的 candidate_sha（已审 tip）→ 当前 HEAD 的 diff
//      落在该组 allowed_paths 内必须为空（审过的字节没变即可，不再要求 SHA 精确等值）；
//   L2 全树封闭性——HEAD 相对台账 baseline_tip 的 diff 必须全部落在「全组 allowed_paths
//      并集 ∪ P 席打包白名单（graph.json phases.P.packaging_paths）」内；baseline_tip=null
//      （兼容模式）→ stderr WARN 点名跳过（与 run-ledger init 兼容模式既有处理风格一致）。
function checkReviewClean(ledger, manifest, repoRoot, headSha, reviewMaxRounds, packagingPaths, gaps) {
  // F-O: 台账不可解析时本 gate 自身点名不可用，不拖垮不依赖台账的后项
  if (!ledger) { gaps.push({ gate: 'review-clean', detail: '台账不可用（文件不存在或不可解析）' }); return; }
  const groups = (ledger.waves || []).flatMap((w) => w.groups || []);
  const events = ledger.events || [];
  const packets = manifest?.dispatch?.packets || [];
  for (const g of groups) {
    const review = g.review || {};
    if (typeof review.unresolved !== 'number' || review.unresolved !== 0) {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} review.unresolved=${review.unresolved} != 0` });
    }
    if (typeof review.rounds !== 'number' || review.rounds > reviewMaxRounds) {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} review.rounds=${review.rounds} > reviewMaxRounds=${reviewMaxRounds}` });
    }
    const deliveries = events.filter((e) => e.type === 'delivery' && e.detail?.group_id === g.group_id);
    // 绑定对象是「该类组的审查结论交卷」本身，不是「最后一条交卷」：执行组生命周期允许
    // review 交卷在 delivered 入账（candidate_sha 可能是审查时的旧树）、verify 交卷在
    // review_pass 入账（candidate_sha = 当时 HEAD）且排在 review 之后——拿最后一条会把
    // verify 的 SHA 顶替掉 review 实际审查所绑的旧 SHA，「审查绑在当前候选」被后来的验收
    // 交卷遮成恒真。验收组无 review 阶段，其结论交卷就是 verify（无后续交卷，无遮蔽面）。
    // 同类多条（多轮审查各入账一次）取最后一条：最后一轮的 candidate_sha 才是审查结论所绑
    // 的树，之前轮次的旧树已被后续轮次覆盖修正。
    const packet = packets.find((p) => p.group_id === g.group_id);
    const groupIsVerify = isVerifyGroup(packet);
    const bindingKind = groupIsVerify ? 'verify' : 'review';
    const binding = deliveries.filter((d) => deliveryCategory(d) === bindingKind);
    const lastBinding = binding[binding.length - 1];
    if (!lastBinding) {
      // D2 fail-closed：该组结论交卷缺失不得回落到「最后一条」或「视为通过」——否则
      // delivered 登记/exec/verify（执行组）会冒充审查绑定；消息带组名与实际类别序列。
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} 无 ${bindingKind} 类交卷（${groupIsVerify ? '验收组' : '执行组'}，delivery 类别序列: ${deliveries.map(deliveryCategory).join(', ') || '无'}）` });
    } else if (typeof lastBinding.detail.candidate_sha !== 'string') {
      gaps.push({ gate: 'review-clean', detail: `${g.group_id} 审查交卷（${bindingKind} 类 delivery）缺 candidate_sha 绑定` });
    } else {
      // L1 组路径域内容等值：已审 tip（该组结论交卷绑定的 candidate_sha，即审查时的树）→
      // 当前 HEAD 在组 allowed_paths 内必须零 diff。集成 squash/rebase/P 席打包都会产生新
      // HEAD——SHA 精确等值因此不再适用；改证「审过的字节没变」。git 无法解析已审 tip
      // （过期/伪造 SHA）→ fail-closed 点名，不猜测不降级。
      const allowedPaths = Array.isArray(packet?.allowed_paths) ? packet.allowed_paths : [];
      const reviewedTip = lastBinding.detail.candidate_sha;
      const domainDiff = runGit(repoRoot, ['diff', '--name-only', reviewedTip, headSha, '--', ...allowedPaths]);
      if (domainDiff.status !== 0) {
        gaps.push({ gate: 'review-clean', detail: `${g.group_id} 已审 tip ${reviewedTip} 无法与当前 HEAD 比较（${domainDiff.stderr}）` });
      } else if (domainDiff.stdout.length > 0) {
        gaps.push({ gate: 'review-clean', detail: `${g.group_id} 组路径域在已审 tip ${reviewedTip} 之后被修改: ${domainDiff.stdout.split('\n').filter(Boolean).join(', ')}（审查绑定的是 ${reviewedTip}，集成/打包不得改动组域内容）` });
      }
    }
  }
  // L2 全树封闭性（组循环外一次）：HEAD 相对台账 baseline_tip 的 diff 必须全部落在「全组
  // allowed_paths 并集 ∪ P 席打包白名单」内——集成/打包不得引入任何组域与打包白名单之外
  // 的改动。baseline_tip=null = 兼容模式（无基线可比），沿用 run-ledger init 兼容模式
  // 既有处理风格：stderr WARN 点名跳过，不得静默。
  const baseline = ledger.baseline_tip ?? null;
  if (baseline === null) {
    console.error('ready-check: [WARN] gate ③ 第 2 层（全树封闭性）跳过：台账 baseline_tip=null（兼容模式，无基线可比）——HEAD 相对基线的越域改动不会被本闸拦下（与 run-ledger init 兼容模式同语义）');
  } else {
    const treeWhitelist = [
      ...packets.flatMap((p) => (Array.isArray(p.allowed_paths) ? p.allowed_paths : [])),
      ...(Array.isArray(packagingPaths) ? packagingPaths : []),
    ];
    const treeDiff = runGit(repoRoot, ['diff', '--name-only', baseline, headSha]);
    if (treeDiff.status !== 0) {
      gaps.push({ gate: 'review-clean', detail: `全树封闭性: 基线 ${baseline} 无法与当前 HEAD 比较（${treeDiff.stderr}）` });
    } else {
      // 路径命中判据 = 全等或目录前缀（w='src/' 命中 'src/lib/a.ts'；w 是文件则仅全等）。
      // 白名单外的任何文件（新增/修改/删除）都算封闭性违反，逐路径点名。
      const outside = treeDiff.stdout.split('\n').filter(Boolean)
        .filter((f) => !treeWhitelist.some((w) => f === w || f.startsWith(`${w}/`)));
      if (outside.length > 0) {
        gaps.push({ gate: 'review-clean', detail: `全树封闭性违反: 以下路径不在任何组 allowed_paths 或 P 席打包白名单内: ${outside.join(', ')}（基线 ${baseline} → HEAD ${headSha}）` });
      }
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
function writeReadyReceipt(receiptPath, { candidateSha, ledgerVersion, checkedAt, groupReceipt }) {
  const receipt = { candidate_sha: candidateSha, ledger_version: ledgerVersion, checked_at: checkedAt, ...groupReceipt };
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

  // gate ③ 第 2 层（全树封闭性）的打包白名单唯一真相源 = graph.json P 席位 packaging_paths
  // （默认至少含 .pr-intent.md，由 graph.test.mjs 结构断言锁死）。缺失/非数组 = 配置损坏，
  // fail-closed 点名，不静默降级到内置默认值。
  const graph = readJsonOrNull(join(root, 'graph.json'));
  const packagingPaths = graph?.phases?.P?.packaging_paths;
  if (!Array.isArray(packagingPaths)) {
    console.error('GAP: review-clean: graph.json 缺 P 席 packaging_paths（打包白名单唯一真相源，fail-closed 拒绝猜测）');
    process.exit(2);
  }

  let ledger = readJsonOrNull(args.ledger);
  // manifest 经 readManifest 统一收口（receipts 在场/形状契约与 run-ledger 全部消费入口同判据）：
  // 不合约/不可解析 → 转 gap 占位（F-O：不提前 exit，后项照常运行），错误原文随 manifestError
  // 进 gap detail——「可解析但不合约」不得被笼统说成「不可解析」。
  let manifest = null;
  let manifestError = null;
  try { manifest = ledger?.pr_plan ? readExecutionManifest(ledger, args.manifest) : readManifest(args.manifest); } catch (err) { manifestError = err.message; }
  let groupReceipt;
  if (ledger?.pr_plan && !args.group) {
    console.error('GAP: group-ready: 新版执行计划必须按 --group 验收业务 PR');
    process.exit(2);
  }
  if (args.group) {
    try {
      assertManifestBound(ledger, manifest, 'ready-check --group');
      const group = findGroup(ledger, args.group);
      const packet = findPacket(manifest, args.group);
      if (ledger.pr_plan) {
        assertBaselineReady(ledger, args.group, manifest);
      }
      if (group.state !== 'accepted' || !group.base || !group.worktree
        || realpathSync(group.worktree) !== realpathSync(args.repo)) {
        throw new Error('单 PR 验收要求 accepted、明确 base 和匹配的 worktree');
      }
      groupReceipt = { group_id: args.group, assignment_seq: group.assignment_seq ?? 0,
        manifest_core_hash: ledger.manifest_core_hash, base: group.base,
        ...(ledger.pr_plan ? { execution_plan_hash: ledger.pr_plan.plan_hash } : {}) };
      const events = ledger.events.filter((event) => event.detail?.group_id === args.group
        && (event.detail.assignment_seq ?? 0) === (group.assignment_seq ?? 0));
      const candidate = latestPrHandoffDelivery(ledger, args.group);
      if (!candidate || candidate.review?.candidate_sha !== group.tip_sha
        || candidate.review?.unresolved !== 0) throw new Error('单 PR 缺当前 candidate 审查证据');
      const projectedReview = { type: 'delivery', detail: { group_id: args.group, rounds: group.review.rounds,
        candidate_sha: candidate.review.candidate_sha } };
      ledger = { ...ledger, baseline_tip: group.base, waves: [{ wave: 1, groups: [group] }],
        events: [...events, projectedReview] };
      manifest = { ...manifest, scs: manifest.scs.filter((sc) => group.sc_ids.includes(sc.id)),
        dispatch: { ...manifest.dispatch, packets: [packet] } };
    } catch (error) {
      console.error('GAP: group-ready: ' + error.message);
      process.exit(2);
    }
  }

  const headResult = runGit(args.repo, ['rev-parse', 'HEAD']);
  if (headResult.status !== 0) {
    console.error(`GAP: git-clean: 无法读取候选仓 HEAD: ${headResult.stderr}`);
    process.exit(2);
  }
  const headSha = headResult.stdout;
  if (ledger?.pr_plan) {
    const size = runGit(args.repo, ['diff', '--numstat', '--no-renames', ledger.baseline_tip, headSha, '--']);
    const rows = size.stdout.split('\n').filter(Boolean).map(row => row.split('\t').slice(0, 2));
    if (size.status !== 0 || rows.some(row => row.length !== 2 || row.some(value => !/^\d+$/.test(value)))
      || rows.reduce((total, row) => total + Number(row[0]) + Number(row[1]), 0) >= 800) {
      console.error('GAP: pr-total-lines: 含测试的新增＋删除必须严格 <800，无法计数亦拒绝');
      process.exit(2);
    }
  }
  if (args.group) {
    const group = findGroup(ledger, args.group);
    const branch = runGit(args.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (headSha !== group.tip_sha || branch.status !== 0 || branch.stdout !== group.branch) {
      console.error('GAP: group-ready: 当前 HEAD/branch 不匹配本组已验收提交与分支');
      process.exit(2);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    console.error(`GAP: git-clean: 候选仓 HEAD 非 40 位十六进制: ${headSha}`);
    process.exit(2);
  }

  let verdict = readJsonOrNull(args.verdict);
  if (args.group && verdict && Array.isArray(verdict.scs)) {
    const ids = new Set(manifest.scs.map((sc) => sc.id));
    verdict = { ...verdict, scs: verdict.scs.filter((sc) => ids.has(sc.sc_id)) };
  }
  const e2eReport = readJsonOrNull(args.e2eReport);

  // 七项逐项独立检查，全部跑完再收束（不因前项失败跳过后项）
  const gaps = [];
  checkLedgerPartition(ledger, manifest, manifestError, gaps);
  checkVerdictAnchors(verdict, manifest, manifestError, ledger, args.repo, headSha, gaps);
  checkReviewClean(ledger, manifest, args.repo, headSha, reviewMaxRounds, packagingPaths, gaps);
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
  const receiptError = writeReadyReceipt(args.receipt, { candidateSha: headSha, ledgerVersion: ledger.version, checkedAt: args.now, groupReceipt });
  if (receiptError !== null) {
    console.error(`GAP: ready-receipt: ${receiptError}`);
    process.exit(2);
  }

  const branchResult = runGit(args.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.status === 0 ? branchResult.stdout : 'unknown';
  console.log(`${args.group ? 'LOCAL_PR_VALIDATED' : 'READY_FOR_LATER_SUBMIT_PR_SKILL'} ${branch} ${headSha}`);
  process.exit(0);
}

main();
