---
name: approve-exec
description: 批准执行——task-priority final manifest 之后由当前 lead 自己跑 E/R/V/P（E 走 goal 场景 C；R 先对本组 allowed_paths 做 simplify，再跑本会话 /code-review high --fix）；worker 只派 T e2e。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — lead 编排守则

**lead 按本文编排**：把 task-priority 产出的 `task-manifest.json` 自动推进到「可直接『提交 PR』」。
五阶段状态机 E(执行)→R(审查修复)→V(波集成+SC 验收)→T(e2e)→P(打包)→READY。默认 **E / R / V / P 由当前 lead 自己跑**（E 走 goal 场景 C + `--until-sc`；R 先对本组 `allowed_paths` 做 simplify，再跑本会话 `/code-review high --fix`，不派 worker、不走 `/rc`），**worker 只派 T e2e**。
生态链：task-priority（出 manifest）→ **本 skill（lead 自跑 E/R/V/P + 只把 T 派 worker）** → goal（lead 在本会话按场景 C 消费出包）→ submit-pr（三审收口）。

本文是 lead 侧编排的**唯一守则**：换会话、换模型后按本文执行，编排行为不漂移（机器保障：`scripts/run-tests.mjs` 冻结枚举 + `tests/skill-doc.test.mjs` 结构断言，见第⑭段）。共十六段。

## ① 身份与触发

- frontmatter：`name: approve-exec`，触发词「批准执行」。
- 用法（触发词参数由 **lead** 输入）：`批准执行`（默认用当前最新 final manifest 开跑）/ `批准执行 --resume <run_id>`（从台账恢复，见第⑥段）/ `批准执行 --no-budget-pause`（关闭预算暂停类停，见第⑤段）。
- 本 skill 是 **lead 编排 + 自跑层**：E / R / V / P 由当前 lead 在本会话执行；只把 T 派 worker（席位见第④段 D1）。

## ② 输入门：只消费 task-priority final manifest

- 唯一输入：task-priority **final 阶段释放**的 manifest——顶层含 `waves` / `dispatch` / `receipts` 三要素，packets 每包含 `scs_inline` / `allowed_paths` / `verify_cmds` / `forbidden` / `submit_format` 五要素（与 `run-ledger` render-packet 出包前五项校验逐字对齐）。
- **fail-closed**：manifest 缺 `waves`/`dispatch`/`receipts` 任一、或文件不存在、或 packet 缺五要素任一 → 视为 draft/缺 manifest，**不开跑**，停下指路 task-priority（先回上游产出 final manifest）。不得拿「差不多能跑」的中间产物开跑。**机器闸如实标注（全部有机器校验，无依赖 lead 手工检查的项）**：文件不存在/非对象与 `receipts` 键在场（readManifest，`scripts/run-ledger.mjs`；在场契约收口于唯一入口，init/validate/render-packet/record-delivery/set-state→ready 全部消费命令同判据，可空数组）、`receipts` 形状（readManifest 内 assertReceiptsSchema，未知键/类型错拒）、`waves` 非空数组与组 `sc_ids` 非空（init，initLedger）、`dispatch.packets` 存在且组有对应 packet、packet 五要素齐全（render-packet，PACKET_INCOMPLETE）。

## ③ 五阶段状态机与每边三动作

```
E(执行) → R(审查修复) → V(波集成+SC验收) → T(e2e) → P(打包) → READY
```

- 阶段图真相源是 `graph.json`（席位表：E/R/V/T/P 五席，各自 route 档与 `dispatch`，E 钉 agent_pin，R 钉 agent_pin + model/effort，先例 = submit-pr Phase 2 席位表）；本段只描述编排行为，不承载席位数据。默认 `dispatch=lead-self` 的席（E/R/V/P）出包后由 lead 本会话执行并 `record-delivery`，不走 create_workers；`dispatch=worker` 的席（仅 T）才派工。
- **lead 每边固定五步硬定序检查单**（派 T worker 的边一律如此，不许跳过；**顺序不可交换**——尤其 archive 先于 probe，使腾出的槽位天然计入下一环节。E/R/V/P 自跑边只走第 1 步入账，不派工）：
  1. **收结构化交卷**：只认 `run-ledger` record-delivery 入账的 exact schema 交卷（exec / review / verify / prewalk 四类，多余键或缺失键都拒）；lead 不做手工转录。（机器闸：`scripts/run-ledger.mjs` record-delivery）
  - **PreWalk（第 4 类交卷）**：波 0 = 第一波第一组。该组 dispatched 后先交恰好一条 prewalk（`first_edit`/`read_paths`/`landmines`/`open_unknowns`），不改组状态，再 archive；随后仍走 exec。后续执行组 `render-packet` 注入全台账**最新一条** prewalk 现场（不限本组），只进包文、不改 hashed packet。入账后若后续组发现 first_edit 相对当前树已漂移（rebase/squash 后 sha 不再祖先、或 path 内容已变），**整波**退回第一组重做 PreWalk——first_edit 失效不得假装现场仍活。
  2. **archive 全部 done/idle/error worker**——**汇报即清理（owner 硬指令(二)，2026-08-10）**：触发时机 = worker 交卷汇报一到即在同一轮动作内 archive，**不得攒批、不得延后到下一环节、不得用 idle 顶替**。明示：**不是 idle**——idle 只释放进程、**不释放槽位**；只有 archive 才释放并发槽位。（无机器闸：archive/idle 语义是 Orca 平台行为，按时执行依赖 lead）
  3. **list_workers 取实数**：调 `list_workers` 读当前 worker 清单，**禁止心算/凭记忆**填 used_slots——记录实数（第 2 步已 archive 的槽位此刻已释放）。（无机器闸：list_workers 读数是平台查询，取实数依赖 lead 执行）
  4. **mem-probe 现算并发**：`mem-probe --json --used-slots <第 3 步实数> --pending <待派组数>` 现算可用并发（并发公式见第④段 D2；`--pending` 同为必填，缺任一即 exit 2）。（机器闸：`scripts/mem-probe.mjs` 输出即槽位判据）
  5. **create_workers 整批派发 + 落账**：同批 ≥2 worker 用 `create_workers` 批量派发（禁连续单发，见第⑨段），随后逐组 `set-state --group <gid> --to dispatched --now <ts> --mem-snapshot '<json>'` 落账（`--now` 是写操作通用必填时间戳，缺省即 exit 2 `NOW_REQUIRED`）——快照四键 `used_slots`/`platform_cap`/`concurrency`/`available_bytes` 由 lead 从 `mem-probe --json` 的 9 键输出中提取构造（原样直喂 9 键会被 exact 校验拒，提取步骤即本步，见第⑮段迁移⑦⑧⑨）。（机器闸：`scripts/run-ledger.mjs` set-state 快照闸 + 凭证闸）

## ④ 设计决策 D0–D4

- **D0（owner 拍板）**：执行环节（写代码）**必须以 goal skill 场景 C 触发**——出包首行「用 goal skill 执行。」+ 单独一行 `--until-sc`。默认由**当前 lead**在本会话加载 goal 自跑（lead 已是 claude-code，不另派 E 席 worker）。若某次显式改回派 E 席 worker：该 worker 仍钉死 claude-code（goal 声明 codex 加载不到）；routing fallback 链中**非 claude-code 候选跳过**，候选耗尽 = A 类 fail-closed，**禁止「内联等价契约给 codex」变通**（详见第⑦段）。
- **D1（lead 自跑 E/R/V/P，owner 硬指令(三)，2026-08-22 改钉）**：汇总完任务优先级之后，当前 lead **亲手执行** E（goal 场景 C + `--until-sc`）、R（先 simplify 再本会话 `/code-review high --fix`，不派 worker）、V（零改代码的验收 + 入账）与 P（写 `.pr-intent.md` + 出口门）；**不派** E / R / V / P worker。worker **只用在** T e2e。台账、出包、交卷入账、清槽仍由 lead 编排。V 不得另派作者 worker 代跑——验收就在 lead 本会话做，交卷仍走 `record-delivery` verify 类 exact schema。R 不得派 Orca worker 跑斜杠命令——2026-08-16 实测 slash 在 worker 会话不可用。旧口径「lead 一律派 worker、一切不自己干」作废。
- **D2（并发公式）**：只对**实际要派的 worker 席**（T）生效。并发 = min(内存允许, Orca 平台硬上限 `orcaPlatformCap`=8, 待派组数)，**每次派 T 前现跑 mem-probe**。「不设上限」的物理含义 = 始终拉满 8；内存探测（`memReserveRatio` + `perWorkerBytes` 切分）是护栏（防多 loop 挤兑），非常态瓶颈。E/R/V/P 不占 Orca worker 槽。
- **D3（R 席命令）**：R 是两步、同一席，不新开席、不走 `/rc`（`/rc` 的审查段只报告不自动修，和本席 `--fix` + 5 键 JSON 交卷对不上）。**当前 lead 在本会话、本组 worktree、仅 `allowed_paths` 内**：① **simplify 前置**（内联 `/rc.md` Phase 1 四维：复用 / 简化 / 效率 / 抽象层级；改代码、不找 bug、不改变外部行为；本机无独立 `/simplify` 命令，Cindy 也调不到内置版，故内联执行，不调 slash）。有清理 diff 则先落到该组 tip，再进入②。② **审查**：本地 slash `/code-review high --fix`（来源 = `~/.claude/commands/code-review.md`，**不是** Claude 内置命令，**禁止**派 Orca worker 跑这条斜杠）。审查对象必须是 simplify 之后的 tip。审查交卷仍按 review 类 exact schema 由 lead 入账。席位表仍钉 `agent_pin=claude-code` 与 model/effort `x-ai/grok-4.6` / `high`（owner 2026-08-21 改钉；本会话已是 claude-code 时用本会话模型，不必另开 worker）。**不改 routing.json 四档**（review 档语义留给 submit-pr 三审）；席位表落本 skill `graph.json`（`pre_command=simplify-inline` + `command=/code-review high --fix`）。
- **D4（组级审查）**：每组 execute 交付后**立即在该组 worktree 内先 simplify、再审+修**（各组可并行）；跨组问题由波级 SC 验收 + e2e 兜底。审查修复 ≤ `reviewMaxRounds` 轮不收敛 = 硬阻碍上报（见第⑤段）。simplify 不算审查轮次。

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
- **诊断读数**：`run-ledger staleness <ledger>` 只读台账新鲜度（phase / version / minutes_since_last_event / in_flight_groups），供 lead 自己查，不挂调度、不自唤醒。

## ⑦ 模型现读纪律

- **硬指令（owner 2026-08-10 拍板）**：凡要派 worker 的席（默认只有 T；若某次显式派 E/R/V/P 也算）派工前**必须现读模型说明书**配置 model/effort——真相源 = `routing.json`（`routingPath` 指向，`orca-model-routing` 规则指定为真相源）+ `model-route show` 可核对；**禁凭记忆填值，禁跳过读取直接派**。E/V/T/P 四席现读 routing.json 取档名（默认 E/R/V/P 不派 worker，lead 用本会话模型自跑，不必为这四席填 create_worker 的 model）。**R 席例外**：model/effort 由 `graph.json` 席位表显式钉死（见第④段 D3，owner 2026-08-10 拍板），**不从 routing 取值**；R 默认也不派 worker。本 skill 的 `graph.json` 只引路由档名（E 钉 agent_pin），其余席位永不内嵌具体模型 ID——模型在派工时现读 routing.json。
- E 席（goal 场景 C）要求 agent 家族 = claude-code：默认 lead 本会话已是 claude-code，直接加载 goal。若某次改回派 E 席 worker：**routing fallback 链中非 claude-code 候选一律跳过**，只沿链找 claude-code 候选。（本条无机器闸，依赖 lead 遵守；routing.json 内容合法性的机器校验在 `scripts/selfcheck.mjs` 与全局 model-route 脚本。R 席不走 routing：agent_pin=claude-code、model/effort 由席位表钉死，见第④段 D3。）
- 候选耗尽（仅当改回派 E 席且无 claude-code 可派） = **A 类 fail-closed**：停，向用户报告（路由档、已试候选、错误原文），等指令；**禁止「内联等价契约给 codex」变通**（codex 加载不到 goal skill，等价契约不成立）。（R 席无此问题——不走 routing，model/effort 钉死，无候选链可耗尽。）
- 派工说明必须标注实际使用模型（如 `(model/effort)`），多 worker 贴紧凑台账但不阻塞流程。

## ⑧ pr-submit-gate 传导

- `needs_three_review` 判定（功能改动需 submit-pr 三审 / 非功能性小 PR 免三审，按 `pr-submit-gate` 规则的「按实质不按标题」判据）**从 manifest packets 透传进派工包**：render-packet 出包时把该组的门禁结论写进包内说明区，worker 执行时按边界行事（该 push 的 push、该停的停）。
- 对外 mark ready、合并等动作仍**逐次授权**：历史授权/其他会话授权不可引用；派工包内点名的授权只对当次生效。
- 本 skill 的交付物 = 「候选分支 + 台账」，**不是** PR：开正式 PR 由用户在 submit-pr 链路完成后进行（或按当次授权由合并侧流程处理）。

## ⑨ 批量派工与槽位纪律

- **只派 T**。同批 ≥2 worker 一律 `create_workers` 批量工具（禁连续 `create_worker` 单发）；只有本批确实只有 1 个 worker 时才允许 `create_worker`。E / R / V / P 默认不派，不适用本条。（本条无机器闸，依赖 lead 遵守：平台侧不拦单发，`tests/skill-doc.test.mjs` 只保证文档表述存在）
- **每轮必清槽位**：交付/done/idle/error 的 worker 立即 archive（归档即释放槽位）；idle 不释放槽位，禁止用 idle 代替 archive 占着槽位。（无机器闸，依赖 lead 遵守；archive 释放槽位是 Orca 平台语义）
- 归档后槽位数立即反映到下一批的并发公式（第④段 D2）；台账 dispatch 记录与归档动作一一对应。

## ⑩ 术语边界：V 阶段验收组 ≠ orca-fanout verify 组

- 本 skill 的 **V 阶段验收组**：由**当前 lead 自跑**，**零代码修改**，只跑 verify 命令出 verdict + 整合树复查（integrated_tip 相对上一集成点的 squash diff 交互面复查），出包用 `run-ledger` 验收模板（render-verify，不带 goal 触发行），再由 lead 按 verify 类 schema 入账。不派验收 worker。
- **orca-fanout 的 verify 组**：语义不同——允许改测试路径。
- **派工包模板二者分开，禁互套**：验收组的包不得带「可改测试」授权，orca-fanout verify 组的包不得套用「零修改」措辞；lead 打包时按组 kind 选模板，出错包即 fail-closed。

## ⑪ P 阶段职责：.pr-intent.md workfile

- P 阶段（打包）由**当前 lead 自跑**：先从 manifest 的 goal/priorities 生成 **`.pr-intent.md`** workfile（意图声明，落在候选分支工作区），**之后**才运行 intent-check（presubmit 三闸：size / format / intent）。不派打包 worker。
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

四条「接受残余并声明」，如实写在台账与交付报告里，不包装成已解决：

1. **批次收缩序列**：内存收缩导致的批次序列（如 3,3,1）视为**满载合规**——满载判据以**派发时刻 mem-probe 输出**为准，不要求每波都打到 8。
2. **目标仓 build/typecheck SC 缺失不代补**：manifest 若缺目标仓 build/typecheck SC，本 skill **不代补**（上游 task-priority 起草责任），submit-pr P1 typecheck-merged 兜底。
3. **版本 bump 无核对**：各仓版本策略不一，本 skill 不做版本 bump 核对，submit-pr 三审兜底。
4. **席位 dispatch 无运行时消费者**：`graph.json` 的 `dispatch` / `pre_command` 只被测试断言锁值，脚本（run-ledger / ready-check / selfcheck）不读它们做派工决策。哪席派工仍靠 lead 按本文执行（T1：防漂移、不防不遵守）。升级成机器闸属下一轮，本轮不代做。

## ⑭ 保证等级声明

- 本 skill 的保证等级是 **T1：防疏忽/漂移**——通过结构断言测试（机器闸：`scripts/run-tests.mjs` 冻结枚举 + `tests/skill-doc.test.mjs` 章节/字面量断言）、doc↔实现字面量同步（如「用 goal skill 执行。」）、config 键名引用比对，保证编排行为按守则执行、不因会话/模型更换而漂移。
- **不防恶意伪造交卷**：本 skill 的机制不承诺对抗伪造——兜底 = lead 本会话跑独立 verify 席复验（V 不派作者 worker）+ submit-pr 三审收口。
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
