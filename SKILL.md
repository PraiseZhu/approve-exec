---
name: approve-exec
description: 批准执行——接在「开 issue」之后：吃总 issue（或独立 issue / 单个子 issue），lead 按总 issue 的并行/串行原则给每个子 issue 开一个独立会话（1 子 issue = 1 PR = 1 会话），派会话不带模型参数；owner 会话用 KEEL 的 keel_run 推进到验收点，零 token 续跑脚本叫醒 lead 验收（通过 / 要改，不设轮数上限、没有进展才找用户），通过后转 Ready、清本地、归档会话，依赖合入后开下一批；lead 不写产品代码、不合并。触发词：批准执行。
trigger: 批准执行
---

# approve-exec — 批准执行

## ⓪ issue 入口

用法：`批准执行 owner/repo#号`。号可以是总 issue（标题以 `[总]` 开头、挂了子 issue）、独立 issue，或单个子 issue。可以带一句「授权：…」；没带时用入口消息原文作授权原话。

lead 的执行框架只能是 claude-code 或 codex：KEEL 只给这两种配了默认主控方案，Pi 当 KEEL 主控要先手动选方案、查资料步骤还会停在人工门，跑不了无人值守。owner 会话继承 lead 的执行框架与模型，各环节用什么模型由 KEEL 的主控方案决定；本 skill 不写任何模型、档位或派工路由。

1. **出计划。** `node scripts/issue-plan.mjs --issue <ref> --lead-agent <claude-code|codex> --repo-dir <owner/repo>=<目标仓主目录绝对路径>（每个涉及的仓一条） --entry "<用户原话>" [--authorization "<授权原话>"] --out ~/.claude/.goal/<slug>/plan.json`。exit 2 时把 stderr 原文告诉用户，指路「开 issue」补齐对应子 issue；不手改计划，不替用户补 issue。
2. **建台账。** `node scripts/issue-run.mjs init --plan <plan.json> --ledger <同目录>/ledger.json`。同一份计划重复 init 不新建。
3. **列可派。** `node scripts/issue-run.mjs next --ledger <ledger.json>`。只派 `dispatchable` 里的子 issue；`waiting` 里的要等依赖 issue 关闭（对应 PR 合入）后再派；依赖被关成「不做」时交给用户决定。
4. **派会话，每个子 issue 一次。**
   - `node scripts/issue-run.mjs prepare --ledger <f> --item <ref> --lead-session <当前会话 id>`，拿到 `request`。返回 `claimed:false` 表示本台账已派过，不再派。prepare 先读该子 issue 自己的评论（分页读完）：有当前 gh 账号发的、未释放的「批准执行认领 / 登记」就退出码 2，不管它来自哪份台账、哪台电脑、从总 issue 还是子 issue 入口；通过后脚本发「批准执行认领」并复查，两个 lead 同时认领时评论 id 小的胜出，后到的一方自动发释放让位并退出码 2。
   - 用 cindy_helper 的 `send_to_session` 新建会话，参数只传 `request` 里的四个键：`title`、`message`、`working_dir`、`use_worktree`。不传 agent_kind、model、effort、provider_id。
   - 把工具回执原样存成文件，`node scripts/issue-run.mjs bind --ledger <f> --item <ref> --claim <claim_id> --result <回执文件>`。成功时脚本在子 issue 上发「批准执行登记」，总 issue 上抄一份；输出带 `comment_error` / `root_comment_error` 时，用 `gh issue comment` 把对应正文补发到输出写的位置。回执不是明确成功时状态停在 `dispatch_unknown`：先核对会话列表，确认没有建出会话，才 `release --evidence "<依据>"` 放回（脚本发「批准执行释放」评论），不盲目重派。
5. **挂续跑脚本（每个 run 一条，第一次派发后马上做）。** 在台账同目录写 `issue-watch.json`：`{"schema":"issue-watch-v1","lead_session_id":"<当前会话 id>","ledger_paths":["<台账绝对路径>"],"stalled_after_sec":1800}`。先用 `schedule_list` 按总 issue 号查重，已有就复用；没有才 `schedule_create`：`executionMode:"script"`，`scriptConfig.command` 为 `python3 <本 skill>/scripts/issue-watch.py --config <issue-watch.json 绝对路径>`，`capabilities:["sessions.dispatch"]`，`cronExpr:"*/5 * * * *"`，`timezone:"Asia/Shanghai"`，`bindToCurrentSession:true`，`workingDir:<台账目录>`，`silentWhenIdle:true`。之后 lead 结束本轮；owner 不给 lead 发消息，脚本发现情况才叫醒 lead。
6. **被叫醒后按信号处理**（脚本消息里逐条写了是哪个子 issue、哪种信号）：
   - **待验收**：`node scripts/accept-check.mjs --ledger <f> --item <ref> --stage acceptance --out <同目录>/check-<号>.json`。有不过的项：`issue-run.mjs verdict --item <ref> --revise "<不过的项与要改的内容>"`。全部通过后，再对照子 issue 的「目标」「原因」「不做」看 diff 是否做对了事，拿不准问 KEEL 的 `jev`；判通过：`verdict --item <ref> --pass`（脚本自己再跑一遍 accept-check，不过就拒收）。把输出里的 `owner_message` 用 `send_to_session` 发给输出里的 `target_session_id`。裁决写成子 issue 评论；看板的「验收」「裁决」字段属于验收机，lead 不写。
   - 判「要改」不设轮数上限，会话一直修到通过。只有没有进展时脚本才把状态转成 `blocked_user` 并给出 `root_comment`：这次要改的条目原文和上一次相同，或 owner 回到验收点时的 head 和上一次判要改时一样（没有新提交）。把 `root_comment` 发到总 issue，告诉用户，不再发回 owner。用户定了以后 `issue-run.mjs unblock --item <ref> --note "<用户怎么定的>"`，再通知 owner。
   - **需要用户**：把台账里的原因汇总告诉用户；用户处理完后 `unblock`，再通知 owner 继续。
   - **需要 lead**（owner 写了 `needs_lead`：范围或验收标准必须改才能做完）：按原因定。能在范围内换做法就 `issue-run.mjs unblock --item <ref> --note "<结论>"`，把结论用 `send_to_session` 发给 owner 会话。确实要改范围或验收标准时告诉用户：台账锁定了计划，改范围要重新出计划。owner 的其他选择由它自己问 `jev` 定，不回来找 lead。
   - **可派**：回到第 3 步。
   - **停滞**：查 owner 会话还在不在、卡在哪。还在就 `send_to_session` 催一次；已经不在（崩了、被删了）就 `issue-run.mjs release --item <ref> --evidence "<怎么核实的>"` 放回 `pending`，回到第 4 步重派。台账里记着 PR、或 GitHub 上有正文写着「任务 issue：<ref>」的开着的 PR 时，重派的开工包开头会写明接着那个 PR 做，不开新 PR（有多个这样的 PR 时 `prepare` 拒绝，先关掉多余的）。停在 `accepted` 的不 release：按消息做（重发通过消息；先跑 `accept-check --stage ready`，通过了才由 lead 写 `checkpoint --state ready`；不过（含 PR 关了没合）就告诉用户）。
   - **待收尾**：owner 写了 `ready`，做第 7 步。
   - **lead 未处理**：停在 `claimed`（prepare 后没 bind）、`awaiting_acceptance`（没裁决）或 `cleaned`（没归档）超过阈值，消息里写了该做哪一步，照做。
7. **Ready 后收尾。** owner 写了 `ready` checkpoint 后：`accept-check.mjs --stage ready` 复核（非 Draft、当前 head 必需 CI 全绿）→ `issue-run.mjs cleanup --item <ref>`（删本地 KEEL worktree 与本地分支，不删远端；PR 关了没合（已合并的照常清理）、PR 还是 Draft、PR head 不是验收通过的那个、当前 CI 不是全绿、有未提交改动、本地比 PR 新、分支在主目录检出时都拒绝）→ cindy_helper 的 `archive_sessions` 归档 owner 会话 → 把工具回执存成文件后 `issue-run.mjs archived --item <ref> --result <回执文件>`。
8. **收工标准。** 子 issue 收工 = PR 非 Draft + 当前 head 必需 CI 全绿 + lead 判通过，并已清理、归档。`issue-run.mjs status` 的 `run_status`：`complete` 才算整个 run 收工，这时删掉第 5 步的续跑调度并告诉用户；`waiting_merge` 表示剩下的子 issue 在等依赖 PR 合入（合并由用户做），告诉用户先合哪个，续跑脚本发现合入后会叫醒 lead；`blocked_user` 表示在等用户。集成分支（`integration/*`）上的子 PR 也是 Ready 即收工，审查机兜底后由用户指派 agent 合入。

owner 一侧的协议（验收点、checkpoint 命令、裁决之后怎么做）写在开工包第 3 节，完整说明见 `references/issue-owner-protocol.md`。

`批准执行 --dry-run <ref>`：只做第 1 步，并用 `node scripts/render-issue-handoff.mjs --plan <plan.json> --item <ref> --lead-session <id>` 打印每个子 issue 的开工包，不建台账、不派会话。

边界：lead 不写产品代码、不代 owner 推进、不合并任何 PR（合并红线见下文）。由脚本起的 lead 会话（看板推进）走同一入口，出计划时传 `--source script`，授权原话随入口消息传入。

## 合并红线（最高优先级）

任何 lead、owner、reviewer、tester、Mini session、watcher、worker 或本 skill 都不得合并、自动合并、启用 auto-merge、点击合并或调用 gh pr merge。只有用户本人对指定 PR 的明确、当次授权才允许合并；PR Ready、cloud_ready、required checks 通过、管理员权限或开工包中的提交/推送授权，均不构成合并授权。后续由用户手动合并插件承接该动作；插件上线前只能报告“可合并”，不得代替用户合并。

## 保证等级

保证等级是 T1：skill 纪律加脚本校验，不是宿主强制隔离。脚本校验包括：`issue-plan.mjs` 缺模板或依赖写不清就 fail-closed；`issue-run.mjs` 用子 issue 评论认领防止重复派会话，checkpoint 要覆盖子 issue 全部 SC 并带 KEEL run_id，`verdict --pass` 自己再跑一遍 accept-check，`cleanup` 只在 PR 非 Draft、head 是验收通过的那个、当前 CI 全绿时清理；`accept-check.mjs` 只读检查 PR head、必需 CI、改动范围、PR 正文与待定问题。Cindy 没有按会话限制工具的白名单，owner 会话可以直接改台账文件：这些校验防疏忽和漂移，不防有意绕过。本机接线（goal skill、`skills/claude-active/approve-exec` 链接、触发表「批准执行」行）用 `node scripts/selfcheck.mjs --live` 检查。本文结构由 `tests/skill-doc.test.mjs` 断言，测试集由 `scripts/run-tests.mjs` 冻结枚举。

## 自进化

每个 run 收尾、给用户总结之前，把拆错、依赖写错、验收标准写不清、补救不对这类问题记进 `evolution/ledger.json`（唯一写通道 `scripts/evolution-note.mjs`）。三档 `by-design` / `proposal` / `auto`；扩权与拿不准永不自动落地。默认不 git push。登记进 Cindy「每周自进化 Skills」（`ledger-triage.mjs` `SOURCES`）。
