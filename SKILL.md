---
name: approve-exec
description: 批准执行——只吃 task-priority final manifest；lead 拆 PR、写开工包、派独立 PI session、验收；E 由子 session 走 goal 场景 C；R/T 由子 session 现读 routing.json 派 worker；lead 不改产品代码；验收通过后再通知各 session 开远端 PR、注册 Mini 盯梢、清本地、归档 PI session。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — lead 编排守则

**lead 按本文编排**：把 task-priority 产出的 `task-manifest.json` 拆成每 PR 一个独立 PI session，先做到可验收（还不开远端 PR）。验收通过后再 jump 各 session 开 GitHub ready PR，确认已 open，立刻把 PR 写入 Mini 盯梢名册，再清本地 worktree/分支，最后归档这些 PI session。不改「提交 PR」skill。子 session 不得自行 merge。本 skill 不合入、不跑三机同步。

Lead 只做五件事：拆 PR、写开工包、派/收回独立 session、验收、验收后指挥开远端 PR 并归档 PI session。功能代码、SC 执行、e2e、GPT 单审都在子 session。Mini 名册写完、全部 PI session 归档之前 lead 不停。Fable 只走第⑰ sidecar，禁止 `create_worker` 调 Fable。

生态链：task-priority（出 manifest）→ **本 skill（拆 PR + 派独立 session + 验收 + 开远端 + 注册 Mini + 清场归档）** → 子 session 调它自己的 goal 场景 C。三审仍不在本 skill。

本文是 lead 侧编排的**唯一守则**。机器保障：`scripts/run-tests.mjs` 冻结枚举 + `tests/skill-doc.test.mjs` 结构断言。

## ① 身份与触发

- frontmatter：`name: approve-exec`，触发词「批准执行」。
- 用法：`批准执行`（用当前最新 final manifest 真派）/ `批准执行 --dry-run`（只出拆分表 + 开工包 + 将要 create 的参数，不调 `send_to_session`）/ `批准执行 --resume <run_id>` / `批准执行 --no-budget-pause`（写入包文，关闭该子 session 的自报暂停）。
- 本 skill 是 **lead 编排层**：Lead 禁止改 `allowed_paths` 里的产品代码，禁止替子 session 修 bug，禁止替子 session 开 PR。E 席 `dispatch=session`；R/T 席 `dispatch=worker`（由**子 session** 派）；V/P 席 `dispatch=lead-self`（只读验收 / 写台账与 `.pr-intent.md`）。
- **开工闸（PI 子 session）**：未交过账的 `gate_goal` / `gate_routing` = 未执行 = 不得开工。组状态不得离开 `dispatched`。包文第 0 块必须逐字含：

```
用 goal skill 执行。
--until-sc

这是执行指令，不要反问要不要开始。

执行顺序（乱序 = 未开工，立刻停，jump 回报 lead）：

1. 调用你自己的 goal skill。必须真的 Read 这个文件，读完按其正文走场景 C：
   /Users/praise/.agents/skills/goal/SKILL.md
   未 Read 这一文件 = 未调用 goal skill = 不得改 allowed_paths 里的任何文件。
2. 本 PR 的 SC 全 PASS 之后、派 tester/reviewer 之前：必须真的现读同一份 routing.json。
   先跑 `model-route show`
   或 Read
   /Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json
   （等价软链 /Users/praise/.agents/skills/orca-fanout/routing.json）
   未读这一文件、也未跑 model-route show = 不得 create_worker / create_workers。
3. tester 用现读 **e2e** 档的 agent/model/effort；reviewer 用现读 **review** 档。
   禁止把包里的模型 ID 抄进 create_worker。

检查你是否真的执行（自报「我读了」不算；必须先交收据）：

- 第 1 步完成后、改任何代码之前：jump 回报 lead，payload 类型 `gate_goal`，带 goal_skill_path + goal_skill_sha256（对该文件 utf-8 字节做 sha256，64 位 hex）。
- 第 2 步完成后、create_worker 之前：jump 回报 lead，payload 类型 `gate_routing`，带 route_source + routing_sha256（对 routing.json utf-8 字节做 sha256）+ e2e_model + review_model（从刚读到的 JSON 抄 primary，不是从本包快照抄）。
- lead 会用磁盘上的同一文件重算 sha256。对不上、缺收据、或收据到达前 worktree 已有新 commit = 未执行 = 不得开工。

未读 goal skill、或未读 routing.json、或收据未过 lead 对账：不得开工。不得写代码、不得开 PR、不得派 worker。停，jump 回报 lead，写明卡在第几步。
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
  → 1. 拆 PR（估计 ≤800 行；冲突图定并行/串行；写合并顺序）
  → 2. 每个 PR 写开工包（render-pr-handoff.mjs）
  → 3. send_to_session 派独立 PI session → 立刻钉 Art
  → 3.5 开工闸：gate_goal 过账后才允许改代码；gate_routing 过账后才允许派 worker
  → 4. 子 session：自己的 goal 场景 C 把本 PR 的 SC 跑绿
        → mem-probe → 现读 routing.json 派 tester（e2e 档）
        → 现读 routing.json 派 reviewer（review 档 = GPT 单审）
        → 不开远端 PR，按第⑩节 candidate 交卷 jump 回报
  → 5. Lead 按每 PR receipt 验收（失败则充分交接重派，直到 accepted）
  → 6. 验收通过后 jump 各 session 开远端 ready PR（非 draft）；`confirm-pr-open.mjs` 确认
  → 7. ssh Mini 跑 register.mjs 写入盯梢名册（不要 `--verify` 去查旧班车）→ 把 stdout 回执落盘 → `note-event watch_registered`（`--detail.receipt` = 该回执文件；不要传本机假 state_file）
  → 8. 各 session `wrapup-cleanup.mjs` 清本地 worktree/分支（不删远端）→ 回报
  → 9. lead `archive_sessions` 只归档这些 PI session（lead 自己由用户归档）
```

席位真相源是 `graph.json`（五席，精确键集 E/R/V/T/P；Fable 不是第六席）：

| 席 | dispatch | 谁跑 |
|---|---|---|
| E | `session` | 独立 PI session；`goal=goal-scenario-c` |
| R | `worker` | **子 session** 现读 review 档派 GPT 单审 |
| T | `worker` | **子 session** 现读 e2e 档派 tester |
| V | `lead-self` | lead 只读验收（ready-check / receipt），不改产品代码 |
| P | `lead-self` | lead 写台账 + `.pr-intent.md`；验收后指挥开远端 PR、注册 Mini、清本地、归档 PI。graph `route=pr_merge` 只是路由档名，不是 git merge |

`DISPATCH_MODES` = `lead-self` / `worker` / `session`。LEAD_SELF_SEATS = V、P。WORKER_SEATS = R、T。E 不是 lead-self。graph 内不出现具体模型 ID；R 不钉 `model`/`pre_command`/`command`。routing.json 的 agent 枚举仍是 `codex` | `claude-code`，**不准把 PI 写进路由档**。PI 只出现在 `send_to_session.agent_kind`。

## ④ 拆 PR、并行与合并顺序

沿用 `orca-fanout` 已写死的算法，不另发明。**拆之前必须先 SiteScout**（第 0.7 步）：lead 派只读探查，产物 `site-report.json`（per-SC `real_write_paths`、`cross_sc_edges`、`landmines`、`est_lines`、`open_unknowns`≤5）。冲突图吃 `real_write_paths`，不吃 manifest 里估计的 `allowed_paths`。与 manifest `allowed_paths` 差集过大（新增文件 >30%，或出现跨组共享文件）→ fail-closed 停，指路「汇总任务优先级」修 manifest，lead 不得现场改 `allowed_paths`。`open_unknowns` 非空且涉及组间依赖 → 不拆全量，先切一条串行探路 PR（wave 0 单组）。现有 `prewalk` 只作执行期增量发现，不再是唯一现场来源。台账用 `note-event --event site_report` 记下报告 sha256，不另建状态机。探查 session 无写权限。

1. **隐藏依赖先分波**。波与波串行；后波的 base = 前波已合入或已 rebase 的 tip。
2. **同一波内按精确写入路径建冲突图**，连通分量 = 一个 PR。路径不相交才能并行开工。
3. **跨仓默认可并行**。
4. **规模**：计划期只能估计。估计会超 800 行（`size-gate.mjs`：相对 `origin/main` 的非测试 added+deleted）必须再拆。真实判定在子 session 的 candidate 上；`result=STOP` 的唯一出路是拆出新 session，不许豁免、不许丢给 Fable。

合并顺序单独写进总表，和「能不能并行写代码」分开。子 session **不得自行 merge**。本 skill 也不合入；合入发生在 GitHub 上，由 Mini 盯梢跟到可合（本轮不自动 `gh pr merge`）。

## ⑤ 开工包

用户可见开工包由 `scripts/render-pr-handoff.mjs` 渲染。旧 `renderExecPacket` 不再作为用户可见开工包。缺块、乱序、缺绝对路径 = 渲染失败，不得 create session。

包文顺序钉死：

**0. 开工闸** — 第①段代码块全文，逐字。  
**1. 身份**：仓、对照树（只读）、开发基线 SHA、新分支名、lead session id、本 PR 在总表里的序号。  
**2. 为什么改**：人话，一条用户能看见的失败。  
**3. 不要重读也能开工的现场（假设收据）**：每个洞一段已证实摘录（文件 + 行号 + 行为/接口签名）。子 session 开工即承诺这些假设。发现不符 → 第 5 类停，禁止就地改方案。没有摘录 = 子 session 会 Grep 整模块。  
**4. 具体改法**：函数/类型/控制流；兼容旧调用的硬约束。  
**5. allowed_paths**：只列文件，禁止目录。点名不可改的文件。  
**6. SC 全文**：每条 `id` + `change` + `holds` + `expect` + `anchor_paths`。禁止「去 ~/.claude/.goal 自己找」。  
**7. 验证命令**：可复制的真实命令。禁止 `console.log` 占位，禁止「先读 AGENTS.md 再决定跑什么」。  
**8. 做完之后（自动，不要问 lead）**：mem-probe → **现读同一份 routing.json 再派** e2e / GPT 单审 → 按第⑩节 candidate 交卷 jump 回报 → 停等验收。验收前不开远端 PR。子 session 不合入。lead jump「开远端 PR」之后才 `gh pr create/edit`。Mini 名册写完、`watch_registered` 入账之后才跑 wrapup-cleanup。
**9. 禁做**：硬停六条 + 本 PR 产品禁令 + 「未读 goal / 未读 routing.json 不得开工」+ 不得改总表 / `allowed_paths` / `base` + 假设破裂必须 blocked 上报，禁止就地改方案。  
**10. 回报格式**：第⑩节 exact JSON。

总表（一份，每个子 session 也带上自己那一行）：并行/串行、合并顺序、全局禁做、lead id。

做完之后块必须命令现读，禁止把 `codex/gpt-*` 当作唯一派工值。lead 出包时可附 `model-route show` 快照，标题必须是「渲染当时快照，派工时再读」。模板含绝对路径 + `model-route show`；若含具体模型 ID 必须与「快照」二字同段。

## ⑥ 独立 session 怎么派

通道：`send_to_session` **create**（不是 Orca worker）。create 出的是普通独立 session，不进 Lead 右侧 worker 栏。由 `scripts/session-dispatch.mjs` 执行。

```
send_to_session
  message      = 总表 + 该 PR 开工包
  title        = {项目名}-{任务名}丨 {MMDD}
  working_dir  = 该仓绝对路径
  use_worktree = true
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

标题格式：`{项目名}-{任务名}丨 {MMDD}`。分隔符是 `丨`，日期两位月日、前面一个空格。例：`MivoPlugin-存图补图修复丨 0902`。

| 仓 | 标题前缀 |
|---|---|
| `xindong/mivo-canvas-plugin` | `MivoPlugin` |
| `xindong/mivo-canvas` | `MivoCanvas` |
| Cindy 客户端 `makecindy/cindy` | `Cindy` |
| 其它 `Project Xxx` | 去掉 `Project ` 后的 PascalCase |

本机没有第二个 Cindy 仓。不先发明 `CindyPlugin`。

时序：① `render-pr-handoff.mjs` 出开工包（此时还没有 session_id）② create ③ 钉 Art ④ `set-state --identity` 一次写齐 `{worktree, branch, base, session_id, title}` ⑤ 记 `dispatch` / `session_created`。create 之后组状态停在 `dispatched`。没有 `gate_goal` 入账之前，禁止 `executing`。

`--dry-run` 写出将要 create 的 `{title, working_dir, agent_kind, model, effort}`，**不**调 `send_to_session`。

## ⑦ 模型现读纪律

PI 会话没有 `~/.claude/rules/orca-model-routing.md` 注入。保证靠开工包命令 + PI `AGENTS.md` 触发表 + 交卷对账。`config/defaults.json` 的 `routingPath` 指向同一文件：

`/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json`

PI 侧软链 `/Users/praise/.agents/skills/orca-fanout/routing.json`；`model-route show` 读的就是这一份。

- tester → role=tester，用现读 **e2e** 档的 agent/model/effort
- reviewer → role=reviewer，用现读 **review** 档（这就是 GPT 单审）
- 禁止把 luna / sol / 任何模型 ID 抄进 create_worker；包里若有「渲染当时快照」只供对照，create_worker 以现读为准
- primary 失败按该档 fallbacks 顺序降级，标注原因；降级链耗尽停，回报 lead，不猜替代品
- **不要做的**：把 PI 写进 `routing.json` 的 agent 枚举；给 PI 另做一份路由表；把 luna/sol 写进本 SKILL 当永久默认

Lead 验收时现读 live routing.json：交卷 `e2e.model` / `review.model` 既不是当前 primary、也不在该档 fallbacks 里 → 验收失败，指令重派，不准当 ready。

## ⑧ 子 session 闭环与 lead 指挥

子 session 只许在这五种情况下停：

1. 本 PR：SC 全 PASS + e2e worker PASS + GPT 单审 unresolved==0 + size-gate ≠ STOP + 已按第⑩节 candidate 交卷回报 lead。验收前不开远端 PR。
2. 硬停六条。
3. **本 session 自报**累计打到 `budgetPauseUsd`（可 `--no-budget-pause`）。不是 lead 跨 session 加总。
4. **未读 goal skill 或未读 routing.json**：不得开工。停，jump 回报 lead，写明卡在开工闸第 1 步还是第 2 步。
5. **假设破裂**：第 3 段摘录的接口/行为与实际不符，或必须偏离第 4 段改法。立刻 `blocked` + jump 回报 lead：哪条假设破了、影响哪些文件、是否波及别组。禁止就地改方案继续写。无权改总表、无权改 `allowed_paths`、无权换 `base`——这三件事只能 lead 走第⑱节 replan。

连续 3 轮零增量：不得空转，也不得收工。必须 jump 回 lead，摊开卡点。Lead 给可执行的下一刀，再 jump 回去。

Lead 在全部 PI session 归档、Mini 名册写完之前不得结束。子 session `get_session_runtime` 变 idle 且没有合格交卷 → `steer_session` 或 jump：「未到停点，继续；卡点报我」。子 session 问「要开始吗 / 能不能并行」→ 驳回，这些不是决策题。越域 / 改了别人的 PR → 验收失败，给予充分交接（现场 / 已改 / 卡点 / 要改什么 / 不要改什么 / 验证命令）后 `failed→pending` 重派，直到 accepted。

「可验收」= candidate 交卷合法 + e2e PASS + GPT 单审 unresolved==0 + size-gate ≠ STOP，**还没有** GitHub URL。验收通过后 lead jump 开远端 ready PR；`confirm-pr-open.mjs` 确认非 draft 且 head 对得上。然后先注册 Mini 名册并 `note-event watch_registered`，再清本地，最后归档这些 PI session。合入不是本 skill 的收尾。

子 session 派 tester/reviewer **之前**自己跑 `mem-probe.mjs`。Lead 在同一波并行 create 多个 session 前也跑一次 mem-probe，按 `pending = 本波 PR 数 × 2` 估槽。同批 ≥2 worker 用 `create_workers` 批量派发，禁连续 `create_worker` 单发。

## ⑨ 台账与状态机

组 = 一个 PR。`GROUP_KEYS` exact，新增 `session_id` / `title` / `pr_url` / `provider_id`（未派发前 null）。未列键 `SCHEMA` 拒。

`GROUP_STATES`：`pending | dispatched | executing | blocked | e2e | review | accepted | pr-open | local-cleaned | archived | failed`。旧的 `delivered` / `review_pass` / `verified` 删除。

映射：dispatched = session 已 create 且 Art 已钉；executing = 子 session 在干活（前置：已有本组成立的 `gate_goal`）；blocked = 卡点上报；e2e/review = 子闭环阶段；accepted = lead 验收通过、尚无远端 PR；pr-open = 验收后远端已开；local-cleaned = Mini 名册已写且本地 worktree/分支已清；archived = PI session 已归档。`create_worker` 对应的 dispatched 前置：已有本组成立的 `gate_routing`。`accepted→pr-open` 必须消费 `confirm-pr-open.mjs` 成功回执（`--pr-open-receipt`：OPEN、`isDraft===false`、head 对上台账 tip；缺/null 一律拒）。`pr-open→local-cleaned` 要求本组成立的 `watch_registered`，并消费 `wrapup-cleanup.mjs` 成功回执（`--cleanup-receipt`：ok、未 skip、未删远端；脚本核当前分支、拒 dirty、删完复核 worktree/branch 不在）。`local-cleaned→archived` 必须消费 `archive_sessions` 成功回执（`--archive-receipt`：archived=true 且 session_id 对得上）。三份收尾回执与 Mini `register.mjs` 回执都必须带铸造时的 `ledger_version` + 本组 `assignment_seq`；入账时 `ledger_version` 不得大于当前台账 version（其它组先入账导致 version 前进仍可入账），且 `checked_at` 必须是可解析时间并晚于本组前置事件。旧代回执不得重放。`confirm-pr-open.mjs` / `wrapup-cleanup.mjs` 必须带 `--now` / `--ledger-version` / `--assignment-seq`，stdout 才能直接当回执入账。

`set-state --identity` 允许键：`{worktree, branch, base, session_id, title}`。`identityDigest` 输入段顺序：`seq → worktree → branch → base → session_id`（session_id 未定时用空串，create 后必须重写 identity 再记 dispatch）。

`EVENT_TYPES` 新增：`session_created`、`session_steer`、`gate_goal`、`gate_routing`、`pr_opened`、`accepted`、`local_cleaned`、`session_archived`、`watch_registered`、`site_report`、`replan_note`。旧 `delivery` 仍是子 session candidate 交卷的唯一真写入口（`record-delivery`）。`gate_goal` / `gate_routing` 的 detail 必须含 `group_id` + 对应 sha256；缺 sha256 拒。`site_report` / `replan_note` / `watch_registered` 只经 `note-event` 入账，不进 set-state 成功流。`watch_registered` 只允许在 `pr-open` 入账，必须消费 Mini `register.mjs` 成功回执（`--detail.receipt`：ok、owner/repo/pr_number/branch 对上台账 GitHub URL、`session_id=null`、`state_file` 为 Mini 绝对路径）。不得本机 `existsSync` 读 Mini 路径，不得只核 pr 号。不得引用旧班车 id。run 级 `phase=ready` 是验收门过了的冻结；组级 `pr-open` / `local-cleaned` / `archived` 与 `watch_registered` 仍可在 ready 之后写入，但必须带对应脚本回执，禁止只填 URL / 只报事件名。

`PHASE_ORDER` 改成 run 级：`splitting | dispatching | running | accepting | ready`。组级状态机在 group 上。

`PR_RECEIPT_KEYS` exact：`pr_id, session_id, candidate_sha, pr_url, e2e_status, review_unresolved, size_result, ledger_version, checked_at`。candidate 交卷阶段还没有 `pr_url`。`pr_url` 在 accepted→pr-open 时才写入。缺 `gate_goal` / `gate_routing` 事件的组，ready-check 直接 GAP，不得 accepted。

ready-check 先每 PR、再 run：对每个 group 用该组 worktree 跑门；全部 group 至少 `accepted` → 写 run 级 `READY_FOR_LATER_SUBMIT_PR_SKILL`。这行是验收门过了的机器信号，意思是 lead 可以 jump 开远端 PR 并归档 PI session；不是「交给以后的提交 PR skill」，也不是 lead 可以 git merge。七门按 PR 各算一遍。L2 相对该 PR 的 `identity.base`。run 级 ready 额外一条：总表里的波次顺序已记录；真正合入不由本 skill 执行。

Lock+tmp+rename+CAS 与 `LedgerError` 码沿用。`budget_note` 事件可留，但 lead 不跨 session 加总账单。

## ⑩ 交卷 schema

开工闸收据（改代码前 / 派 worker 前，各一次 jump，不是终态交卷）：

```
gate_goal     {type:"gate_goal", goal_skill_path, goal_skill_sha256}
gate_routing  {type:"gate_routing", route_source, routing_sha256, e2e_model, review_model}
```

lead 对磁盘文件 `/Users/praise/.agents/skills/goal/SKILL.md`（realpath 后与 live `.../claude-active/goal/SKILL.md` 同一 inode 也算）算 sha256，与 `gate_goal` 逐字比对。不过 → `overreach_rejected`。`gate_goal.at` 之前该 worktree 相对 `identity.base` 已有非文档 diff → 越域，指令 revert。`gate_routing` 对 `/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json`；收据里的 `e2e_model` / `review_model` 必须等于该文件当前 primary（或 fallbacks 之一）。不过 → 不得 `create_worker`。

candidate `record-delivery --payload` exact（验收前，**不得含 pr_url**）：

```
branch          非空
tip_sha         40 hex
scs             [{id, status: pass|fail|not_run}] 且 id 集合 == 该 PR scs_inline
goal_skill_path 必须是 /Users/praise/.agents/skills/goal/SKILL.md
                 （或同一 inode 的 /Users/praise/.claude/skills/goal/SKILL.md
                  / /Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/goal/SKILL.md）
e2e             {status, candidate_sha, model, route_source}
review          {unresolved, candidate_sha, model, route_source}
size_gate       {result: 非空字符串, candidate_sha: 40hex}
```

`goal_skill_path` 缺或不是上表三路径之一 → 视为未调用 PI 自己的 goal skill，拒。台账里没有本组成立的 `gate_goal` + `gate_routing` → 视为未执行开工闸，拒，不得 `accepted`。含 `pr_url` → 拒。`route_source` 必须是 live routing.json 绝对路径、其 `~/.agents/skills/orca-fanout/routing.json` 软链、或字面量 `model-route show`。其它路径拒。缺键 / 多键 / sha 不是 40 hex / `scs` 对不齐 → 拒。

## ⑪ 预算告警如实声明

`config/defaults.json` 的 `budgetPauseUsd` **不再被 lead 当机器闸读取**。字段可留，避免无关键删除掀测试。lead 不跨 session 加总，没有测得到的 run 级 $30。

子 session 包文保留 goal `--until-sc` 原句：本 session 自报打到该阈值则暂停、jump 回报 lead。人独占名单里的「预算暂停」改指这条自报，不是 lead 算账。`--no-budget-pause` 仍可写进包文，关闭该子 session 的自报暂停。

## ⑫ `--dry-run`

`批准执行 --dry-run`：只写拆分表 + 各 PR 开工包 + 将要 create 的 `{title, working_dir, agent_kind, model, effort}`，**不**调 `send_to_session`。

`批准执行`（无 flag）：真派。触发词表仍是「直接执行不确认」，不强制用户第一次必须 dry-run；实现后上线先 dry-run 给用户过目。

## ⑬ 不停机条款（仅五类停）

仅第⑧节五类停。硬停六条（autonomous-execution）仍是人独占，禁止进 Fable、禁止豁免 800 行/输入门。size-gate `STOP` 只能再拆 PR，不能进 sidecar。假设破裂走第 5 类停 + 第⑱节 replan，不进 sidecar。

## ⑭ 与提交 PR 的边界

本 skill 做：拆 PR、派 session、内联执行、e2e worker、GPT 单审、验收后再开远端 ready PR、每 PR 的 size/format/intent 闸（真实 candidate）、写 `.pr-intent.md`、ssh Mini 注册盯梢名册、`watch_registered`、wrapup-cleanup、`archive_sessions`（只归档 PI session）。

本 skill 不合入，不跑三机同步。本 skill 不做：三审、改 submit-pr skill、resume 旧 Mini 盯梢班车、自动 `gh pr merge`。子 session 不得自行 merge。三审仍不在本 skill。

## ⑮ 保证等级声明

编排契约（席位、开工闸原文、交卷 schema、标题正则、Art 钉、routing 现读）由本仓测试冻结，等级 T1：防疏忽/漂移。不夸大成宿主强制拦截 `create_worker` 参数。Cindy 没有 per-worker tool allowlist。submit-pr 三审不是本 skill 的兜底句。

## ⑯ 防越域与验收

Lead 允许：读码、写开工包、派/收回 session、跑验收命令、改台账、验收后 jump 开远端 PR、ssh Mini 注册盯梢、wrapup-cleanup、`archive_sessions` 归档 PI session、按第⑱节 replan。不允许：改产品代码、替子 session 修 bug、在验收前替子 session 开 PR、git merge、resume 旧盯梢班车、Mini 名册未写就清本地。越域 commit 验收失败。`gate_goal` 过账后才允许 worktree 出现本 PR 的新 commit。该 PR diff 触碰了别组 site-report 里的 read 依赖文件 → 即使在自己 `allowed_paths` 内也标「需重协调」，下游不得开工直到 lead 重发包。

## ⑰ Fable 决策 sidecar（非第六席）

grok 作为 lead **本来会停下来主动问用户拍板**时，才把题交给 Fable 代决策。这不是 E/R/V/T/P 的第六席，**不进 `graph.json`，不加 `routing.json` 的 decision 档，不进 `config/defaults.json`，不做第五类 `record-delivery`**。配置独占 `config/fable-decision.json`（`claude-fable-5` / `low` / isolationLevel=`T1`）；机器闸是 `scripts/decision-broker.mjs` + 独立 journal（默认 `~/.claude/.orca/approve-exec-decisions/<run_id>.json`）。

用户说「发 worker fable5」时走本 sidecar，**禁止 `create_worker` 调 Fable**（禁止 `create_worker` role=任意、model=`claude-fable-5`）。

**唯一入场条件**：lead 必须能写出「若无代理，grok 将停下来问用户的原句」。查资料、执行、审查、策略优化、规则已有唯一答案、「要开始吗 / 能不能并行」、机械故障（缺文件/缺 receipt）一律不得开 sidecar。人独占（autonomous-execution 硬停六条、A 类 routing fail-closed、子 session 自报预算暂停、800 行/输入门豁免、密钥与组织配置）`human_exclusive=true`，停给用户，禁止进 Fable。

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
- **split-new**：超 800 行 → 现有 size-gate `STOP` 路径不变。

下游冻结：任一组因假设破裂 `blocked` → 依赖它的同波 / 后波组不得 `gate_goal` 放行。前波 tip 变化 → 后波未开工组必须换 base 重出包。已合入才发现偏航：不回滚 main，开修正 PR，`replan_note` 记因果。

**自进化**：每轮 run 收尾、摘要之前，把拆错 / 假设破裂 / 补救不对记进 `evolution/ledger.json`（唯一写通道 `scripts/evolution-note.mjs`）。三档 `by-design` / `proposal` / `auto`；扩权与拿不准永不自动落地。默认不 git push。登记进 Cindy「每周自进化 Skills」（`ledger-triage.mjs` `SOURCES`）。
