---
name: approve-exec
description: 批准执行——lead 侧多 worker loop 编排：把 task-priority final 阶段释放的 task-manifest.json 自动执行到「可直接『提交 PR』」的候选分支。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — lead 编排守则

把 task-priority 产出的 `task-manifest.json` 自动执行到「可直接『提交 PR』」：
五阶段状态机 E(执行)→R(审查修复)→V(波集成+SC 验收)→T(e2e)→P(打包)→READY，lead 只编排决策、不亲手执行。
生态链：task-priority（出 manifest）→ **本 skill（lead 编排 loop）** → goal（worker 端场景 C 消费派工包）→ submit-pr（三审收口）。

本文是 lead 侧编排的**唯一守则**：换会话、换模型后按本文执行，编排行为不漂移。共十四段。

## ① 身份与触发

- frontmatter：`name: approve-exec`，触发词「批准执行」。
- 用法：`批准执行`（默认用当前最新 final manifest 开跑）/ `批准执行 --resume <run_id>`（从台账恢复，见第⑥段）/ `批准执行 --no-budget-pause`（关闭预算暂停类停，见第⑤段）。
- 本 skill 是 **lead 编排层**：不写业务代码，全部执行工作派给 worker（场景见第④段 D1）。

## ② 输入门：只消费 task-priority final manifest

- 唯一输入：task-priority **final 阶段释放**的 manifest——顶层含 `waves` / `dispatch` / `receipts` 三要素，packets 每包含 `scs_inline` / `allowed_paths` / `verify_cmds` / `forbidden` / `submit_format` 五要素（与 `run-ledger` render-packet 出包前五项校验逐字对齐）。
- **fail-closed**：manifest 缺 `waves`/`dispatch`/`receipts` 任一、或文件不存在、或 packet 缺五要素任一 → 视为 draft/缺 manifest，**不开跑**，停下指路 task-priority（先回上游产出 final manifest）。不得拿「差不多能跑」的中间产物开跑。

## ③ 五阶段状态机与每边三动作

```
E(执行) → R(审查修复) → V(波集成+SC验收) → T(e2e) → P(打包) → READY
```

- 阶段图真相源是 `graph.json`（席位表：E/R/V/T/P 五席，各自 route 档，E/R 另钉 agent_pin，先例 = submit-pr Phase 2 席位表）；本段只描述编排行为，不承载席位数据。
- **每边固定三动作**（任何阶段之间一律如此，不许跳过）：
  1. **收结构化交卷**：只认 `run-ledger` record-delivery 入账的 exact schema 交卷（exec / review / verify 三类，多余键或缺失键都拒）；lead 不做手工转录。
  2. **archive 该 worker**——明示：**不是 idle**。idle 只释放进程、**不释放槽位**；只有 archive 才释放并发槽位。
  3. **mem-probe + 槽位重算**：现跑 `mem-probe` 重算可用槽位，再派下一批（并发公式见第④段 D2）。

## ④ 设计决策 D0–D4

- **D0（owner 拍板）**：执行环节（写代码）的派工包**必须以 goal skill 场景 C 触发**——包内首行「用 goal skill 执行。」+ 单独一行 `--until-sc`。连锁约束：execute 席 agent 钉死 claude-code（goal 声明 codex 加载不到）；routing fallback 链中**非 claude-code 候选跳过**，候选耗尽 = A 类 fail-closed，**禁止「内联等价契约给 codex」变通**（详见第⑦段）。
- **D1（lead 只编排）**：SC 复验派**独立 verify worker**（≠ 作者 worker）；lead 只做台账对账/计数核对（确定性脚本），不亲手跑验证、不代写交卷。
- **D2（并发公式）**：并发 = min(内存允许, Orca 平台硬上限 `orcaPlatformCap`=8, 待派组数)，**每次派工前现跑 mem-probe**。「不设上限」的物理含义 = 始终拉满 8；内存探测（`memReserveRatio` + `perWorkerBytes` 切分）是护栏（防多 loop 挤兑），非常态瓶颈。
- **D3（R 席命令）**：R 席跑 claude-code 内置 `/code-review high --fix`（owner 确认为内置命令，带强度与 `--fix`），只能 claude-code agent；model 取 routing execute 档的 claude-code 值；**不改 routing.json 四档**（review 档语义留给 submit-pr 三审）；席位表落本 skill `graph.json`。
- **D4（组级审查）**：每组 execute 交付后**立即在该组 worktree 内审+修**（各组可并行）；跨组问题由波级 SC 验收 + e2e 兜底。审查修复 ≤ `reviewMaxRounds` 轮不收敛 = 硬阻碍上报（见第⑤段）。

## ⑤ 不停机条款（仅三类停）

仅以下三类情况允许停，此外全程自主执行、不弹确认：

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
- `批准执行 --resume <run_id>` 从台账恢复：重建五阶段位置、已派组状态、已集成 tip、未决组队列，继续跑；台账带版本乐观锁（CAS），并发写冲突 exit 2，不静默覆盖。
- 台账即唯一状态源：换会话、换模型后 `--resume` 即可无缝续跑，不需要人工回忆进度。

## ⑦ 模型现读纪律

- **派工前现读 routing.json**（`routingPath` 指向，`orca-model-routing` 规则指定为真相源），禁凭记忆填模型；本 skill 的 `graph.json` 只引路由档名（E/R 另钉 agent_pin），**永不内嵌具体模型 ID**。
- E/R 席（goal 场景 C + `/code-review`）要求 agent 家族 = claude-code：**routing fallback 链中非 claude-code 候选一律跳过**，只沿链找 claude-code 候选。
- 候选耗尽（E/R 席无 claude-code 可派） = **A 类 fail-closed**：停，向用户报告（路由档、已试候选、错误原文），等指令；**禁止「内联等价契约给 codex」变通**（codex 加载不到 goal skill，等价契约不成立）。
- 派工说明必须标注实际使用模型（如 `(model/effort)`），多 worker 贴紧凑台账但不阻塞流程。

## ⑧ pr-submit-gate 传导

- `needs_three_review` 判定（功能改动需 submit-pr 三审 / 非功能性小 PR 免三审，按 `pr-submit-gate` 规则的「按实质不按标题」判据）**从 manifest packets 透传进派工包**：render-packet 出包时把该组的门禁结论写进包内说明区，worker 执行时按边界行事（该 push 的 push、该停的停）。
- 对外 mark ready、合并等动作仍**逐次授权**：历史授权/其他会话授权不可引用；派工包内点名的授权只对当次生效。
- 本 skill 的交付物 = 「候选分支 + 台账」，**不是** PR：开正式 PR 由用户在 submit-pr 链路完成后进行（或按当次授权由合并侧流程处理）。

## ⑨ 批量派工与槽位纪律

- **整波派发一律 `create_workers` 批量工具**（同批 ≥2 worker 禁连续 `create_worker` 单发）；只有波内确实只有 1 个 worker 时才允许 `create_worker`。
- **每轮必清槽位**：交付/done/idle/error 的 worker 立即 archive（归档即释放槽位）；idle 不释放槽位，禁止用 idle 代替 archive 占着槽位。
- 归档后槽位数立即反映到下一批的并发公式（第④段 D2）；台账 dispatch 记录与归档动作一一对应。

## ⑩ 术语边界：V 阶段验收组 ≠ orca-fanout verify 组

- 本 skill 的 **V 阶段验收组**：**零代码修改**，只跑 verify 命令出 verdict + 整合树复查（integrated_tip 相对上一集成点的 squash diff 交互面复查），出包用 `run-ledger` 验收模板（render-verify，不带 goal 触发行）。
- **orca-fanout 的 verify 组**：语义不同——允许改测试路径。
- **派工包模板二者分开，禁互套**：验收组的包不得带「可改测试」授权，orca-fanout verify 组的包不得套用「零修改」措辞；lead 打包时按组 kind 选模板，出错包即 fail-closed。

## ⑪ P 阶段职责：.pr-intent.md workfile

- P 阶段（打包）worker：先从 manifest 的 goal/priorities 生成 **`.pr-intent.md`** workfile（意图声明，落在候选分支工作区），**之后**才运行 intent-check（presubmit 三闸：size / format / intent）。
- **`.pr-intent.md` 的创建责任在本 skill 的 P 阶段，不在 submit-pr**；submit-pr 只消费该文件做 intent 核对。
- 出口门由 `ready-check` 执行：全组 verified + 每 SC PASS 锚点 + 审查 unresolved==0 + e2e PASS + presubmit 三闸结果**绑定候选 HEAD SHA**，全齐才输出 READY_FOR_SUBMIT_PR。

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

- 本 skill 的保证等级是 **T1：防疏忽/漂移**——通过结构断言测试（`tests/` 顶层 `*.test.mjs`）、doc↔实现字面量同步（如「用 goal skill 执行。」）、config 键名引用比对，保证编排行为按守则执行、不因会话/模型更换而漂移。
- **不防恶意 worker 伪造交卷**：本 skill 的机制不承诺对抗伪造——兜底 = 独立 verify 席复验（非作者 worker 出 verdict）+ submit-pr 三审收口。
- 交付报告不得把保证等级写成夸大类措辞；残余与保证边界按第⑬段、本段如实声明。
