---
name: approve-exec
description: 批准执行——lead 侧多 worker loop 编排：把 task-priority final 阶段释放的 task-manifest.json 自动执行到「可直接『提交 PR』」的候选分支。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — lead 编排守则

**lead 按本文编排**（所有执行工作派 worker），把 task-priority 产出的 `task-manifest.json` 自动推进到「可直接『提交 PR』」：
五阶段状态机 E(执行)→R(审查修复)→V(波集成+SC 验收)→T(e2e)→P(打包)→READY，lead 只编排决策、不亲手执行。
生态链：task-priority（出 manifest）→ **本 skill（lead 编排 loop）** → goal（worker 端场景 C 消费派工包）→ submit-pr（三审收口）。

本文是 lead 侧编排的**唯一守则**：换会话、换模型后按本文执行，编排行为不漂移（机器保障：`scripts/run-tests.mjs` 冻结枚举 + `tests/skill-doc.test.mjs` 结构断言，见第⑭段）。共十七段。

## ① 身份与触发

- frontmatter：`name: approve-exec`，触发词「批准执行」。
- 用法（触发词参数由 **lead** 输入，全部执行工作派 worker）：`批准执行`（默认用当前最新 final manifest 开跑）/ `批准执行 --resume <run_id>`（从台账恢复，见第⑥段）/ `批准执行 --no-budget-pause`（关闭预算暂停类停，见第⑤段）。
- 本 skill 是 **lead 编排层**：不写业务代码，全部执行工作派给 worker（场景见第④段 D1）。

## ② 输入门：只消费 task-priority final manifest

- 唯一输入：task-priority **final 阶段释放**的 manifest——顶层含 `waves` / `dispatch` / `receipts` 三要素，packets 每包含 `scs_inline` / `allowed_paths` / `verify_cmds` / `forbidden` / `submit_format` 五要素（与 `run-ledger` render-packet 出包前五项校验逐字对齐）。
- **fail-closed**：manifest 缺 `waves`/`dispatch`/`receipts` 任一、或文件不存在、或 packet 缺五要素任一 → 视为 draft/缺 manifest，**不开跑**，停下指路 task-priority（先回上游产出 final manifest）。不得拿「差不多能跑」的中间产物开跑。**机器闸如实标注（全部有机器校验，无依赖 lead 手工检查的项）**：文件不存在/非对象与 `receipts` 键在场（readManifest，`scripts/run-ledger.mjs`；在场契约收口于唯一入口，init/validate/render-packet/record-delivery/set-state→ready 全部消费命令同判据，可空数组）、`receipts` 形状（readManifest 内 assertReceiptsSchema，未知键/类型错拒）、`waves` 非空数组与组 `sc_ids` 非空（init，initLedger）、`dispatch.packets` 存在且组有对应 packet、packet 五要素齐全（render-packet，PACKET_INCOMPLETE）。

## ③ 五阶段状态机与每边三动作

```
E(执行) → R(审查修复) → V(波集成+SC验收) → T(e2e) → P(打包) → READY
```

- 阶段图真相源是 `graph.json`（席位表：E/R/V/T/P 五席，各自 route 档，E 钉 agent_pin，R 钉 agent_pin + model/effort，先例 = submit-pr Phase 2 席位表）；本段只描述编排行为，不承载席位数据。
- **lead 每边固定五步硬定序检查单**（任何阶段之间一律如此，不许跳过；**顺序不可交换**——尤其 archive 先于 probe，使腾出的槽位天然计入下一环节）：
  1. **收结构化交卷**：只认 `run-ledger` record-delivery 入账的 exact schema 交卷（exec / review / verify / prewalk 四类，多余键或缺失键都拒）；lead 不做手工转录。（机器闸：`scripts/run-ledger.mjs` record-delivery）
  - **PreWalk（第 4 类交卷）**：波 0 = 第一波第一组。该组 dispatched 后先交恰好一条 prewalk（`first_edit`/`read_paths`/`landmines`/`open_unknowns`），不改组状态，再 archive；随后仍走 exec。入账后若后续组发现 first_edit 相对当前树已漂移（rebase/squash 后 sha 不再祖先、或 path 内容已变），**整波**退回第一组重做 PreWalk——first_edit 失效不得假装现场仍活。
  2. **archive 全部 done/idle/error worker**——**汇报即清理（owner 硬指令(二)，2026-08-10）**：触发时机 = worker 交卷汇报一到即在同一轮动作内 archive，**不得攒批、不得延后到下一环节、不得用 idle 顶替**。明示：**不是 idle**——idle 只释放进程、**不释放槽位**；只有 archive 才释放并发槽位。（无机器闸：archive/idle 语义是 Orca 平台行为，按时执行依赖 lead）
  3. **list_workers 取实数**：调 `list_workers` 读当前 worker 清单，**禁止心算/凭记忆**填 used_slots——记录实数（第 2 步已 archive 的槽位此刻已释放）。（无机器闸：list_workers 读数是平台查询，取实数依赖 lead 执行）
  4. **mem-probe 现算并发**：`mem-probe --json --used-slots <第 3 步实数> --pending <待派组数>` 现算可用并发（并发公式见第④段 D2；`--pending` 同为必填，缺任一即 exit 2）。（机器闸：`scripts/mem-probe.mjs` 输出即槽位判据）
  5. **create_workers 整批派发 + 落账**：同批 ≥2 worker 用 `create_workers` 批量派发（禁连续单发，见第⑨段），随后逐组 `set-state --group <gid> --to dispatched --now <ts> --mem-snapshot '<json>'` 落账（`--now` 是写操作通用必填时间戳，缺省即 exit 2 `NOW_REQUIRED`）——快照四键 `used_slots`/`platform_cap`/`concurrency`/`available_bytes` 由 lead 从 `mem-probe --json` 的 9 键输出中提取构造（原样直喂 9 键会被 exact 校验拒，提取步骤即本步，见第⑮段迁移⑦⑧⑨）。（机器闸：`scripts/run-ledger.mjs` set-state 快照闸 + 凭证闸）

## ④ 设计决策 D0–D4

- **D0（owner 拍板）**：执行环节（写代码）的派工包**必须以 goal skill 场景 C 触发**——包内首行「用 goal skill 执行。」+ 单独一行 `--until-sc`。连锁约束：execute 席 agent 钉死 claude-code（goal 声明 codex 加载不到）；routing fallback 链中**非 claude-code 候选跳过**，候选耗尽 = A 类 fail-closed，**禁止「内联等价契约给 codex」变通**（详见第⑦段）。
- **D1（lead 只编排，owner 硬指令(三)，2026-08-10）**：lead 一律不亲手执行具体任务——一切执行/验证/打包工作必须派 Orca worker（或用户点名 sub 时派原生 subagent），lead 只做编排/决策/台账对账（确定性脚本），不亲手跑验证、不代写交卷；SC 复验派**独立 verify worker**（≠ 作者 worker）；违反即汇报链路膨胀、效率下降。
- **D2（并发公式）**：并发 = min(内存允许, Orca 平台硬上限 `orcaPlatformCap`=8, 待派组数)，**每次派工前现跑 mem-probe**。「不设上限」的物理含义 = 始终拉满 8；内存探测（`memReserveRatio` + `perWorkerBytes` 切分）是护栏（防多 loop 挤兑），非常态瓶颈。
- **D3（R 席命令）**：R 席跑 claude-code 内置 `/code-review high --fix`（owner 确认为内置命令，带强度与 `--fix`），只能 claude-code agent；R 席 model/effort 由 `graph.json` 席位表**显式钉死**为 `anthropic-claude/claude-sonnet-5` / `xhigh`（owner 2026-08-10 拍板，模型 ID 已用 models.cache.json 核实存在于 claude_code agent，tier=standard；**不再从 routing execute 档取值**）；**不改 routing.json 四档**（review 档语义留给 submit-pr 三审）；席位表落本 skill `graph.json`。
- **D4（组级审查）**：每组 execute 交付后**立即在该组 worktree 内审+修**（各组可并行）；跨组问题由波级 SC 验收 + e2e 兜底。审查修复 ≤ `reviewMaxRounds` 轮不收敛 = 硬阻碍上报（见第⑤段）。

## ⑤ 不停机条款（仅三类停）

仅以下三类情况允许停，此外全程自主执行、不弹确认（本条无机器闸，依赖 lead 遵守；第 1 类为全局 autonomous-execution 规则、第 2 类为全局 orca-model-routing 规则，均无本仓脚本强制）：

1. **autonomous-execution 硬停清单**（push --force 到 main、删远程分支/标签、删生产数据、提交密钥、对外不可撤回消息、改 CI/CD 配置）。
2. **A 类配置 fail-closed**（模型路由规则的配置级失败：routing.json 读不到/解析失败/档 key 缺失/字段非法/模型 ID 核对不过等——停，报 lead 侧按规则处理）。
3. **预算告警暂停**：累计预算打到 `budgetPauseUsd`（$30）时**暂停等确认**（语义是暂停，不是失败；用户说继续即可恢复）；`--no-budget-pause` 可关闭第三类。计量方式的如实声明见第⑫段。

配套纪律：

- **禁确认句式**：不用 AskUserQuestion / 「要开始吗？」类确认，编排过程只出简报、不停顿。
- **防跑飞**：借 goal `--until-sc` 防跑飞纪律——**连续 3 轮零增量自报卡死**，摊开卡点，不得空转。
- **worker 超时重派**：`workerTimeoutMinutes`（40min）无交卷 → 该轮按失败收束，归档该 worker 并重建、重派（台账走 timeout_redispatch 事件，rounds 归零、worktree 换新）。
- **审查不收敛**：审查修复轮数超过 `reviewMaxRounds`（3 轮）仍未 unresolved==0 → 硬阻碍，**上报**（不是静默放行）。

## ⑥ 断点续跑：--resume <run_id>

- 一切状态落 run 台账：`runLedgerDir`（`~/.claude/.orca/approve-exec/<run_id>.json`），**不进仓**；`<run_id>` 是台账文件名（不含扩展名）。
- **`--resume` 是 skill 触发词参数，不是 `run-ledger` 的 CLI 子命令**：正确用法只有 `批准执行 --resume <run_id>`（lead 输入）；对脚本传 `node scripts/run-ledger.mjs --resume <id>` 会报「未知子命令」退出非零（实测 exit 1，`run-ledger.mjs` 无此子命令——两个审查席都误读过这个，先看清执行者再敲命令）。
- **恢复动作由 lead 执行**：读台账文件重建五阶段位置、已派组状态、已集成 tip、未决组队列，继续跑。台账写操作带版本乐观锁（CAS），并发写冲突 exit 2，不静默覆盖（机器闸：`scripts/run-ledger.mjs` writeLedgerAtomic）。
- 台账即唯一状态源：换会话、换模型后 `--resume` 即可无缝续跑，不需要人工回忆进度。（结构性成立：`runLedgerDir` 在仓外且 run-ledger 只读写台账；「lead 不另建状态」依赖 lead 遵守）

## ⑦ 模型现读纪律

- **硬指令（owner 2026-08-10 拍板）**：E/V/T/P 四席派 worker 前**必须现读模型说明书**配置 model/effort——真相源 = `routing.json`（`routingPath` 指向，`orca-model-routing` 规则指定为真相源）+ `model-route show` 可核对；**禁凭记忆填值，禁跳过读取直接派**。**R 席例外**：model/effort 由 `graph.json` 席位表显式钉死（见第④段 D3，owner 2026-08-10 拍板），**不从 routing 取值**。本 skill 的 `graph.json` 只引路由档名（E 钉 agent_pin），其余席位永不内嵌具体模型 ID——模型在派工时现读 routing.json。
- E 席（goal 场景 C）要求 agent 家族 = claude-code：**routing fallback 链中非 claude-code 候选一律跳过**，只沿链找 claude-code 候选。（本条无机器闸，依赖 lead 遵守；routing.json 内容合法性的机器校验在 `scripts/selfcheck.mjs` 与全局 model-route 脚本。R 席不走 routing：agent_pin=claude-code、model/effort 由席位表钉死，见第④段 D3。）
- 候选耗尽（E 席无 claude-code 可派） = **A 类 fail-closed**：停，向用户报告（路由档、已试候选、错误原文），等指令；**禁止「内联等价契约给 codex」变通**（codex 加载不到 goal skill，等价契约不成立）。（R 席无此问题——不走 routing，model/effort 钉死，无候选链可耗尽。）
- 派工说明必须标注实际使用模型（如 `(model/effort)`），多 worker 贴紧凑台账但不阻塞流程。

## ⑧ pr-submit-gate 传导

- `needs_three_review` 判定（功能改动需 submit-pr 三审 / 非功能性小 PR 免三审，按 `pr-submit-gate` 规则的「按实质不按标题」判据）**从 manifest packets 透传进派工包**：render-packet 出包时把该组的门禁结论写进包内说明区，worker 执行时按边界行事（该 push 的 push、该停的停）。
- 对外 mark ready、合并等动作仍**逐次授权**：历史授权/其他会话授权不可引用；派工包内点名的授权只对当次生效。
- 本 skill 的交付物 = 「候选分支 + 台账」，**不是** PR：开正式 PR 由用户在 submit-pr 链路完成后进行（或按当次授权由合并侧流程处理）。

## ⑨ 批量派工与槽位纪律

- **整波派发一律 `create_workers` 批量工具**（同批 ≥2 worker 禁连续 `create_worker` 单发）；只有波内确实只有 1 个 worker 时才允许 `create_worker`。（本条无机器闸，依赖 lead 遵守：平台侧不拦单发，`tests/skill-doc.test.mjs` 只保证文档表述存在）
- **每轮必清槽位**：交付/done/idle/error 的 worker 立即 archive（归档即释放槽位）；idle 不释放槽位，禁止用 idle 代替 archive 占着槽位。（无机器闸，依赖 lead 遵守；archive 释放槽位是 Orca 平台语义）
- 归档后槽位数立即反映到下一批的并发公式（第④段 D2）；台账 dispatch 记录与归档动作一一对应。

## ⑩ 术语边界：V 阶段验收组 ≠ orca-fanout verify 组

- 本 skill 的 **V 阶段验收组**：**零代码修改**，只跑 verify 命令出 verdict + 整合树复查（integrated_tip 相对上一集成点的 squash diff 交互面复查），出包用 `run-ledger` 验收模板（render-verify，不带 goal 触发行）。
- **orca-fanout 的 verify 组**：语义不同——允许改测试路径。
- **派工包模板二者分开，禁互套**：验收组的包不得带「可改测试」授权，orca-fanout verify 组的包不得套用「零修改」措辞；lead 打包时按组 kind 选模板，出错包即 fail-closed。

## ⑪ P 阶段职责：.pr-intent.md workfile

- P 阶段（打包）worker：先从 manifest 的 goal/priorities 生成 **`.pr-intent.md`** workfile（意图声明，落在候选分支工作区），**之后**才运行 intent-check（presubmit 三闸：size / format / intent）。
- **`.pr-intent.md` 的创建责任在本 skill 的 P 阶段，不在 submit-pr**；submit-pr 只消费该文件做 intent 核对。
- 出口门由 `ready-check` 执行（机器闸：`scripts/ready-check.mjs` 七项检查，任一 gap 即 exit 2 点名，全齐才 exit 0 输出 READY_FOR_SUBMIT_PR）：全组 verified + 每 SC PASS 锚点 + 审查 unresolved==0 + e2e PASS + presubmit 三闸结果**绑定候选 HEAD SHA**。
- **gate ③（review-clean）两层内容等值（sc-p2e 修复）**：组级审查绑各组 worktree tip → V 波集成 squash/rebase → P 席打包 commit 必然产生新 HEAD，旧「结论交卷 candidate_sha == 当前 HEAD」的 SHA 精确等值判据让 READY 成为结构上不可达终态；要守的语义是「审过的内容 == 最终提交的内容」，两层均为确定性 git 命令、fail-closed：
  - **L1 组路径域内容等值**：每组结论交卷绑定的 candidate_sha（已审 tip，执行组=review 类交卷 / 验收组=verify 类交卷）→ 当前 HEAD 的 diff 落在该组 `allowed_paths` 内必须为空，非空即 FAIL 点名组名与路径（已审 tip 无法解析同样 FAIL-closed）；
  - **L2 全树封闭性**：HEAD 相对台账 `baseline_tip` 的 diff 必须全部落在「全组 `allowed_paths` 并集 ∪ P 席打包白名单」内，越域即 FAIL 逐路径点名；打包白名单 = `graph.json` P 席位 `packaging_paths`（唯一真相源，默认至少含 `.pr-intent.md`，缺失即 fail-closed 拒）；`baseline_tip=null`（兼容模式）→ stderr WARN 点名跳过（与 run-ledger init 兼容模式既有处理风格一致，不得静默）。
  - **残余声明**：内容等值只证「审过的字节没变」，不证「rebase 后与新 base 的交互面语义仍成立」——该维度由 submit-pr 三审兜底。

## ⑫ 预算告警如实声明

- **lead 侧无可靠 token 计量源**，不假装有精确计量。`budgetPauseUsd`（$30）线按以下方式执行并在**暂停消息中标注计量方式**：
  - 宿主 usage 可见（能从宿主读取累计 token/花费）→ 读取真实值计量；
  - 不可见 → 以「worker 数 × 轮次」粗估（每 worker 每轮按估算单价），并在暂停消息中写明「粗估，非精确计量」。
- `--no-budget-pause` 关闭第三类停时，同样在开场简报标注「预算暂停已关闭」。

## ⑬ 已知残余声明

三条「接受残余并声明」，如实写在台账与交付报告里，不包装成已解决：

1. **批次收缩序列**：内存收缩导致的批次序列（如 3,3,1）视为**满载合规**——满载判据以**派发时刻 mem-probe 输出**为准，不要求每波都打到 8。
2. **目标仓 build/typecheck SC 缺失不代补**：manifest 若缺目标仓 build/typecheck SC，本 skill **不代补**（上游 task-priority 起草责任），submit-pr P1 typecheck-merged 兜底。
3. **版本 bump 无核对**：各仓版本策略不一，本 skill 不做版本 bump 核对，submit-pr 三审兜底。

## ⑭ 保证等级声明

- 本 skill 的保证等级是 **T1：防疏忽/漂移**——通过结构断言测试（机器闸：`scripts/run-tests.mjs` 冻结枚举 + `tests/skill-doc.test.mjs` 章节/字面量断言）、doc↔实现字面量同步（如「用 goal skill 执行。」）、config 键名引用比对，保证编排行为按守则执行、不因会话/模型更换而漂移。
- **不防恶意 worker 伪造交卷**：本 skill 的机制不承诺对抗伪造——兜底 = 独立 verify 席复验（非作者 worker 出 verdict）+ submit-pr 三审收口。
- 交付报告不得把保证等级写成夸大类措辞；残余与保证边界按第⑬段、本段如实声明。

## ⑮ 破坏性变更迁移表（旧用法 → 现在 → 替代）

2026-08 实现收敛期移除了七条 CLI 旧用法（另有两条配套纪律一并列出），按旧文档调用会 fail-closed（exit 2 点名）。下表逐条列「旧调用 → 现在会怎样 → 替代」；「lead 动作」= lead 执行，「脚本判据」= 脚本机器校验（本表退出码均为实测）。

| # | 旧调用（已失效） | 现在会怎样（实测） | 替代（当前唯一合法路径） |
|---|---|---|---|
| 1 | `set-state --ready-check-exit0 1`（布尔凭据，等号/空格两种形式都传不进） | exit 2：`--ready-check-exit0 布尔凭据已移除：→ready 只能由 ready-check 写入的 receipt 驱动` | lead 用 `run-ledger set-state <ledger> --phase ready --ready-receipt <path>`（合法 receipt 实测 exit 0）；receipt 由 ready-check 按消费契约产出（推荐 `<ledgerPath>.ready-receipt.json`，exact 三键 `candidate_sha`/`ledger_version`/`checked_at`，version 必须等于台账当前 version，candidate_sha 必须等于最终集成树） |
| 2 | `set-state --verify-status pass` / `set-state --verify-evidence-ref delivery#N`（手工写入口） | exit 2：`已移除：verified 的 pass 凭据只能由验收组 record-delivery 写入` | **lead 动作**：组进 verified 前先让验收组经 `record-delivery` 交 verify 类交卷；**脚本判据**（机器闸）：evidence_ref 必须形如 `delivery#<n>` 且 <n> 能解析到 events 中真实存在的 delivery 事件，否则 exit 2「凭据伪造拒」（实测伪造 delivery#999 → exit 2） |
| 3 | 在 `tests/` 顶层新增 `*.test.mjs` 后直接跑 run-tests | exit 2：`tests/ 顶层存在未枚举的测试文件`（双向 fail-closed：枚举文件被删同样 exit 2 `枚举的测试文件缺失`） | 新增测试文件必须同步进 `scripts/run-tests.mjs` 的 TEST_FILES 冻结数组（字母序）；删测试文件同理要先从数组移除 |
| 4 | 改过 manifest 内容后复用旧台账跑 validate / render-packet / record-delivery | exit 2：`[HASH_MISMATCH] manifest core hash 不匹配：台账=…，现算=…（manifest 内容已变/异本，内容绑定拒）` | 消费命令按 manifest_core_hash 内容绑定（机器闸：`scripts/run-ledger.mjs` assertManifestBound）；manifest 内容变更即旧台账失效——改 manifest 后必须重 init 台账（或恢复原内容），不得复用旧台账 |
| 5 | 台账 phase 已到 ready 后继续写（set-state / record-delivery） | exit 2：`[FROZEN] 台账已 ready（phase=ready），冻结只读，拒绝写操作` | ready 是**终态不可逆**（机器闸：`scripts/run-ledger.mjs` setState 入口冻结，ready 后一切写操作拒）；任何补写必须在 ready 之前完成，READY_FOR_SUBMIT_PR 输出即收手 |
| 6 | （无旧调用；编排开跑前的最佳实践） | — | **lead 动作**：开跑前先跑 `node scripts/selfcheck.mjs --live`（机器闸：`scripts/selfcheck.mjs`）：校验 routing 四档 agent/model/effort 合法、orca-fanout 两脚本存在、goal SKILL.md 存在、runLedgerDir 可写、live symlink 指向本仓 checkout 根、`~/.claude/rules/skill-trigger-scan.md` 含精确触发行；任一 FAIL exit 2 点名（实测全过 exit 0） |
| 7 | init 不带 `--baseline <sha>`（sc-p0a 前的旧用法，无基线语义直接开跑） | CLI 缺省显式传 null → **兼容模式 exit 0**（实测：baseline=null，基线闸/快照闸/凭证闸三道 P0 新闸全部跳过，且 stderr 输出 `[WARN]` 点名「三道 P0 新闸全部不生效」——警告有测试保护，不可静默移除）；函数层 in-process 漏传则拒（`init 缺 --baseline <sha>`） | **lead 动作**：缺省 = 兼容模式 = **三道 P0 闸不生效**是**显式设计决策，不是后门**——仅供 e2e-dryrun 等无基线语义的旧路径与 sc-p0a 前创建的旧台账（缺 `baseline_tip` 键读入即归一化为 null）；生产 run 必须显式传 `--baseline <40hex>` 走**严格模式**（sc-p0a 基线闸强制；非 40hex 即 exit 2） |
| 8 | set-state dispatched 不带 `--mem-snapshot`（sc-p0b 前的旧用法） | exit 2（实测）：`缺失前置：→dispatched 必须携带 --mem-snapshot '<json>'（四键 used_slots/platform_cap/concurrency/available_bytes，lead 从 mem-probe --json 提取）`；原样直喂 9 键也拒（实测 exit 2：`--mem-snapshot 含未列键: page_size（exact 契约，未知键拒）`） | **lead 动作**：从 `mem-probe --json` 的 9 键输出中**提取** `used_slots`/`platform_cap`/`concurrency`/`available_bytes` 构造四键快照（提取步骤见第③段检查单第 5 步） |
| 9 | set-state dispatched 未经 render-packet 出包（sc-p0c 前的旧用法，直接派发） | exit 2（实测）：`缺失前置：组 <gid> 未经 render-packet 出包（无 packet_rendered 事件），拒绝派发` | **lead 动作**：先 `render-packet` 出包（成功即落 `packet_rendered` 事件凭证），再 set-state dispatched（凭证闸消费最近一条该组 packet_rendered 事件） |
| 10 | 把 prewalk 四键塞进 exec 交卷、或用 exec 三键冒充 prewalk | exit 2：`DELIVERY_SCHEMA`（classifyDelivery 四类 hits!==1） | **lead 动作**：prewalk 只交 `first_edit/read_paths/landmines/open_unknowns` 恰好四键；exec/review/verify 旧三类形状不能冒充 prewalk |

另注意第①/②条的同源纪律：`--unresolved` 手工填数通道同样已关闭（unresolved 唯一写入通道 = record-delivery 审查交卷），set-state 收到即 exit 2。

## ⑯ verify 结果复用纪律（防重复纪律）

- **复用键 = 展开后的 {cmd,args} + tree_binding**：tree_binding = worktree realpath + HEAD SHA + 工作树 clean-state + 依赖输入 ref SHA（如 `manifest_core_hash`）；四者任一变化即不复用。复用作用域**限单 wave**——跨 wave 不复用。
- **五类 never-reuse**（出现任一即必须独立复跑，不得复用旧结果）：
  1. **mutation 类 SC**（反向变异必须实测复跑，predicted vs actual 红集逐条比对）；
  2. **有副作用的命令**（写文件/改状态/网络调用）；
  3. **占位符展开后指向不同对象**（同一模板命令在不同组展开出不同目标）；
  4. **SC 点名独立复跑**（SC 验收口径要求每轮各自跑）；
  5. **环境/外部配置/volatile host input**——如 mem-probe 读 sysctl/vm_stat 依赖宿主运行态而非源码树，routing.json 在仓外依赖宿主文件系统——同 HEAD/args/clean 可因宿主内存变化或配置变更得不同结果，**必须显式列禁**。
- **复用共享的是原始 outcome**：同一展开后命令的同一 outcome 可被多 SC 引用，但各 SC 仍按自己的 expect 分别判定（不因共享而合并验收口径）。
- **测试分层**：worker 轮内只跑动过文件的相关测试；全量 run-tests 只在集成点（V 阶段）与 T 阶段各跑一次。
- **e2e 时机**：全链只在 phase=e2e 跑一次；R 修复轮只跑受影响文件；ready-check 已有 candidate_sha 绑定机器闸兜底（见第⑪段）。

## ⑰ 看门狗（每小时自检，防 lead 停摆）

- **挂载**：init 台账后（第②段输入门通过、台账已建）用 cindy_scheduler 建 hourly schedule，**必须**带 `bindToCurrentSession: true` 与 `persistentSession: true` 两个参数——心跳模式：每次触发把提示注入 lead 当前会话、不新建会话；persistentSession 保证 lead 会话归档/删除时宿主自动新建会话接手，否则宿主会直接 pause 整条 schedule（看门狗在最该起作用时失效）。model/effort 留空（沿用 lead 会话当前模型，显式设置会覆盖并改掉 lead 自己的模型）。READY（第⑪段出口门通过）时 lead **删除本 schedule**（终态，不再需要挂回）；run 终止或进入任一「允许停」路径（第⑤段三类停，见下「暂停保护」）时 lead **只暂停本 schedule（`schedule_pause(<schedule_id>)`），明确不 delete**——delete 不可逆且 `schedule_create` 无 id 参数（新建拿不到同一 id），删了就再也挂不回；恢复时用持久化的 schedule id 经 `schedule_resume(<schedule_id>)` 恢复，零新增参数（resume 只需 id，不需要重建）。
- **scheduler 不可用**（setup 时即失败）：开场简报如实标注「看门狗未挂」，不静默（失败时间点 (a)）。
- **提示词模板**（内嵌进 schedule 的 prompt 参数；**lead 建 schedule 时必须把实际 ledger 路径、run_id 与 schedule_id 三者都展开写进 prompt，不得保留 `<ledger>`/`<run_id>`/`<schedule_id>` 占位符**——prompt 是静态文本，persistentSession 新建的接手会话没有本 skill 上下文，payload 是接手方拿到 run_id 与 schedule_id 的唯一通道。**时序（四步挂载，pause 成功后关死竞态窗口）**：`schedule_create` 返回 id 时 prompt 已随创建提交、创建时拿不到 id——正确流程：① `schedule_create(...)` 创建（拿 id）；② 立即 `schedule_pause(<schedule_id>)`——**pause 成功后**窗口才关死：create 成功返回到 pause 成功返回之间仍有**毫秒级残余窗口**，撞上 hourly tick 仍可能触发一次占位符 prompt（首轮 prompt 仍是 `<schedule_id>` 占位符）；③ `schedule_update(<schedule_id>, prompt=<回填了真实 id 的 payload>)`；④ `schedule_resume(<schedule_id>)` 放行。四步完成才算挂好。**残余窗口的安全性依赖 fresh-init invariants**：新 run 刚 init 时 phase=executing、minutes=null、in_flight 为空、watchdog 观察文件不存在——占位符 prompt 即便跑起来也只会写观察文件（payload 第 3b 步 A1 协议），不会走到第 5 步 resume、不会 archive/重派；**若在非 fresh-init 的既有 run 上重新 create**（例如遗留 watchdog 观察文件已计数达 3、且 in_flight 有超时组），占位符 prompt 会带真实 run_id 进入 `批准执行 --resume <run_id>` 并可能 archive+重派——**挂载只允许在 init 后的 fresh run 上做**。**fail-closed**：四步中任一步失败即停止，不得继续后续步骤——尤其 **pause 失败绝不能继续 update→resume**（那等于回到无保护的两步流程，占位符窗口重新暴露整个 hourly 周期）；失败时报告 owner；若 create 已成功但后续步失败，schedule 处于「已创建但 prompt 未回填」状态——先 `schedule_pause(<schedule_id>)` pause 住防跑占位符，再报告 owner；若连 pause 都失败，必须立即报告 owner 说明存在活跃的占位符 schedule）。payload 边界由下方起止标记包裹，**复制时去掉起止标记与 `>` 前缀**：
  <!-- approve-exec:watchdog-payload:start -->
  > 每轮动作（按序执行，命中即停）：先跑 `run-ledger staleness <ledger>`（只读）取 phase / version / minutes_since_last_event / in_flight_groups，然后：
  > 1. **暂停保护**：若本 run 处于「允许停」路径（autonomous-execution 硬停 / A 类配置 fail-closed / 预算暂停等 owner 确认）——此时 lead 已暂停本 schedule，本 prompt 不应触发；若仍触发（lead 未暂停），仅报告 owner，不动作、不得 resume/重派（不得越过用户已授权的暂停）。
  > 2. **终态/心跳**：phase=ready → 删除本 schedule（用 `<schedule_id>`）后退出；否则 minutes_since_last_event 非 null 且 <60 → 无事，退出。
  > 3. **疑似停摆**（minutes_since_last_event 为 null 或 >=60）：
  >    a. in_flight_groups 非空（活已派出去、该落事件却没落）→ 按第 4 步互斥动作表逐组核实；
  >    b. in_flight_groups 为空 → A1 观察协议：把本轮 staleness 的 version 与触发时刻写入 `<ledger>.watchdog.json`（只保留最近 3 条观察）；该文件缺失或损坏 → 报告 owner，从本轮重新计数（宁可多等，不可误动）；**连续 3 轮**（看门狗每小时触发一次，3 轮 = 3 小时）观察到同一 version → 判定真停摆，执行第 5 步；version 变化 → 计数清零重计。
  > 4. **交叉核实互斥动作表**（A2 按组判定；先交叉核实再动手——查 in_flight_groups 状态与 list_workers 存活情况，确认真的停摆才动作，不得直接清槽重派）：对 in_flight_groups 每个组，把台账该组 worker_label 与 list_workers 对照（staleness 输出不含 worker_label，组→worker 映射从台账读）：
  >    | in_flight 组对应 worker 在 list_workers 里的状态 | 动作 |
  >    |---|---|
  >    | 对应 worker 存活（running/active） | **不动**（正常在跑，只记录观察） |
  >    | state=dispatched 且 dispatched_at+40min<=now 且该 worker 已 terminal | **真超时**：resume 后按第⑤段「worker 超时重派」纪律对该组超时/失败收束并落账（归档该 worker、重建重派，台账 timeout_redispatch） |
  >    | state=delivered/review_pass 且该 worker 不存在/已 terminal | **正常态**（交付后已按纪律 archive），不重派，走第 5 步从台账恢复后续 |
  >    | 映射缺失 / 多重 / 混合（含 dispatched 未满 40min） | **仅报告 owner，不清槽不重派** |
  >    命中「真超时」或「正常态」行 → 执行第 5 步；全部「不动」→ 退出。
  > 5. **恢复入口**：一律先执行 `批准执行 --resume <run_id>`（幂等读台账重建，多跑一次代价远小于分支判断出错；不做「本会话正在跑本 run」自判断，不设任何直接续跑分支）；恢复后按第⑤⑨段纪律继续；若本 schedule 处于 paused（暂停保护路径 lead 已 `schedule_pause`）→ 用已展开的 `<schedule_id>` 经 `schedule_resume(<schedule_id>)` 恢复（schedule 从未被删除，pause/resume 只需 id，直接恢复即可）。
  <!-- approve-exec:watchdog-payload:end -->
- **payload 边界（本轮重构）**：起止标记之间 = **prompt payload**——接手会话只读 payload 即可完整执行（A1 观察协议、A2 互斥动作表、resume 入口、暂停保护、按组超时判定全部在 payload 内）；本段其余内容（挂载/参数/失败时间点/残余/设计说明）是说明与残余声明，不进入 prompt。
- **null 判据与观察文件语义（P2-4）**：`<ledger>.watchdog.json` 是**看门狗控制状态**（不是 run 状态：不参与 `--resume` 恢复、不参与 ready-check，丢失只会导致计数清零重计 3 轮——不违反第⑥段「台账即唯一状态源」纪律）；但它确实影响看门狗行为（liveness），不能以「不影响正确性」一句带过。**「最多等 3 轮必动作、不存在无限等待路径」是有条件声明**：前提是**单写者**——该文件只由看门狗触发方单方读写；缺失/损坏/部分写/多写者并发读写会破坏计数语义，按 payload 第 3b 步处理：报告 owner 并从当前轮重新计数（fail-safe 方向：宁可多等，不可误动）。
- **交叉核实映射源（P1-2）**：staleness 输出只有 group_id/state/dispatched_at，**不含 worker_label**——组→worker 映射从台账直接读（set-state dispatched 时经 `--worker-label` 落账于组字段；读法：读 `<ledger>.json` 的 waves[].groups[] 取 worker_label）。「能确证 worker 已 terminal」= 该组有 worker_label 且 list_workers 查无该 worker（或已归档）。**按组判定边界（P1-2）**：只有 state=dispatched 且已满 40min（= `workerTimeoutMinutes`，第⑤段）且能确证 worker 已 terminal 的组才允许走超时收束；delivered/review_pass 且无存活 worker 是**正常态**（交付后已按纪律 archive），走 resume 从台账恢复后续，**不重派**；映射缺失/多重/混合仅报告 owner，不动。
- **暂停保护（P1-3，选 (a)）**：进入任一「允许停」路径（第⑤段三类停）时 lead **只暂停本 run 的 schedule（`schedule_pause(<schedule_id>)`），不删除**——暂停期 schedule 处于 paused、不触发，看门狗不注入，不可能误判停摆并 resume/重派；恢复时用持久化的 schedule id 经 `schedule_resume(<schedule_id>)` 恢复（零新增参数）。**如实声明**：该保护无机器闸——依赖 lead 在暂停时同轮 pause schedule；若未暂停，payload 第 1 步兜底「仅报告 owner 不动作」，但兜底同样依赖 lead 执行。选 (a) 理由：不需要新状态（暂停 = schedule 的 paused 态，恢复 = `schedule_resume`，复用的是宿主导航原语而非自建状态）、复用既有「持久化 schedule id」纪律；暂停期不触发注入，不打扰正在等 owner 确认的会话。
- **B1 分支删除（本轮）**：原「正向确认本会话正在跑本 run → 直接续跑」分支已删除，统一一律先 `批准执行 --resume <run_id>`（幂等读台账，多跑一次代价远小于分支判断出错）；原 F1 残余（自判断非机器闸）随之消除。
- **schedule_create 六项必填参数**（zod 契约，六项均无 .optional()，缺任一即 INVALID_ARGS）：name（唯一标识）、cronExpr（5 字段 cron）、timezone（IANA）、recurring（true 循环）、agentKind（claude-code/codex/pi）、notify{desktop,feishu}（通知开关，二者必填）。handler 是 s.create(o) **直接创建**——无 upsert / 无幂等键 / 无去重键（同名重复创建不拒）：**lead 需自行持久化并复用 schedule id** 防重复创建，否则重复触发即重复唤醒。`bindToCurrentSession` 与 `persistentSession` 虽是可选字段（不属上述六项），但二者决定了「心跳注入 lead 当前会话」还是「每轮新建会话」两种模式——看门狗场景两者**必传**（见上「挂载」）：缺 `bindToCurrentSession` 即退回每轮新建会话模式；只设 `bindToCurrentSession` 而不设 `persistentSession`，lead 会话死亡时宿主会直接 pause 整条 schedule 且不自动恢复。
- **五个失败时间点**：
  (a) **setup 时 scheduler 不可用** → 开场简报标注「看门狗未挂」；
  (b) **READY 后自删**（payload 第 2 步内嵌删除分支）；
  (c) **运行中 schedule 被删/停用** → 看门狗静默失效、staleness 不触发、lead 无外部唤醒 → 需**回检**：lead 断开会话后重连时，手动检查 schedule 存活性（读 cindy_scheduler schedule_list，确认本 run 的 schedule 仍在且未停用）；**发现问题后的动作：报告 owner + 用持久化的 schedule id 经 `schedule_resume(<schedule_id>)` 恢复**（复用「lead 需自行持久化并复用 schedule id」纪律，不引入第二套 id 管理；若 schedule 确已被外部删除致 resume 失败，仅报告 owner 等指令——`schedule_create` 无 id 参数，无法重建同一 id）；
  (d) **scheduler 服务后续停机** → 同 (c) 回检机制，两者语义相同，统一按 (c) 的回检步骤处理（含发现后的报告 owner + `schedule_resume(<schedule_id>)` 恢复）；
  (e) **绑定会话死亡导致 schedule 被 pause（心跳模式特有）** → 只设 `bindToCurrentSession` 未设 `persistentSession` 时，lead 会话死亡宿主会直接 pause 整条 schedule 且不自动恢复；创建时配置漂移（漏传两参数，退回每轮新建会话或无接手能力）同属此面 → 同 (c) 回检，发现问题后报告 owner + 用持久化的 schedule id 经 `schedule_resume(<schedule_id>)` 恢复。
- **已知残余（review_pass 不落事件）**：`run-ledger staleness` 的 `minutes_since_last_event` 以台账最后事件 at 计算——`review_pass` 态组**不落事件**（`in_flight_groups` 已按 state 过滤含 `review_pass`，**不需要补落事件**；「补落事件」是伪修复，修的是症状不是判据）。组已 `review_pass` 而 events 停在更早时点会导致 minutes 虚高、看门狗**误判 run 停摆**，属已知残余。**后果升级（心跳模式后，2026-08-11）**：误判的代价不再是「白开一个没用的新会话」——心跳模式下误判会向**正在干活的 lead 会话**注入「清槽重派」指令，可能提前 archive worker、重复派工。缓解 = payload 第 4 步已要求疑似停摆先交叉核实（查 in_flight_groups / list_workers）再动手，但核实判据非机器闸、依赖 lead 执行，误判残余仍然存在。
- **已知残余（F5：minutes 读数无有效测试保护）**：`minutes_since_last_event` 的两个变异（取 `events[0]`、固定返回 0）测试全绿——看门狗唯一阈值 `>=60` 依赖该值却无有效测试保护（缺「两事件精确 `--now` 断言」区分 last-event 语义）。列为已知残余，下轮补「两事件精确 --now 断言」。
- **已知残余（sc-p1b-⑦ 断言作用域边界）**：部分段级断言仍用 `sectionBetween(MARKERS[16], undefined)` 取到文件末尾——当前正确（⑰ 是最后一段），但将来新增 ⑱ 段后会把 ⑱ 文本也纳入这些段级断言的段作用域、可能稀释断言（如 ⑱ 内出现同名字面量或 backtick token 命中）。届时补 ⑱ marker 收窄作用域即可（⑱ 尚不存在，不为不存在的段提前加锚）；payload 断言已按起止标记抽取，不受影响。
- **已知残余（F4 回检执行者未定义 / F5 第⑤⑨段无 staleness 操作序列——既有设计债，2026-08-11 记录，留待下轮）**：第⑤⑨段「清槽重派」引用与 (c)(d) 回检动作系改动前既有写法：回检由谁在何时执行未定义（依赖 lead 断开会话后重连时手动检查，无机器闸、无 schedule 探活）；第⑤⑨段未提供基于 staleness 读数的操作序列。本轮不重写第⑤⑨段，留待下轮处理。
- **新增机制确认门答辩**（删掉看门狗则「lead 防自停」目标不成立）：lead 停摆时无任何外部唤醒源——autonomous-execution 不停机条款只约束 lead 主动行为、约束不了会话中断/宿主重启这类被动停摆（这是用户显式点名的四诉求之一）。按确认门「不成立」分支**保留**本机制；失败面与成本如实声明：schedule 默认把提示注入 lead 的当前会话（心跳模式，不新建会话）；仅当该会话已归档/删除时，`persistentSession` 才让宿主新建一个会话接手，此时走 `--resume <run_id>` 读台账重建（这正是 staleness 读数 + 「台账即唯一状态源」的消费场景，见第⑥段）；成本 = 每小时一次 staleness 读数（对台账的只读查询）+ 疑似停摆时的交叉核实（in_flight_groups / list_workers）与可能的恢复动作（`--resume` 接手）；**误判最坏代价** = 向正在干活的 lead 会话注入「清槽重派」指令，可能提前 archive worker、重复派工——已由 payload 第 4 步「先交叉核实再动手」判据缓解，但缓解依赖 lead 执行（非机器闸）；孤儿风险 = READY 后忘删则下次触发发现 phase=ready **自删**（payload 第 2 步内嵌自删分支，双保险）。
