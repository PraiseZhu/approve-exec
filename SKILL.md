---
name: approve-exec
description: 批准执行——只吃 task-priority final manifest；lead 拆 PR、写开工包、派独立 PI owner session、裁决例外；E 由 owner session 走 goal 场景 C 并自主推到 PR Ready；T 由 owner 现读 routing.json 派 e2e worker；本地不再派 GPT/Claude 单审；lead 不改产品代码、不代执行。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — lead 编排守则

**lead 按本文编排**：把 task-priority final manifest 拆成每 PR 一个独立 owner session。本机 owner 完成实现、全部 priority/SC、本地 e2e 和普通 push；Mivo PR 先保持 Draft，只有当前提交 required CI 全绿且审查机进场证据齐备后才转为 Ready for review，再写 pr_ready。lead 验收后立即派 sub 清本地并归档该 owner。云端审查反馈、冲突与复审由 Mini 常驻 Cindy 按 PR 唯一 session 接管，本机不再注册盯梢。candidate 是检查点；不得自行 merge。本地不再派 GPT/Claude 单审。

**合并红线（最高优先级）**：任何 lead、owner、reviewer、tester、Mini session、watcher、worker 或本 skill 都不得合并、自动合并、启用 auto-merge、点击合并或调用 gh pr merge。只有用户本人对指定 PR 的明确、当次授权才允许合并；PR Ready、cloud_ready、required checks 通过、管理员权限或开工包中的提交/推送授权，均不构成合并授权。后续由用户手动合并插件承接该动作；插件上线前只能报告“可合并”，不得代替用户合并。

Lead 只做判断：拆 PR、写开工包、派独立 session、裁决例外、验收、派 native cleanup sub、归档该 PR 的 owner。功能代码、SC、e2e、开远端 PR 与必需 CI 确认由本机 owner 执行；云端反馈修复由 Mini Cindy 常驻程序执行。本 skill 不再 register Mini；每 PR 仍只允许一个 Mini 修复 session，title 为 `{项目名}-{任务名}丨修复丨YYYY-MM-DD`。

真实派窗与 owner 入账的命令、恢复边界见 references/owner-protocol.md（派发前必读，完整内容随 handoff 发送）。保证等级是 T1 skill 纪律与脚本校验，不是宿主强制隔离。

生态链：task-priority（出 manifest）→ **本 skill（拆 PR + 写完整 handoff + 派唯一 owner）** → owner 用 goal 场景 C 完成实现与 SC 验证，再由同一 owner 完成本地 e2e 和已授权的 PR Ready 收尾。三审仍不在本 skill。本地不再派 GPT/Claude 单审。

**阶段与授权交接**：SC PASS 是 goal 子阶段完成，不是 owner 整体任务完成。仅当所有 SC 都有 PASS 证据且没有 hard_stop、预算暂停或 blocked 时，才正常返回同一 owner 继续收尾；不得通过切换阶段绕过停止条件。开工包应注明已有授权的来源、目标仓、分支和动作；本次任务已明确授权的提交、推送、创建/更新目标 PR 直接执行，不重复请示。只有对应动作确实未获授权时才停下请求决定，PR Ready 终点本身不产生新增授权。goal 内 push／回帖仍遵守 goal 的精确声明及当前 PR 窄范围，不能为省去请示自行补造声明，也不借此授权创建 PR 或 merge。

本文是 lead 侧编排的**唯一守则**。机器保障：`scripts/run-tests.mjs` 冻结枚举 + `tests/skill-doc.test.mjs` 结构断言。

## ① 身份与触发

**业务 PR 与内部阶段分离**：原 final manifest 不改写。含核查/实现/验收阶段的计划必须提供显式 `pr-map-v1` 归属表，经 `scripts/lib/pr-plan.mjs` 转为业务 PR 执行视图；不得按组名或 priority_id 猜归属。`run-ledger.mjs init --pr-map <绝对路径>` 创建 `pr-ledger-v2` 台账，site-check 使用 `--ledger`，派工、开工包与验收均消费同一视图。每个 PR 一个 owner，baseline → fix → verify 依次执行，阶段之间不等待合并。原 manifest hash、归属表 hash 和执行视图 hash 分别绑定，任何变化都拒用旧凭据。旧台账不自动合并或迁移，已有 owner/claim/工作树保留现场。格式与恢复规则见 `references/owner-protocol.md`。

- frontmatter：`name: approve-exec`，触发词「批准执行」。
- 用法：`批准执行`（用当前最新 final manifest 真派）/ `批准执行 --dry-run`（只出拆分表 + 开工包 + 将要 create 的参数，不调 `send_to_session`）/ `批准执行 --resume <run_id>` / `批准执行 --no-budget-pause`（写入包文，关闭该子 session 的自报暂停）。
- 本 skill 是 **lead 编排层**：Lead 禁止改 `allowed_paths` 里的产品代码，禁止替子 session 修 bug，禁止替子 session 开 PR。E 席 `dispatch=session`；T 席 `dispatch=worker`（由**owner session** 派本地 e2e）；R 席 `dispatch=lead-self`（本地不派 reviewer；云端审查由 Mini 盯梢）；V/P 席 `dispatch=lead-self`（只读验收 / 写裁决台账；.pr-intent.md 由 owner 写）。owner 调本 skill 脚本校验并直接入账，不逐步跳回 lead。lead 的编排、验收裁决和登记不是产品执行。
- **开工闸（PI owner session）**：未交过账的 `gate_goal` / `gate_routing` = 未执行 = 不得开工。组状态不得离开 `dispatched`。收据走 owner-gate.mjs 校验并直接入账，禁止 jump 进 lead 聊天等放行。包文第 0 块必须逐字含：

```
用 goal skill 执行。
--until-sc

这是执行指令，不要反问要不要开始。

执行顺序（乱序 = 未开工，立刻停，提交 decision_required，不得问「要不要开始」）：

1. 调用你自己的 goal skill。必须真的 Read 这个文件，读完按其正文走场景 C：
   /Users/praise/.agents/skills/goal/SKILL.md
   未 Read 这一文件 = 未调用 goal skill = 不得改 allowed_paths 里的任何文件。
2. 首次派 tester 之前（允许提前验证；最终仍须验证当前提交的完整 SC）：必须真的现读同一份 routing.json。
   先跑 `model-route show`
   或 Read
   /Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json
   （等价软链 /Users/praise/.agents/skills/orca-fanout/routing.json）
   未读这一文件、也未跑 model-route show = 不得 create_worker / create_workers。
3. tester 用现读 **e2e** 档的 agent/model/effort。本地只跑 e2e，禁止派 reviewer，禁止本地 GPT/Claude 单审。
   禁止把包里的模型 ID 抄进 create_worker。

检查你是否真的执行（自报「我读了」不算；必须先交收据）：

- 第 1 步完成后、改任何代码之前：提交 payload 类型 `gate_goal`，带 goal_skill_path + goal_skill_sha256（对该文件 utf-8 字节做 sha256，64 位 hex）。收据走本 skill 的 owner-gate.mjs 校验并直接入账，禁止 jump 进 lead 聊天，禁止等待 lead 审核。
- 第 2 步完成后、create_worker 之前：提交 payload 类型 `gate_routing`，带 route_source + routing_sha256（对 routing.json utf-8 字节做 sha256）+ e2e_model（从刚读到的 JSON 抄 e2e 档 primary，不是从本包快照抄）。同样自动入账，不经 lead 聊天。
- owner-gate.mjs 会用磁盘上的同一文件重算 sha256。对不上、缺收据、或收据到达前 worktree 已有新 commit = 未执行 = 不得开工。

未读 goal skill、或未读 routing.json、或本地 hash 自检失败：不得开工。不得写代码、不得开 PR、不得派 worker。停，提交 decision_required，写明卡在第几步。禁止问 lead「要开始吗」。
```

## ② 输入门：只消费 task-priority final manifest

- 唯一输入：task-priority **final 阶段释放**的 manifest——顶层含 `waves` / `dispatch` / `receipts` 三要素，packets 每包含 `scs_inline` / `allowed_paths` / `verify_cmds` / `forbidden` / `submit_format` 五要素。
- **fail-closed**：manifest 缺 `waves`/`dispatch`/`receipts` 任一、或文件不存在、或 packet 缺五要素任一 → 视为 draft/缺 manifest，**不开跑**，停下指路「汇总任务优先级」。不得拿中间产物开跑。
- `allowed_paths` 只列文件，禁止目录。缺文件路径或含目录 → 渲染开工包失败，不得 create session。

## ③ 总流程与席位

```
task-priority final manifest
  → 0. 输入门
  → 0.5 可选：批准执行 --dry-run
  → 0.7 SiteScout（只读探查，产出 site-report.json；冲突图吃真实写入路径）
  → 1. 核对显式 PR 归属（不猜组名；记录目标仓 merge-base 规模门与 ready-check 含测试总量门；冲突图校验并行/串行；写合并顺序）
  → 2. 每个 PR 写开工包（render-pr-handoff.mjs）
  → 3. send_to_session 派独立 PI owner session（先 owner-dispatch prepare 写一次性 claim，完整包 create 一次，再 bind 真实工具回执；未知结果不重派）→ 立刻钉 Art
  → 3.1 lead 按 owner-protocol 的“整包续跑登记”绑定本 run 的 script-only 调度；已有真实 schedule 回执则复用，不重复创建
  → 3.5 开工闸：新版先 baseline 核查通过，再 gate_goal 自动入账才允许改代码；gate_routing 自动入账后才允许派 worker（不等 lead 聊天放行）
  → 4. owner session：自己的 goal 场景 C 把本 PR 的 SC 跑绿
        → mem-probe → 现读 routing.json 派 tester（e2e 档）
        → 本地不派 reviewer；GPT/Claude 单审取消
        → candidate 只是检查点；owner 自己完成本机验证、push 与 Draft PR 收尾，满足第 6 步双门后转 Ready，lead 不在中途放行
  → 5. Lead 只读每 PR 的自动入账证据与 DECISION_REQUIRED（失败则给一个决定，同一 owner 继续，直到 PR_READY）
  → 6. owner 先开或保持 Draft PR；当前提交 required CI 全绿且审查机进场证据满足后，owner 将 PR 转为 Ready for review（非 draft），再由 `confirm-pr-open.mjs` 消费 OPEN/head 回执。该脚本由 owner 执行，不是 lead 代跑。开 PR ≠ Mini 修复开始。
  → 6.5 owner 在已验收提交上确认 OPEN/非 draft/head/必需 CI 后写 note-event pr_ready，表示本机交付完成；lead 验收全部 priority/SC，不等待审查机结论。
  → 7. lead 不再 register Mini；`watch_registered` 仅兼容旧台账读取。Mivo 交付后 Mini 常驻 Cindy 按 PR nodeid 唯一 session 采集反馈。
  → 8. lead 派 native sub 跑 `wrapup-cleanup.mjs --mode delivered-local-only` 清本地 worktree/分支（不删远端）→ 回报
  → 9. lead `archive_sessions` 归档该 PR 的 PI session 后，用 `confirm-session-archived.mjs --result <工具 JSON>` 出回执再入账；不等其他 PR
```

正常路径是 lead 验收本机 pr_ready 后立即清本地并归档该 owner；Mini Cindy 常驻程序独立扫本人 open PR，本 skill 不再发送盯梢授权。

席位真相源是 `graph.json`（五席，精确键集 E/R/V/T/P；Fable 不是第六席）：

| 席 | dispatch | 谁跑 |
|---|---|---|
| E | `session` | 独立 PI session；`goal=goal-scenario-c` |
| R | `lead-self` | 本地不派 reviewer；云端审查由 Mini Cindy 常驻修复，不在本机 GPT/Claude 单审 |
| T | `worker` | **子 session** 现读 e2e 档派 tester |
| V | `lead-self` | lead 只读验收（ready-check / receipt），不改产品代码；happy path 零产品执行 |
| P | `lead-self` | lead 验收全部 priority/SC 后派 native cleanup sub 并归档该 owner；.pr-intent.md、开远端 PR 和 PR Ready 收口由 owner 执行。graph `route=pr_merge` 只是路由档名，不是 git merge |

`DISPATCH_MODES` = `lead-self` / `worker` / `session`。LEAD_SELF_SEATS = R、V、P。WORKER_SEATS = T。E 不是 lead-self。graph 内不出现具体模型 ID；R 不钉 `model`/`pre_command`/`command`。routing.json 的 agent/model/provider 以每次现读的所选档为准，不把旧 agent 枚举当作限制；独立 owner 的创建使用 send_to_session.agent_kind。

## ④ 拆 PR、并行与合并顺序

沿用 `orca-fanout` 已写死的算法，不另发明。**拆之前必须先 SiteScout**（第 0.7 步）：lead 派只读探查，产物 `site-report.json`（per-SC `real_write_paths`、`cross_sc_edges`、`landmines`、`est_lines`、`open_unknowns`≤5）。冲突图吃 `real_write_paths`，不吃 manifest 里估计的 `allowed_paths`。与 manifest `allowed_paths` 差集过大（新增文件 >30%，或出现跨组共享文件）→ fail-closed 停，指路「汇总任务优先级」修 manifest，lead 不得现场改 `allowed_paths`。`open_unknowns` 非空且涉及组间依赖 → 不拆全量，先切一条串行探路 PR（wave 0 单组）。现有 `prewalk` 只作执行期增量发现，不再是唯一现场来源。台账用 `note-event --event site_report` 记下报告 sha256，不另建状态机。探查 session 无写权限。

派窗机器门：scripts/site-check.mjs 必须通过（逐 SC 完整报告、manifest hash、真实写入授权、同波无交叉写、依赖顺序、未决问题为空）。冲突时回到 task-priority 重新出 final，不现场改清单。它校验只读 sub 的报告，不声称能自动发现所有隐藏依赖。

1. **隐藏依赖先分波**。波与波串行；后波的 base = 前波已合入或已 rebase 的 tip。
2. **同一波内按精确写入路径建冲突图**，只检查显式归属的不同 PR 是否冲突，不把连通分量自动合并为 PR。同一 PR 内部阶段共享路径不算跨 PR 冲突；不同 PR 路径不相交才能并行开工。
3. **跨仓默认可并行**。
4. **规模**：计划期只能估计，执行时分别满足两道门，不混用统计口径。
   - 目标仓非测试门：从该 PR 的 merge-base 树读取 `scripts/ci/size-gate.mjs` 与 `agent-use/docs/pr-rules.json` 的 `sizeGate`，按实际脚本的排除规则统计 added+deleted。WARN/STOP 阈值及缺配置回退值由该基线的脚本和配置决定，非法配置 fail-closed；不能抄本 skill 的常数，也不能用候选分支自改配置放宽本 PR。
   - 本 skill 总量门：新版 `ready-check.mjs` 复核本 PR 明确基线到 candidate 的全部 added+deleted，包含测试；`800` 行起 WARN，`1600` 行起 STOP，无法计数也拒绝。此门不替代目标仓非测试门。
   任一道门达到 STOP，返回重新拆计划并明确新 PR 归属，不自动另开 session，不许豁免、不许丢给 Fable。WARN 不等于 STOP，仍需评估拆分并在交接记录中保留两道门的结果、基线与阈值。

合并顺序单独写进总表，和「能不能并行写代码」分开。子 session **不得自行 merge**。本 skill 也不合入。正常路径由本机 owner 跟到 PR Ready，任务 lead 验收后立即派 native cleanup sub 清本地并归档该 owner；Mini Cindy 常驻程序独立处理云端反馈，本机不再 register、不等待 Mini 接管。只有用户对指定 PR 的当次明确授权才允许合并。

## ⑤ 开工包

子 session 不合入；正常路径由任务 lead 在本机验收后立即清本地并归档该 owner。本 skill 不发送 Mini 盯梢信号，也不以 Mini 注册或接管作为本机收尾前置。

用户可见开工包由 `scripts/render-pr-handoff.mjs` 渲染。旧 `renderExecPacket` 不再作为用户可见开工包。缺块、乱序、缺绝对路径 = 渲染失败，不得 create session。

包文顺序钉死：

**0. 开工闸** — 第①段代码块全文，逐字。
**1. 身份**：仓、对照树（只读）、开发基线 SHA、新分支名、lead session id、本 PR 在总表里的序号。
**2. 为什么改**：人话，一条用户能看见的失败。
**3. 不要重读也能开工的现场（假设收据）**：每个洞一段已证实摘录（文件 + 行号 + 行为/接口签名）。owner 开工即承诺这些假设。发现不符但仍在原 SC、接口和写入范围内，允许定点重读并自主选择等价实现；只有边界变化才 DECISION_REQUIRED。没有摘录 = 渲染失败，不得 create。禁止占位句「本包未附摘录」。
**4. 具体改法**：函数/类型/控制流；兼容旧调用的硬约束。不得复制第 2 段禁令当改法。
**5. allowed_paths**：只列文件，禁止目录。点名不可改的文件。
**6. SC 全文**：每条 `id` + `change` + `holds` + `expect` + `anchor_paths`。禁止「去 ~/.claude/.goal 自己找」。
**7. 验证命令**：可复制的真实命令。禁止 `console.log` 占位，禁止「先读 AGENTS.md 再决定跑什么」，禁止只用 `gh pr diff`。
**8. 做完之后（自动，不要问 lead）：mem-probe → 现读 routing.json 派 e2e（禁止本地单审） → candidate 检查点 → 本机 owner 完成全部 SC/e2e/本地门禁并 push、确认 OPEN 非 draft PR；Mivo 等当前提交 required CI 全绿后写 pr_ready → lead 验收全部 priority/SC 后立即派 native cleanup sub 清本地并归档该 owner。Mini Cindy 常驻程序按 PR 唯一 session 独立修复云端反馈；本机不 register、不等待接管，也不继续同写分支。
**9. 禁做**：硬停六条 + 本 PR 产品禁令 + 「未读 goal / 未读 routing.json 不得开工」+ 不得改总表 / `allowed_paths` / `base` + 假设破裂必须 blocked 上报，禁止就地改方案。含「可自决 / 必须停」两张表。
**10. 回报格式**：第⑩节 exact JSON（candidate 检查点 + pr_ready + decision_required）。

总表（一份，每个子 session 也带上自己那一行）：并行/串行、合并顺序、全局禁做、lead id。

做完之后块必须命令现读，禁止把 `codex/gpt-*` 当作唯一派工值。lead 出包时可附 `model-route show` 快照，标题必须是「渲染当时快照，派工时再读」。模板含绝对路径 + `model-route show`；若含具体模型 ID 必须与「快照」二字同段。

## ⑥ 独立 session 怎么派

通道：send_to_session **create**（不是 Orca worker）。create 出的是普通独立 session，不进 Lead 右侧 worker 栏。真实派工用 scripts/owner-dispatch.mjs 的 prepare → 调现有工具一次 → bind；session-dispatch.mjs 仅保留旧预览入口。详见 references/owner-protocol.md，真派前必须完整读取。

```
send_to_session
  message      = 总表 + 该 PR 开工包
  title        = {项目名}-{任务名}丨 {MMDD}
  working_dir  = 本 PR 已校验的独立 worktree 绝对路径
  use_worktree = false（已经准备且校验本 PR 独立 worktree；不让宿主另选 base）
  agent_kind   = pi
  model        = grok-4.6
  effort       = high
```

create **没有 `provider_id` 字段**。create 后 `provider_id` 为 null 是预期，不是失败。

**硬步骤（失败即停，禁止静默落到非 Art）：**

1. create
2. `get_session_runtime`（拿到 `generation` + `effective.provider_id`）
3. `provider_id !== "art"` → `set_session_runtime({session_id, provider_id: "art", expected_generation})`
4. 再 `get_session_runtime`；仍不是 `art` → fail-closed 停，不派后续 PR

Art = Super Grok（`provider_id=art`，模型 id `grok-4.6`），不是 cindy-art 画图插件。

标题格式：`{项目名}-{中文任务名}丨 {MMDD}`。分隔符是 `丨`，日期两位月日、前面一个空格。任务段必须含至少一个汉字。例：`MivoPlugin-存图补图修复丨 0902`。Mini 常驻修复窗使用 `{项目名}-{任务名}丨修复丨YYYY-MM-DD`，本 skill 不代创建，也不复用 owner 的标题来猜会话身份。

| 仓 | 标题前缀 |
|---|---|
| `xindong/mivo-canvas-plugin` | `MivoPlugin` |
| `xindong/mivo-canvas` | `MivoCanvas` |
| Cindy 客户端 `makecindy/cindy` | `Cindy` |
| 其它 `Project Xxx` | 去掉 `Project ` 后的 PascalCase |

本机没有第二个 Cindy 仓。不先发明 `CindyPlugin`。

时序：① `render-pr-handoff.mjs` 出开工包（此时还没有 session_id）② create ③ 钉 Art ④ `set-state --identity` 一次写齐 `{worktree, branch, base, session_id, title}` ⑤ 记 `dispatch` / `session_created`。create 之后组状态停在 `dispatched`。没有 `gate_goal` 入账之前，禁止 `executing`。

`--dry-run` 写出将要 create 的 `{title, working_dir, agent_kind, model, effort}`，**不**调 `send_to_session`。真实派工走 owner-dispatch.mjs；旧 session-dispatch 非 dry-run 仍拒，不能据此改宿主。

## ⑦ 模型现读纪律

派 worker 前，owner 必须确认可调用 Orca 工具，显式执行 start_team({ worker_permission_mode: "bypassPermissions" })，并确认返回的权限模式仍为 bypassPermissions。返回 auto、能力缺失或无法确认时不得创建 worker；不得用 routing.json 的模型配置冒充权限确认。只读 sub 可用于取信息，不能替代指定的 tester 路由。本地禁止派 reviewer。

PI 会话没有 `~/.claude/rules/orca-model-routing.md` 注入。保证靠开工包命令 + PI `AGENTS.md` 触发表 + 交卷对账。`config/defaults.json` 的 `routingPath` 指向同一文件：

`/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json`

PI 侧软链 `/Users/praise/.agents/skills/orca-fanout/routing.json`；`model-route show` 读的就是这一份。

- tester → role=tester，用现读 **e2e** 档的 agent/model/effort
- 禁止派 reviewer；本地不再跑 GPT/Claude 单审。云端审查由 Mini 盯梢。
- 禁止把 luna / sol / 任何模型 ID 抄进 create_worker；包里若有「渲染当时快照」只供对照，create_worker 以现读为准
- **可恢复失败先自行恢复，不等于任意错误都换 provider。** HTTP 429 / Too Many Requests 按 Retry-After 和既有预算在原路由等待重试；worker 崩溃或异常终止先核原 worker 状态并恢复；创建失败结果不明先查原绑定，不盲目重复创建。等待必须记录下一次唤醒条件，不能报完成。
- 只有 `NO_PROVIDER_FOR_AGENT` / `PROVIDER_ROUTE_UNAVAILABLE` / `BUDGET_MODEL_REQUIRES_API_MODE` 才按现读该档 fallbacks 顺序换 provider、不换代次。每次实际降级记录原因和 fallbacks_tried；未走降级时允许空数组并说明原因，禁止空数组就问 lead。未识别错误、授权不足或恢复预算耗尽才发一条 DECISION_REQUIRED，保留原 owner。
- **不要做的**：绕过共享 routing.json 自造 agent 枚举或给 PI 另做一份路由表；把 luna/sol 写进本 SKILL 当永久默认；primary 429 后空着手问 lead「要不要限流解除」

Lead 验收时现读 live routing.json：交卷 `e2e.model` 既不是当前 e2e 档 primary、也不在该档 fallbacks 里 → 验收失败，指令重派，不准当 ready。本地不核 `review.model`。

## ⑧ 子 session 闭环与 lead 指挥

PR Ready 表示本机验收、当前提交 required CI 全绿、审查机进场证据齐备，以及 OPEN 非 draft PR head 一致；开 PR ≠ Mini 修复开始，lead 验收后立即清本地归档，不能把它误作审查机最终通过。审查机独立打/撤 `review:merge-ready`。

owner session 只许在这五种情况下停。其中 2–5 进入 DECISION_REQUIRED（保留 owner 身份和现场，不算完成）；第 1 种是正常完成，pr_ready 后由 lead 清场归档：

1. owner 已在同一提交完成全部 priority/SC、e2e 与规模门，且审查机进场证据齐备、远端 OPEN 非 draft PR head 一致、必需 CI 全绿：记本机 pr_ready，交 lead 验收。本机释放写入权后不再跟进云端 CI/review。
2. 硬停六条。
3. **本 session 自报**累计打到 `budgetPauseUsd`（可 `--no-budget-pause`）。不是 lead 跨 session 加总。
4. **未读 goal skill 或未读 routing.json**：不得开工。停，提交 decision_required，写明卡在开工闸第 1 步还是第 2 步。禁止 jump 等 lead 放行。
5. **假设破裂**：只有 SC、对外接口兼容、授权、跨 PR 依赖、`allowed_paths` 或 `base` 需要改变时才 blocked + decision_required。现场与 handoff 摘录不一致但仍在原 SC、接口和写入范围内时，owner 必须定点重读并自主选择等价实现，不得把正常调试退回 lead。

连续 3 轮零增量：不得空转，也不得收工。必须发一条 decision_required 摊开卡点。Lead 只给一个决定，同一 owner 继续。

PI owner（含 grok）遇到 worker 429 / 崩溃 / 创建失败：自己按第⑦段恢复，记录原 worker、已尝试动作、预算和下一次唤醒条件。可恢复等待不报完成，不因单次失败问 lead，也不盲目重建窗口。上层未授权的错误码不得换 provider。

Lead 在该 PR 完成本机验收、local-cleaned 与 archived 前不得宣布该 PR 收口；其他独立 owner 不等待。owner idle 不是 Mini 授权；本 skill 不再 register。已部署的宿主 `lead-continuation.py` 使用显式配置绑定 lead session、ledger 与状态源，每 5 分钟以 script-only（零模型）读取结构化进度和工具回执；正常 owner 阶段变化只更新进度，不逐轮唤醒 lead。`pr_ready`、决策、清理归档或后继可派信号变化才唤醒 lead；没有进展满 30 分钟后续跑一次，同一指纹最多 3 次且每次间隔 30 分钟，仍无进展才记 `blocked`。只有所有 PR 都有真实归档回执才可将整包标记 complete；Cindy 离线或宿主脚本不可用时，不能保证后台自动推进。

「可验收」= 本 PR 全部 priority/SC 交卷合法 + e2e PASS + size-gate ≠ STOP + OPEN/非 draft PR head 一致 + 当前提交必需 CI 全绿。云端审查反馈不属于本机交卷前置。本地不要求 GPT/Claude 单审。

子 session 派 tester **之前**自己跑 `mem-probe.mjs`。Lead 在同一波并行 create 多个 session 前也跑一次 mem-probe，按 `pending = 本波 PR 数` 估槽（每 PR 只派 e2e，不再另派 reviewer）。同批 ≥2 worker 用 `create_workers` 批量派发，禁连续 `create_worker` 单发。

## ⑨ 台账与状态机

Mini Cindy 常驻程序是云端反馈修复者；本机 owner 仅推进到本机 pr_ready，随后由 lead 清本地并归档。

组 = 一个 PR。`GROUP_KEYS` exact，新增 `session_id` / `title` / `pr_url` / `provider_id`（未派发前 null）。未列键 `SCHEMA` 拒。

`GROUP_STATES`：`pending | dispatched | executing | blocked | e2e | review | accepted | pr-open | local-cleaned | archived | failed`。旧的 `delivered` / `review_pass` / `verified` 删除。

映射：dispatched = session 已 create 且 Art 已钉；executing = 子 session 在干活；blocked = 卡点上报；e2e/review = 子闭环阶段；local_validated = owner 自己完成本机七门验收；accepted = 兼容旧台账的 lead 检查点，不再是正常 owner 的必经闸；pr-open = 远端已开；local-cleaned = 本机 pr_ready 后 lead 清本地；archived = PI session 已归档。

三份收尾回执必须带铸造时的 `ledger_version` + 本组 `assignment_seq`；仅兼容历史任务的 Mini `register.mjs` 回执也保留相同校验，新任务不创建该回执。入账时 `ledger_version` 不得大于当前台账 version（其它组先入账导致 version 前进仍可入账），且 `checked_at` 必须是可解析时间并晚于本组前置事件。旧代回执不得重放。`confirm-pr-open.mjs` / `wrapup-cleanup.mjs` 必须带 `--now` / `--ledger-version` / `--assignment-seq`，stdout 才能直接当回执入账。

`set-state --identity` 允许键：`{worktree, branch, base, session_id, title}`。`identityDigest` 输入段顺序：`seq → worktree → branch → base → session_id`（session_id 未定时用空串，create 后必须重写 identity 再记 dispatch）。

`EVENT_TYPES` 新增：`session_created`、`session_steer`、`gate_goal`、`gate_routing`、`pr_opened`、`accepted`、`pr_ready`、`local_cleaned`、`session_archived`、`watch_registered`、`site_report`、`replan_note`。旧 `delivery` 仍是子 session candidate 交卷的唯一真写入口（`record-delivery`）。`gate_goal` / `gate_routing` 的 detail 必须含 `group_id` + 对应 sha256；缺 sha256 拒。`site_report` / `replan_note` / `pr_ready` / `watch_registered` 只经 `note-event` 入账，不进 set-state 成功流。`pr_ready` 只允许在本组 `pr-open` 入账，表示这一颗 PR 已机器可证明 Ready；不得用 run 级 `phase=ready` 或「四个 PR 都 push 了」代替。`watch_registered` 仅兼容旧台账读取，新路径不再要求 Mini 名册先于清场。`→local-cleaned` 要求本组成立的 `pr_ready` 与 wrapup-cleanup 成功回执。同一次任务 4 个 PR：谁 Ready 谁清场归档，未 Ready 的独立继续。`local-cleaned→archived` 必须消费 `confirm-session-archived.mjs` 产出的回执（输入是 `archive_sessions` 工具 JSON，不是手写 archived=true）。run 级 `phase=ready` 是验收门过了的冻结；组级 `pr-open` / `pr_ready` / `local-cleaned` / `archived` 与兼容的 `watch_registered` 仍可在 ready 之后写入，但必须带对应脚本回执，禁止只填 URL / 只报事件名。

`PHASE_ORDER` 改成 run 级：`splitting | dispatching | running | accepting | ready`。组级状态机在 group 上。

`PR_RECEIPT_KEYS` exact：`pr_id, session_id, candidate_sha, pr_url, e2e_status, size_result, ledger_version, checked_at`。candidate 交卷阶段还没有 `pr_url`。`pr_url` 在 accepted→pr-open 时才写入。缺 `gate_goal` / `gate_routing` 事件的组，ready-check 直接 GAP，不得 accepted。

ready-check 先每 PR、再 run：对每个 group 用该组 worktree 跑门；单 PR 通过后独立写 LOCAL_PR_VALIDATED，不等其它组；兼容旧整批入口才写 run 级 `READY_FOR_LATER_SUBMIT_PR_SKILL`。这行是验收门过了的机器信号，意思是 owner 可以继续开远端 PR 并在 PR Ready 后归档；不是「交给以后的提交 PR skill」，也不是 lead 可以 git merge。旧 `accepted` / run `ready` 不得原地改名冒充 PR Ready。七门按 PR 各算一遍。L2 相对该 PR 的 `identity.base`。run 级 ready 额外一条：总表里的波次顺序已记录；真正合入不由本 skill 执行。

`watch_registered` 旧回执仍可读，但新 Mivo 路径不再把它当清场前置。Mini Cindy 以 PR nodeid 建唯一修复 session，title 为 `{项目名}-{任务名}丨修复丨YYYY-MM-DD`；本 skill 不代创建该 session。

Lock+tmp+rename+CAS 与 `LedgerError` 码沿用。`budget_note` 事件可留，但 lead 不跨 session 加总账单。

## ⑩ 交卷 schema

开工闸收据（改代码前 / 派 worker 前，各一次自动入账，不是终态交卷，禁止 jump 进 lead 聊天）：

```
gate_goal     {type:"gate_goal", goal_skill_path, goal_skill_sha256}
gate_routing  {type:"gate_routing", route_source, routing_sha256, e2e_model}
```

owner-gate.mjs 对磁盘文件 `/Users/praise/.agents/skills/goal/SKILL.md`（realpath 后与 live `.../claude-active/goal/SKILL.md` 同一 inode 也算）算 sha256，与 `gate_goal` 逐字比对。不过 → `overreach_rejected`。`gate_goal.at` 之前该 worktree 相对 `identity.base` 已有非文档 diff → 越域，指令 revert。`gate_routing` 对 `/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json`；收据里的 `e2e_model` 必须等于该文件当前 e2e 档 primary（或 fallbacks 之一）。不过 → 不得 `create_worker`。由 owner 自己调用 owner-gate.mjs，不需要宿主 gateway；脚本能核文件 hash 和返回的权限模式，不把它说成宿主拦截或阅读过程证明。

candidate `record-delivery --payload` exact（验收前，**不得含 pr_url**）：

```
branch          非空
tip_sha         40 hex
scs             [{id, status: pass|fail|not_run}] 且 id 集合 == 该 PR scs_inline
goal_skill_path 必须是 /Users/praise/.agents/skills/goal/SKILL.md
                 （或同一 inode 的 /Users/praise/.claude/skills/goal/SKILL.md
                  / /Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/goal/SKILL.md）
e2e             {status, candidate_sha, model, route_source}
size_gate       {result: 非空字符串, candidate_sha: 40hex}
fallbacks_tried [{route, model, provider_id, error}] 无降级写 []；禁止 tried_fallbacks
```

`goal_skill_path` 缺或不是上表三路径之一 → 视为未调用 PI 自己的 goal skill，拒。台账里没有本组成立的 `gate_goal` + `gate_routing` → 视为未执行开工闸，拒，不得 `accepted`。含 `pr_url` → 拒。`route_source` 必须是 live routing.json 绝对路径、其 `~/.agents/skills/orca-fanout/routing.json` 软链、或字面量 `model-route show`。其它路径拒。缺键 / 多键 / sha 不是 40 hex / `scs` 对不齐 → 拒。

## ⑪ 预算告警如实声明

`config/defaults.json` 的 `budgetPauseUsd` **不再被 lead 当机器闸读取**。字段可留，避免无关键删除掀测试。lead 不跨 session 加总，没有测得到的 run 级 $30。

子 session 包文保留 goal `--until-sc` 原句：本 session 自报打到该阈值则暂停、jump 回报 lead。人独占名单里的「预算暂停」改指这条自报，不是 lead 算账。`--no-budget-pause` 仍可写进包文，关闭该子 session 的自报暂停。

## ⑫ `--dry-run`

`批准执行 --dry-run`：只写拆分表 + 各 PR 开工包 + 将要 create 的 `{title, working_dir, agent_kind, model, effort}`，**不**调 `send_to_session`。

`批准执行`（无 flag）：真派。触发词表仍是「直接执行不确认」，不强制用户第一次必须 dry-run；实现后上线先 dry-run 给用户过目。

## ⑬ 不停机条款（仅五类停）

仅第⑧节五类停。硬停六条（autonomous-execution）仍是人独占，禁止进 Fable、禁止豁免第④节任一道规模硬闸或输入门。size-gate `STOP` 只能再拆 PR，不能进 sidecar；`WARN` 必须保留证据并评估拆分，不得误写成 STOP。假设破裂走第 5 类停 + 第⑱节 replan，不进 sidecar。

## ⑭ 与提交 PR 的边界

本 skill 做：拆 PR、派唯一 owner、内联执行契约、本地 e2e、owner 开 OPEN 非 draft PR；Mivo owner 确认当前提交 required CI 全绿后写 pr_ready。lead 验收全部 priority/SC 后立即派 native cleanup sub 清本地并归档该 owner。Mini 常驻程序每 PR 一个唯一修复 session 独立处理云端反馈，本 skill 不 register、不等待接管。本地不再跑 GPT/Claude 单审。

本 skill 不合入，不跑三机同步。本 skill 不做：三审、改 submit-pr skill、resume 旧 Mini 盯梢班车、自动 `gh pr merge`。子 session 不得自行 merge。三审仍不在本 skill。

## ⑮ 保证等级声明

编排契约（席位、开工闸原文、交卷 schema、标题正则、Art 钉、routing 现读）由本仓测试冻结，等级 T1：防疏忽/漂移。不夸大成宿主强制拦截 `create_worker` 参数。Cindy 没有 per-worker tool allowlist。submit-pr 三审不是本 skill 的兜底句。

## ⑯ 防越域与验收

Lead 允许：读码、写开工包、派/收回 session、只读验收证据、按第⑱节 replan；验收本组 pr_ready 后立即派 native cleanup sub，清本地成功后用 `archive_sessions` 归档 PI session。不允许：改产品代码、替子 session 修 bug、替 owner 开 PR、追 CI/review、手工搬 receipt、git merge、resume 旧盯梢班车、缺 pr_ready 或未验收就清本地。本 skill 不 register、不等待 Mini 接管。happy path 产品执行调用数为 0；编排派窗、验收决定、派清场 sub 与归档是 lead 的职责。越域 commit 验收失败。`gate_goal` 过账后才允许 worktree 出现本 PR 的新 commit。该 PR diff 触碰了别组 site-report 里的 read 依赖文件 → 即使在自己 `allowed_paths` 内也标「需重协调」，下游不得开工直到 lead 重发包。

## ⑰ Fable 决策 sidecar（非第六席）

grok 作为 lead **本来会停下来主动问用户拍板**时，才把题交给 Fable 代决策。这不是 E/R/V/T/P 的第六席，**不进 `graph.json`，不加 `routing.json` 的 decision 档，不进 `config/defaults.json`，不做第五类 `record-delivery`**。配置独占 `config/fable-decision.json`（`claude-fable-5` / `low` / isolationLevel=`T1`）；机器闸是 `scripts/decision-broker.mjs` + 独立 journal（默认 `~/.claude/.orca/approve-exec-decisions/<run_id>.json`）。

用户说「发 worker fable5」时走本 sidecar，**禁止 `create_worker` 调 Fable**（禁止 `create_worker` role=任意、model=`claude-fable-5`）。

**唯一入场条件**：lead 必须能写出「若无代理，grok 将停下来问用户的原句」。查资料、执行、审查、策略优化、规则已有唯一答案、「要开始吗 / 能不能并行」、机械故障（缺文件/缺 receipt）一律不得开 sidecar。人独占（autonomous-execution 硬停六条、A 类 routing fail-closed、子 session 自报预算暂停、第④节任一道规模硬闸或输入门豁免、密钥与组织配置）`human_exclusive=true`，停给用户，禁止进 Fable。

**充分 handoff**：必须是六块 canonical object（现场 / 已改或 `no_changes` / 瓶颈与已排除 / 完整执行过程 / 原问句 / 选项+约束），每块必须是非空字符串或非空对象（空串/空对象拒），broker 存 `handoff_hash` + `context_hash`。去重键 `decision_key` 含 run/manifest/phase/wave/groups/问句/选项/约束/`context_hash`，禁止裸问句去重。

**Fable 只判断（强制）**：lead 判不了才交给 Fable。Fable 自己不准查、不准写、不准改文件、不准推进 phase/组状态。要任何信息必须派只读 sub（`request-evidence` → `attach-evidence` 开新 revision）；任何落盘 / 改文件 / 出包 / 写台账也必须派 sub。交卷 schema 强制 `tools_used`；`resolve` 必传 worktree（省略即 ABUSE）；decision worktree `git status --porcelain` 必须空，非空记 `decision_abused` 并作废。`attach-evidence` 的 `bundle_hash` 必须等于 `sha256(canonical(items))`，自报字符串拒。journal `requests[]` 按 `REQUEST_RECORD_KEYS` exact 校验。无 `evidence_attached` 却声称已核实 → 作废（T1 闸三）。拆错 / 假设破裂是程序题，按第⑱节四类走，不进 sidecar。

**隔离等级如实声明：T1 纪律级，不是强制级。** Cindy worker 没有 per-worker tool allowlist。不得把 Orca worker 包装成工具隔离。

**配额 / CAS**：只在 `decision_opened` 原子成功时计数（每 wave 2 / 每 run 6，数从 `fable-decision.json` 读）。同 `decision_key` 同时一个 open lease；晚到或错 `lease_nonce` → `DECISION_SUPERSEDED`，不覆盖。ready-check 不读 sidecar journal，合法决策事件不得挡 READY。

## ⑱ 偏航补救与自进化

**replan（不加新状态机）**：现有 `failed→pending`（清身份与计数、`assignment_seq+1`、旧 `identityDigest` 失配）是唯一重派通道。因果记在 `replan_note`（`note-event`，不驱动状态）。detail exact：`origin_group`、`broke_assumption`、`affected_groups`、`action` ∈ `{repack|resplit|land-first|split-new}`。

Lead 按四类选，不自由发挥：

- **repack**：只影响本组 → 重出包，同 session `steer` 或 `failed→pending` 重派。
- **resplit**：拆错（路径撞 / 漏依赖）→ 停同波未 `accepted` 的下游，按新冲突图重切；废组 `failed→pending` 后不再派。
- **land-first**：方案变更且下游依赖 → 该组先落地或作废重做；下游全部 `failed→pending` 换 base 重出包，禁止在旧 base 上继续。
- **split-new**：第④节任一道规模门达到各自硬上限 → 现有 size-gate `STOP` 路径不变；仅达到相应预警线时记 `WARN`，不得误写成 STOP，但应评估拆分并保留预警证据。

下游冻结：任一组因假设破裂 `blocked` → 依赖它的同波 / 后波组不得 `gate_goal` 放行。前波 tip 变化 → 后波未开工组必须换 base 重出包。已合入才发现偏航：不回滚 main，开修正 PR，`replan_note` 记因果。

**自进化**：每轮 run 收尾、摘要之前，把拆错 / 假设破裂 / 补救不对记进 `evolution/ledger.json`（唯一写通道 `scripts/evolution-note.mjs`）。三档 `by-design` / `proposal` / `auto`；扩权与拿不准永不自动落地。默认不 git push。登记进 Cindy「每周自进化 Skills」（`ledger-triage.mjs` `SOURCES`）。

## 历史 Mini 运维前置（仅兼容旧任务，新任务不执行）

以下是旧注册调度的运维记录，仅供已有历史名册排障；不是当前 owner 派发、pr_ready、清本地或归档的前置。新任务由 Mini Cindy 常驻程序独立处理云端反馈，本 skill 不安装调度、不发 lead signal、不 register，也不等待 Mini 接管。

- 在 Mini 新建一条 **script 模式**调度，名字用 `config/mini-watch.json` `hosts.mini.schedule_name`，不得与旧班车重名。
- 四元组取自 `config/mini-watch.json` `hosts.mini` 的 `agent_kind` / `model` / `effort` / `provider_id`（不要再手抄进脚本或本文其它段）。
- capabilities 含 `sessions.dispatch`。
- 命令指向本仓 `scripts/pr-watch/session-watch-script.py`。
- 调度 env：`PATH` 含 `/opt/homebrew/bin`（非交互 ssh 下 `gh` 必须找得到）；`AE_WATCH_STATE_DIR` / `AE_WATCH_SNAPSHOT_CMD` 按配置的 `state_dir` 与本仓 `deploy/wrappers/gh-snapshot.mjs`。
- Mini 被叫醒后走 goal skill 场景 E（盯梢 pr-fix）。CI 绿 + review 清零时只发「可合并」通知，merge 由人点。
- `config/mini-watch.json` `old_schedule_ids_blocklist` 里的旧两条调度保持 paused 不动，禁止 resume。

历史兼容约束：旧名册缺原始 lead 授权、Mini 调度不可用、首扫未确认或投递结果未知时，只阻塞该历史协议的受阻动作，不把旧条件带入新任务的本机收尾；不伪造注册，不恢复旧班车，不自动 merge。当前归档 PI 使用 archive_sessions，并由 confirm-session-archived.mjs 校验。
