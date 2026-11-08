---
name: approve-exec
description: 批准执行——接在「开 issue」之后：吃总 issue（或独立 issue / 单个子 issue），lead 按总 issue 的并行/串行原则，把依赖已合入的子 issue 一次全派出去，每个子 issue 开一个独立会话（1 子 issue = 1 PR = 1 会话），执行会话默认用 Claude 网关的 Opus 5.5 high；不走 KEEL、不建台账、不挂定时任务。执行会话自己推到 Draft PR CI 全绿后发消息叫醒 lead 验收，lead 判通过后执行会话转正式 PR 即收工；Mivo 仓 PR 交合并伙伴、合入后伙伴通知 lead（正文写了「合并顺序」的由伙伴自动合，lead 在转正式时把通知地址登记给伙伴；没写的等用户在 lead 会话说「合并」），用户说「合并」后其他仓 PR 由 lead 按 pr-merge 自己合；PR 合入后 lead 归档已完成的会话、派下一批。lead 不写产品代码；除用户在提示词里明确授权的加急 admin 合并和用户说「合并」的非 Mivo PR 外，lead 不合并。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — 批准执行

2026-11-07 改版（用户定）：不走 KEEL，不建台账，不挂定时任务。lead 派完就停，只在收到消息时醒来；执行会话自己推进到正式 PR，这是红线。谁叫醒谁：

| 消息第一行 | 谁发 | 发给谁 | 什么时候 |
|---|---|---|---|
| `批准执行开工：…` | lead | 新建的执行会话 | 派发时 |
| `批准执行待验收 …` | 执行会话 | lead | Draft PR 当前 head CI 全绿 |
| `批准执行通过 …` / `批准执行要改 …` | lead | 执行会话 | 验收后 |
| `批准执行已转正式 …` | 执行会话 | lead | 转正式后 CI 仍全绿 |
| `批准执行卡住 …` | 执行会话 | lead | 缺权限、缺环境，或范围、验收标准必须改 |
| `praise-merge 通知登记` | lead | 合并伙伴（Mini） | Mivo PR 转正式、`check-pr.mjs --stage ready` 通过后（第 4 步） |
| `praise-merge 已合并 …` | 合并伙伴（Mini） | lead | Mivo PR 合入后：自动合入的（lead 登记过地址）和用户说「合并」交出去的都有（其他仓 PR 由 lead 自己合，没有这条消息） |

`send_to_session` 发给已有会话时，对方关着会被唤醒，正在跑就排队，这一轮结束后送到。对方被归档、删除或 Agent 起不来时送不到：双方都看回执，送不到就在子 issue 上评论「批准执行未送达：…」，不互相干等（见「执行会话的规矩」和第 4 步）。

## ⓪ issue 入口

用法：`批准执行 owner/repo#号`。号可以是总 issue（标题以 `[总]` 开头、挂了子 issue）、独立 issue，或单个子 issue。入口消息原文就是授权原话；里面明确授权加急 admin 合并时，见「加急合并」。

派发范围只有入口这个 issue（总 issue 时是它挂的子 issue）。用户之后说「继续」「并行接下来的」这类不带号的话，范围仍是本会话入口里的 issue；别的 issue 即使也在 PraiseZhu 名下、也没人做，也不派（2026-11-07 复盘：越界派了 #1839）。brief 的 `--root` 填入口 issue，脚本会拒绝范围外的子 issue。

1 个子 issue 只对应 1 个 PR、1 个执行会话（用户 2026-11-07 重申）：`claim` 拦重复派发，开工消息写明不另开 PR，重派前先撤回并归档旧会话。

lead 会话要在完全访问权限下运行：派出的执行会话继承 lead 的权限档，lead 在需要人工确认的权限档时，执行会话会停在第一个授权确认框（`send_to_session` 不能单独设权限档）。不满足就先告诉用户，不派。

**开工先查网关**（在第 1 步之前，用户 2026-11-07 复盘定）：用 cindy_helper `list_tools` 读 `send_to_session` 的参数。没有 `agent_device_id` 时新会话只能继承 lead 所在的网关：用 cindy_orca `list_available_models` 看顶层 `agent_device_id`，不是 `config/defaults.json` 里 Claude 网关的 id，就马上告诉用户「请在 Claude 网关上开 lead 会话」（或把当前会话切过去），同时继续做第 1 步里不派发的准备（核对、改 issue、问 Jev），用户切好后直接派。

先备好 lead 的两个地址：`get_current_session_id` 的 `session_id` 是 lead 会话 id，写进开工消息；`list_machines` 里 isSelf 为 true 那台的 deviceId，加 `::` 再加会话 id，是给合并伙伴用的跨电脑地址。

1. **看现状。** 先读总 issue 的目标与背景、已定决策和并行/串行原则，核对每个子 issue「依赖」写的先后关系和总 issue 一致；不一致先改子 issue（按任务 issue 范式记一行变更），再派。然后 `node scripts/batch.mjs status --issue <ref>`。每个子 issue 只有七种状态：
   - `dispatchable`：依赖都已合入，可以开工。全部进第 2 步，一次派完，不排队。
   - `waiting`：在等 `waiting_on` 里的 issue 合进去。依赖被关成「不做」时问用户。
   - `needs_decision`：「待定问题」还有没写「已定」的。先问 Jev（`ghost_call`，`ghost_id=keel`、`tool=jev`，参数最少写 `{"question":"…","kind":"choice","options":["A","B"],"context":"…"}`；`kind` 必填，还可以是 `yesno`、`score`），把结论写回子 issue（该条加上「已定：…」），拿不准再问用户；定完重跑第 1 步。
   - `invalid`：没按模板写。lead 直接补齐格式（只补模板要求的段落和 SC 编号，不改目标、范围和验收内容），在该 issue 记一行（日期、谁补、补了什么），补完重跑 status 照常派；其他子 issue 照常派。
   - `in_progress`：有有效的派发记录（或旧台账的 run 在做）。不再派。
   - `needs_owner`：PR 开着，但没有有效的派发记录（会话失联后撤回过，或别处开的 PR）。先用 `list_sessions` 按标题里的 PR 号找实际负责的会话：找到就用 `batch.mjs claim` 补登记；确认没人做就走第 2 步派一个会话接手，brief 会让它接着原 PR 做，不开新 PR。
   - `done` 只在子 issue 已关闭、且没有写着「任务 issue」的开着的 PR 时出现；issue 关了但 PR 还开着会是 `needs_decision`，先核实是合了还是不做了，不放行依赖、不归档会话。
   - `done`：子 issue 已关闭。
   `all_done` 为真时到第 5 步。
   - 每次跑完 status，把输出里 `to_attach` 的每个 PR 用 cindy_helper `manage_session_prs` 挂到 lead 自己的会话顶上（用户 2026-11-07 定：lead 开出的 PR 都要挂在会话顶上）。参数：`{"action":"attach","pr":{"repo":"owner/repo","number":123}}`，不传 `session_id`；PR 要写成 `pr` 对象，不收 `pr_url`。重复 attach 没有副作用。
2. **派会话，每个 `dispatchable` 子 issue 一次。**
   - 项目：目标仓主目录对应的 Cindy 项目。先 `list_projects` 查，没有或 `hidden:true` 就 `create_project` 登记或恢复。项目置顶由用户在侧栏项目菜单点「Pin project」，工具不能置顶。
   - 网关（用户 2026-11-07 定）：执行会话默认用 Claude 网关的 `claude-opus-5-5`、effort high，一路做到正式 PR；备用依次 Personal、Personal 2 网关。路线和网关 id 写在 `config/defaults.json` 的 dispatchRoute 里。先用 cindy_helper `list_tools` 读 `send_to_session` 的参数：
     - 有 `agent_device_id`（makecindy/cindy#9195 上线后）：brief 加 `--gateway Claude`；派发失败（`AGENT_NOT_READY`、`PROVIDER_ROUTE_UNAVAILABLE`、撞用量上限）就按顺序换 `--gateway Personal`、`--gateway "Personal 2"` 重派，派发说明写明换网关的原因。三个都不行就停下告诉用户。
     - 没有：按开头「开工先查网关」的结果派。lead 在 Claude 网关就照常派（brief 不加 `--gateway`）；不在就等用户切到 Claude 网关再派，不在别的网关上派。
   - `node scripts/batch.mjs brief --item <子 issue> --root <入口 issue> --lead <lead 会话 id> --repo-dir <目标仓主目录> --project <项目路径> [--name "<人话任务名>"] [--urgent] [--gateway <网关名>]`，拿到 `request`。会话标题是 `#<PR号>-<人话任务名>丨<MMDD>`（还没有 PR 时不带 `#<PR号>-`，执行会话开出 PR 后自己补）。人话任务名从子 issue 标题提，提不出不超过 14 个字的中文短名时退出码 2，用 --name 给一个。已有开着的 PR 时，开工消息写明接着那个 PR 做。
   - 用 cindy_helper 的 `send_to_session` 新建会话，参数原样传 `request` 里的键：`title`、`message`、`working_dir`、`project_path`、`use_worktree`、`agent_kind`、`model`、`effort`（带了 `--gateway` 时还有 `agent_device_id`）。不自己改模型和推理强度，不传 provider_id。
   - 成功后 `node scripts/batch.mjs claim --item <子 issue> --session <返回的 target_session_id> --title <标题>`，在子 issue 上记「批准执行派发」，防止别的 lead 或别的电脑重复派。回执不明确时先用 `list_sessions` 查有没有建出会话，不盲目重派。
   - **派发失败的会话马上归档**（用户 2026-11-07 定）：`send_to_session` 报错但回执里有 `target_session_id`、`claim` 被拒、或新会话一开工就报错（用量上限、Agent 起不来），先 `archive_sessions` 归档那个会话；已经 claim 过的再 `batch.mjs release --reason "<原因>"`，然后按上面的网关顺序重派。
3. **停下。** 派完就结束本轮。不挂定时任务，不轮询。
4. **被消息叫醒后：**
   - **待验收**：先把这个 PR 挂上：`manage_session_prs`（`action: attach`）挂到 lead 自己的会话，再带 `session_id`=执行会话 id 挂到执行会话（执行会话漏挂时兜底；会话标题仍是 `#<PR号>-<人话任务名>丨<MMDD>`，没补前缀就提醒它补，不替它改名）。然后 `node scripts/check-pr.mjs --item <子 issue> --pr <号> --head <消息里的 sha>`。再核对 PR 正文里每条「已验证」都附了命令和退出码，缺了判要改；能在本机复跑的（仓库在本机、依赖已装），挑一条类型检查或测试命令在 PR head 的临时工作树里复跑，复跑不了就在裁决评论写「未复跑」（2026-11-07 复盘：cindy#9200 正文写 tsc 通过、实际 TS2339，CI 没覆盖）。有不过的项就判要改。全过后，再对照子 issue 的「目标」「原因」「不做」看 diff 是否做对了事；界面有变化却没附截图或 demo 判要改；拿不准问 Jev。判要改只为 SC 没达成、改动越出范围、做的事不对或 CI 不绿；PR 正文的小出入写进回复，照样判通过。用 `send_to_session` 回执行会话，第一行写 `批准执行通过 <子 issue> PR #<号>` 或 `批准执行要改 <子 issue> PR #<号>`，要改的条目从下一行起逐条写。裁决同时写成子 issue 评论。判要改不设轮数上限；同样的条目连续两次没有新提交时，告诉用户。
   - **已转正式**：`node scripts/check-pr.mjs --item <子 issue> --pr <号> --stage ready`。通过就是这个子 issue 收工。Mivo 仓 PR 通过后还要登记合入通知（用户 2026-11-08 定，PraiseZhu/approve-exec#97）：`node scripts/batch.mjs notify --pr <owner/repo#号> --lead-address <lead 的跨电脑地址>`，把输出的 `message` 原样用 `send_to_session` 发给 `target_session_id`（合并伙伴）。正文写了「合并顺序」的本人 PR 由伙伴自动合入，没有「合并」请求带 `notify_session`，不登记就收不到「praise-merge 已合并」。输出 `already_merged` 为真时 PR 已经合了，直接按下面「praise-merge 已合并」处理；退出码 2 或送不到伙伴时告诉用户，PR 合入后用户说「继续」即可。不过就回执行会话「批准执行要改 … （正式 PR）」并写明哪项没过：非 Mivo 仓它修完 CI 全绿后再发「已转正式」，lead 再跑 `--stage ready`（不回到验收档，验收档要求 Draft）；Mivo 仓转正式后的问题交盯梢。之后的审查意见和 CI 归盯梢。入口授权了加急合并的，走「加急合并」。
   - **发给执行会话的消息送不到**（回执 `ARCHIVED`、`DELETED`、`AGENT_NOT_READY` 等）：在子 issue 上评论「批准执行未送达：<原消息第一行>（<错误码>）」，并告诉用户；按「会话失联」处理。`DELIVERY_UNKNOWN` 先 `get_chat_history` 核对再决定是否重发（参数 `{"session_ids":["<会话 id>"],"roles":["user","assistant"],"limit":5}`；键是复数的 `session_ids`）。
   - **卡住**：能在范围内换做法，就把结论发回执行会话。范围或验收标准必须改，先告诉用户，按任务 issue 范式先改 issue 再改代码，改完把结论发回。缺权限、缺环境告诉用户。
   - **praise-merge 已合并**（只有 Mivo PR 有）、lead 按 `pr-merge` 自己合完非 Mivo PR 后，或用户说「继续」：先跑第 1 步的 status，对输出里 `to_archive` 的每一项用 cindy_helper `archive_sessions` 归档那个执行会话，成功后 `node scripts/batch.mjs archived --item <子 issue> --session <会话 id>` 记下来（用户 2026-11-07 定：PR 合入后由 lead 及时归档已完成的会话）；再派新放开的子 issue。
5. **收工。** `all_done` 为真：告诉用户全部合入。总 issue 由验收机自动验收、关闭，lead 不交接、不关总 issue。执行会话 PR 合并前不归档；PR 合并后由 lead 按 `to_archive` 归档（第 4 步），漏掉的由 Pro、Mini 两台扫地僧每天兜底归档，分支和工作树也由扫地僧存证清理，lead 不手工删分支。

**合并通知。** 只有 Mivo PR 有伙伴通知。正文写了「合并顺序」的本人 Mivo PR 不用用户说「合并」：审查机挂上 `review:merge-ready` 后由合并伙伴按正文顺序自动合（PraiseZhu/praise-merge#38），合入后伙伴按 lead 在第 4 步登记的地址发 `praise-merge 已合并 <owner/repo>#<号>`。

用户在 lead 会话里说「合并」时，按 `pr-merge` 分两路（用户 2026-11-08 定）：
- Mivo 仓（`xindong/mivo-canvas-plugin`）的 PR 交给合并伙伴，输入里带 `notify_session`（lead 的跨电脑地址）；伙伴合入后给 lead 发 `praise-merge 已合并 <owner/repo>#<号>`，lead 按第 4 步处理。只有 Mivo PR 有这条伙伴通知。
- 其他仓的 PR 不交伙伴，由 lead 按 `pr-merge` 的标准自己合（以 `pr-merge` 为准：required checks 全绿、CLEAN、当前 head 的 GPT 单审和 e2e 通过，缺一样就不合并、报缺项）。没有伙伴通知；lead 合进去后直接按第 4 步归档会话、派下一批。

用户用别的方式合并、或 Mivo PR 没登记就自动合入时没有通知，用户说「继续」即可。

**会话失联。** 没有定时检查。用户问进度（「进展」）或看到某个子 issue 很久没动时，先用 `list_sessions` / `get_chat_history` 查执行会话：还在就 `send_to_session` 催一次；已经没了（删除、崩溃）就 `node scripts/batch.mjs release --item <子 issue> --reason "<怎么核实的>"`，再回第 2 步重派。新会话的开工消息会写明接着已开的 PR 做。

边界：lead 不写产品代码，不替执行会话推进，不合并任何 PR（「加急合并」和用户说「合并」的非 Mivo PR 除外）。

## 执行会话的规矩

开工消息就是执行会话的全部指令，完整说明在 `references/owner-protocol.md`。红线：PR 不转正式不算完。Draft PR CI 全绿才叫 lead 验收，lead 判通过后执行会话自己转正式。不走 KEEL；不问用户，拿不准问 Jev；等 CI 时不结束本轮；不合并。

## 加急合并

只有入口消息（或之后用户的当次消息）明确授权对哪些 PR（或本次全部子 issue）做 admin 合并时才走这里。没写就不走，只报告可合并。

1. 执行会话发来「已转正式」、`check-pr.mjs --stage ready` 通过后，按 `orca-fanout` 的派工规则派两个 Orca Worker：review 档对当前 head 单审，e2e 档跑 e2e。
2. 单审没有确认成立的 P0/P1/P2、e2e 通过，才合并：`gh pr merge <号> --repo <owner/repo> --admin --match-head-commit <审过的 head> --squash`（仓库不允许 squash 时用它允许的方式）。有问题就发给执行会话修，修完重新单审和 e2e。
3. 合入后回到第 1 步派下一批。

## 合并红线（最高优先级）

除下面三种用户授权的情况外，任何 lead、owner、reviewer、tester、Mini session、watcher、worker 或本 skill 都不得合并、自动合并、启用 auto-merge、点击合并或调用 gh pr merge。只有用户本人对指定 PR 的明确、当次授权才允许合并：用户在提示词里明确授权加急 admin 合并的 PR，由 lead 按「加急合并」执行；用户说「合并」的 PR：Mivo 仓由合并伙伴按其标准合并；其他仓由收到这句话的会话按 `pr-merge` 的标准自己合并。第三种是用户的长期授权（2026-11-08，PraiseZhu/praise-merge#38）：Mivo 仓 PraiseZhu 和 praise-qa[bot] 的 PR 满足合并伙伴的自动接单条件（审查机挂上 `review:merge-ready`；本人 PR 正文还要有有效的「合并顺序：」一行）时，由合并伙伴自动合并。lead 和执行会话不替 PR 挂这个标签；「合并顺序」按真实依赖写，不为了早合删依赖。PR Ready、required checks 通过、管理员权限或开工消息里的提交/推送授权，都不构成合并授权。

## 旧 run

2026-11-07 之前用台账开工的 run（`~/.claude/.goal/<run>/ledger.json`，续跑脚本 `scripts/issue-watch.py` 还在叫醒 lead）照旧按 `references/legacy-ledger-flow.md` 收尾，旧脚本保留到这些 run 全部收工。`batch.mjs` 认得旧台账的认领和登记评论，不会把在做的子 issue 再派一次。

## 保证等级

T1：skill 纪律加脚本校验，不是宿主强制隔离。`batch.mjs` 只读 GitHub 算状态，派发防重靠子 issue 评论（只认当前 gh 账号，两个 lead 同一时刻派同一个子 issue 时拦不住）；`check-pr.mjs` 只读检查 PR head、Draft、必需 CI、改动范围、PR 正文与待定问题。没有定时检查，执行会话崩了不会被自动发现，靠「进展」和用户兜底。本机接线用 `node scripts/selfcheck.mjs --live` 检查，本文结构由 `tests/skill-doc.test.mjs` 断言，测试集由 `scripts/run-tests.mjs` 冻结枚举。

## 自进化

每个 run 收尾、给用户总结之前，把拆错、依赖写错、验收标准写不清、补救不对这类问题记进 `evolution/ledger.json`（唯一写通道 `scripts/evolution-note.mjs`）。三档 `by-design` / `proposal` / `auto`；扩权与拿不准永不自动落地。默认不 git push。登记进 Cindy「每周自进化 Skills」（`ledger-triage.mjs` `SOURCES`）。
