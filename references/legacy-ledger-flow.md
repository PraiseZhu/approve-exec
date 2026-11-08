# 批准执行旧流程（台账 + KEEL + 续跑脚本）

2026-11-07 起批准执行改用新流程（见 `SKILL.md`）：不走 KEEL、不建台账、不挂定时任务。本文件只给改版前已经开工的 run 收尾用：`~/.claude/.goal/<run>/ledger.json` 存在、续跑脚本 `scripts/issue-watch.py` 还在叫醒 lead 的那些 run，照下面的旧步骤做完，不在中途换成新流程。旧 run 全部 `complete` 后，删掉对应的续跑调度；旧脚本到那时再一起移除。

旧流程的 owner 协议见 `references/issue-owner-protocol.md`。下文里的 `scripts/…` 都相对 skill 根目录。

## 旧流程步骤（原 SKILL.md ⓪ 节，原样保留）

用法：`批准执行 owner/repo#号`。号可以是总 issue（标题以 `[总]` 开头、挂了子 issue）、独立 issue，或单个子 issue。可以带一句「授权：…」；没带时用入口消息原文作授权原话。

lead 的执行框架只能是 claude-code 或 codex：KEEL 只给这两种配了默认主控方案，Pi 当 KEEL 主控要先手动选方案、查资料步骤还会停在人工门，跑不了无人值守。owner 会话继承 lead 的执行框架与模型，各环节用什么模型由 KEEL 的主控方案决定；本 skill 不写任何模型、档位或派工路由。

1. **出计划。** `node scripts/issue-plan.mjs --issue <ref> --lead-agent <claude-code|codex> --repo-dir <owner/repo>=<目标仓主目录绝对路径>（每个涉及的仓一条） --entry "<用户原话>" [--authorization "<授权原话>"] --out ~/.claude/.goal/<slug>/plan.json`。exit 2 时把 stderr 原文告诉用户，指路「开 issue」补齐对应子 issue；不手改计划，不替用户补 issue。
2. **建台账。** `node scripts/issue-run.mjs init --plan <plan.json> --ledger <同目录>/ledger.json`。同一份计划重复 init 不新建。
3. **列可派。** `node scripts/issue-run.mjs next --ledger <ledger.json>`。只派 `dispatchable` 里的子 issue；`waiting` 里的要等依赖 issue 关闭（对应 PR 合入）后再派；依赖被关成「不做」时交给用户决定。
4. **派会话，每个子 issue 一次。**
   - `node scripts/issue-run.mjs prepare --ledger <f> --item <ref> --lead-session <当前会话 id> [--name "<人话任务名>"]`，拿到 `request`。会话标题是 `#<PR号>-<人话任务名>丨<MMDD>`（例 `#1789-动画跑道与守护丨1104`，用户 2026-11-04 定），不写项目名；还没有 PR 时先不带 `#<PR号>-`，owner 开出 PR 后自己补上。人话任务名默认从子 issue 标题提（去掉 `[子1/3]`、`[回归]` 这类标签和括号补充，取冒号前一段）；提不出不超过 14 个字的中文短名时 prepare 退出码 2，用 `--name` 给一个说清做什么的短名再跑。返回 `claimed:false` 表示本台账已派过，不再派。prepare 先读该子 issue 自己的评论（分页读完）：有当前 gh 账号发的、未释放的「批准执行认领 / 登记」就退出码 2，不管它来自哪份台账、哪台电脑、从总 issue 还是子 issue 入口；通过后脚本发「批准执行认领」并复查，两个 lead 同时认领时评论 id 小的胜出，后到的一方自动发释放让位并退出码 2。
   - 用 cindy_helper 的 `send_to_session` 新建会话，参数只传 `request` 里的五个键：`title`、`message`、`working_dir`、`project_path`、`use_worktree`。不传 agent_kind、model、effort、provider_id。`project_path` 是目标仓主目录，让会话进这个项目的分栏，不继承 lead 所在的项目：派发前先用 `list_projects` 查它是不是 Cindy 里看得见的项目，没有或 `hidden:true` 就先 `create_project` 登记或恢复。项目置顶由用户在侧栏项目菜单点「Pin project」，工具不能置顶。
   - 把工具回执原样存成文件，`node scripts/issue-run.mjs bind --ledger <f> --item <ref> --claim <claim_id> --result <回执文件>`。成功时脚本在子 issue 上发「批准执行登记」，总 issue 上抄一份；输出带 `comment_error` / `root_comment_error` 时，用 `gh issue comment` 把对应正文补发到输出写的位置。bind 和第 7 步的 cleanup 还会在总 issue 正文的「分支与工作树」一节登记或更新这个子 issue 的一行；输出带 `root_ledger_error` 时，把 `root_ledger_row` 手工补进那一节。回执不是明确成功时状态停在 `dispatch_unknown`：先核对会话列表，确认没有建出会话，才 `release --evidence "<依据>"` 放回（脚本发「批准执行释放」评论），不盲目重派。
5. **挂续跑脚本（每个 run 一条，第一次派发后马上做）。** 在台账同目录写 `issue-watch.json`：`{"schema":"issue-watch-v1","lead_session_id":"<当前会话 id>","ledger_paths":["<台账绝对路径>"],"stalled_after_sec":1800}`。先用 `schedule_list` 按总 issue 号查重，已有就复用；没有才 `schedule_create`：`executionMode:"script"`，`scriptConfig.command` 为 `python3 <本 skill>/scripts/issue-watch.py --config <issue-watch.json 绝对路径>`，`capabilities:["sessions.dispatch"]`，`cronExpr:"*/5 * * * *"`，`timezone:"Asia/Shanghai"`，`bindToCurrentSession:true`，`workingDir:<台账目录>`，`silentWhenIdle:true`。之后 lead 结束本轮；owner 不给 lead 发消息，脚本发现情况才叫醒 lead。
6. **被叫醒后按信号处理**（脚本消息里逐条写了是哪个子 issue、哪种信号）：
   - **待验收**：`node scripts/accept-check.mjs --ledger <f> --item <ref> --stage acceptance --out <同目录>/check-<号>.json`。有不过的项：`issue-run.mjs verdict --item <ref> --revise "<不过的项与要改的内容>"`。全部通过后，再对照子 issue 的「目标」「原因」「不做」看 diff 是否做对了事，拿不准问 KEEL 的 `jev`。判「要改」只为 SC 没达成、改动越出范围、做的事不对或 CI 不绿；交接文件、PR 正文之间的小出入写进裁决评论，照样判通过，交给审查机定（多一轮修改要再跑约 20–30 分钟 pre-push 和 CI）。判通过：`verdict --item <ref> --pass`（脚本自己再跑一遍 accept-check，不过就拒收）。把输出里的 `owner_message` 用 `send_to_session` 发给输出里的 `target_session_id`。裁决写成子 issue 评论；看板的「验收」「裁决」字段属于验收机，lead 不写。
   - 判「要改」不设轮数上限，会话一直修到通过。只有没有进展时脚本才把状态转成 `blocked_user` 并给出 `root_comment`：这次要改的条目原文和上一次相同，或 owner 回到验收点时的 head 和上一次判要改时一样（没有新提交）。把 `root_comment` 发到总 issue，告诉用户，不再发回 owner。用户定了以后 `issue-run.mjs unblock --item <ref> --note "<用户怎么定的>"`，再通知 owner。
   - **需要用户**：把台账里的原因汇总告诉用户；用户处理完后 `unblock`，再通知 owner 继续。
   - **需要 lead**（owner 写了 `needs_lead`：范围或验收标准必须改才能做完）：按原因定。能在范围内换做法就 `issue-run.mjs unblock --item <ref> --note "<结论>"`，把结论用 `send_to_session` 发给 owner 会话。确实要改范围或验收标准时先告诉用户；定下来以后按这个顺序做，一步都不能省：① 改子 issue 正文（范围或 SC，按任务 issue 范式在总 issue 记一行变更）；② 重新出计划，存成新文件：`node scripts/issue-plan.mjs …（参数同第 1 步） --out <同目录>/plan-v<n>.json`；③ `node scripts/issue-run.mjs add --ledger <f> --plan <新计划>`（子 issue 停在 `needs_lead` 时才能改它的范围和 SC）；④ 再 `unblock`，把结论发给 owner。只改 issue 不跑 ②③，台账里锁定的还是旧范围，验收时 accept-check 会报「超出子 issue 范围」（2026-11-07 复盘：#1464 因此绕了 6 步、多记一条假的「要改」）。所以范围要改时，在 `needs_lead` 这一步就改完；到验收点才发现要改，只能先判要改、等 owner 写回 `needs_lead`。owner 的其他选择由它自己问 `jev` 定，不回来找 lead。
   - **可派**：回到第 3 步。
   - **停滞**：查 owner 会话还在不在、卡在哪。还在就 `send_to_session` 催一次；已经不在（崩了、被删了）就 `issue-run.mjs release --item <ref> --evidence "<怎么核实的>"` 放回 `pending`，回到第 4 步重派。台账里记着 PR、或 GitHub 上有正文写着「任务 issue：<ref>」的开着的 PR 时，重派的开工包开头会写明接着那个 PR 做，不开新 PR（有多个这样的 PR 时 `prepare` 拒绝，先关掉多余的）。停在 `accepted` 的不 release：按消息做（重发通过消息；先跑 `accept-check --stage ready`，通过了才由 lead 写 `checkpoint --state ready`；不过（含 PR 关了没合）就告诉用户）。
   - **待收尾**：owner 写了 `ready`，做第 7 步。
   - **lead 未处理**：停在 `claimed`（prepare 后没 bind）、`awaiting_acceptance`（没裁决）或 `cleaned`（没归档）超过阈值，消息里写了该做哪一步，照做。
   - 要等某个 PR 的某项检查（如 Ready 后的 `review-pr`）出结论时，用 `node scripts/pr-watch/wait-check.mjs --repo <owner/name> --pr <号> --check <检查名> [--after <上一轮开始时间>]`，放后台跑，不手写轮询循环：退出码 0 成功、1 完成但不是成功、3 超时、2 参数或 gh 错误；head 中途变了会跟着新 head 查。
7. **Ready 后收尾。** owner 写了 `ready` checkpoint 后：`accept-check.mjs --stage ready` 复核（非 Draft、当前 head 必需 CI 全绿）→ `issue-run.mjs cleanup --item <ref>`（删本地 KEEL worktree 与本地分支，不删远端；PR 关了没合（已合并的照常清理）、PR 还是 Draft、PR head 不是验收通过的那个、当前 CI 不是全绿、有未提交改动、本地比 PR 新、分支在主目录检出时都拒绝）→ cindy_helper 的 `archive_sessions` 归档 owner 会话 → 把工具回执存成文件后 `issue-run.mjs archived --item <ref> --result <回执文件>`。Cindy 归档 owner 会话时连带归档它的 worker 会话。`cleanup` 不清的东西（有未提交改动的 KEEL worktree、会话树、worker 与子代理留下的分支和工作树），以及不在台账里的临时派发会话，lead 不手工删，交给 Pro、Mini 两台扫地僧每天清（用户 2026-11-04 定）：PR 已合并的会话归档，分支和工作树存证后全部清掉，未提交内容也清；PR 还开着、正在运行、置顶的不动；本台账没收尾的 owner 会话由 lead 归档，扫地僧不碰。所用脚本：`~/AI-Agent/Claude/capabilities/source/scripts/dispatched-sessions.mjs`（`scan` 列出该归档的派发会话，`branches --apply` 删没有本地独有提交的空分支）和 `capabilities/source/tools/worktree-patrol/scripts/merged-cleanup.mjs`（PR 已合并的分支和工作树）。
8. **总 issue 验收与交接。** 全部子 issue 收工后 `run_status` 是 `root_pending`，续跑脚本叫醒 lead（「待总验收」）。以单个子 issue 为入口、它首行写着总 issue 时没有这一步。
   - `node scripts/root-check.mjs --ledger <f> --preview --out <同目录>/root-check.json`：逐个子 PR 查非 Draft、当前 CI 全绿、还开着或已合并，personal 车道 head 没变（交接车道 head 变了只记下来）；再在每个涉及的仓从 `origin/<目标分支>` 开预览 worktree（`<仓>/.worktrees/approve-exec-preview-<run>`），按批次依次合入各子 PR。有冲突就报 PR 号和文件。
   - 在预览目录里按目标仓规则跑测试，对照总 issue「整体验收」逐条验：`static` / `unit` 层在预览目录里跑，`github-live` 等层写亲眼看到的情况；再核对所有 PR 合起来只碰总 issue 范围内的文件、没违反「不做」。
   - **不通过**：当场补。在总 issue 下按「开 issue」的模板补一个子 issue（挂上去、在总 issue 变更记录记一行），重新出计划存成新文件，`node scripts/issue-run.mjs add --ledger <f> --plan <新计划>`（只追加；已有子 issue 改了范围、SC 或依赖会被拒，`needs_lead` 的除外），回到第 3 步派会话。
   - **通过**：写 lead 结果文件 `{"conclusion":"…","sc":[{"id":"SC1","result":"通过|人工手测","evidence":"…","hint":"…"}],"focus":["请验收机重点查的地方"],"not_verified":[…],"post_launch":[…],"scope":[…]}`，`sc` 覆盖总 issue 的全部 SC。`node scripts/issue-run.mjs handoff --ledger <f> --result <结果文件>`：脚本自己再跑一遍 `root-check`，校验结果（缺 SC、有「未通过」、带本机绝对路径都拒），在总 issue 发首行为 `[批准执行] 交接验收 · 第 <n> 次` 的评论。验收机读它、等它之后才开轮，「请重点查」每条都会给结论。
   - 最后 `node scripts/root-check.mjs --ledger <f> --cleanup` 删预览 worktree。lead 不合并、不关总 issue：总 issue 由验收机验收后关闭。
9. **收工标准。** 子 issue 收工 = PR 非 Draft + 当前 head 必需 CI 全绿 + lead 判通过，并已清理、归档。`issue-run.mjs status` 的 `run_status`：`complete` 才算整个 run 收工（全部子 issue 收工，并已交接总 issue 验收），这时删掉第 5 步的续跑调度并告诉用户。`complete` 时本 run 派出的 owner 会话都已归档：`complete` 要求每个子 issue 都是 `archived` 或 `closed`，第 7 步逐个归档并凭回执记账；`root_pending` 表示该做第 8 步；`waiting_merge` 表示剩下的子 issue 在等依赖 PR 合入（合并由用户做），告诉用户先合哪个，续跑脚本发现合入后会叫醒 lead；`blocked_user` 表示在等用户。集成分支（`integration/*`）上的子 PR 也是 Ready 即收工，审查机兜底后由用户指派 agent 合入。

owner 一侧的协议（验收点、checkpoint 命令、裁决之后怎么做）写在开工包第 3 节，完整说明见 `references/issue-owner-protocol.md`。

`批准执行 --dry-run <ref>`：只做第 1 步，并用 `node scripts/render-issue-handoff.mjs --plan <plan.json> --item <ref> --lead-session <id>` 打印每个子 issue 的开工包，不建台账、不派会话。

边界：lead 不写产品代码、不代 owner 推进、不合并任何 PR（合并红线见下文）。由脚本起的 lead 会话（看板推进）走同一入口，出计划时传 `--source script`，授权原话随入口消息传入。
