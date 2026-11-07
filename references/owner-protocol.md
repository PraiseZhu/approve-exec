# 批准执行：执行会话的做法（2026-11-07 起）

执行会话由 lead 用 `send_to_session` 新建，一个子 issue 一个会话、一个 PR。开工消息是精简版，本文件是完整版，两者冲突时以开工消息为准。lead 生成开工消息的脚本是 `scripts/batch.mjs brief`。

## 红线

PR 必须推到正式（Ready for review）才算做完。还是 Draft、CI 还红，都不算做完；只能停在「卡住」并发消息说明原因。

## 不做的事

- 不走 KEEL，直接用 git + gh。
- 不问用户。拿不准的选择问 Jev（`ghost_call`，`ghost_id=keel`，`tool=jev`），结论写回子 issue。
- 不合并 PR，不 force push 主分支，不开 auto-merge。
- 不改子 issue 的范围和验收标准。必须改才能做完时发「卡住」。
- 不给 lead 报进度。只在下面三种时候发消息。

## 步骤

1. **读。** 开工消息写了总 issue 时，先读总 issue 的目标与背景、已定决策、并行/串行原则和相邻子 issue，弄清这个子 issue 在整体里要达成的产品意图；和子 issue 说法冲突时按子 issue 做，并发「卡住」说明。再读子 issue 全文（目标、原因、范围、不做、参考、依赖、待定问题、验收标准），「参考」里点名的文件，目标仓的 `AGENTS.md` / `CLAUDE.md` 和 PR 模板，以及它们指向的 PR 门禁规则（如 `docs/dev-rules/` 下的文件），PR 正文逐项满足这些门禁。只改「范围」里的文件。
2. **用 Cindy 的托管分支，不另开分支。** 会话的工作树和托管分支（`cindy/<名>`）已由 Cindy 建好；Cindy 只认这个分支，换到别的分支会让工作树回收不了。没有提交前先对齐目标分支：`git fetch origin` 后 `git reset --hard origin/<目标分支>`（子 issue 首行写了「PR 指向 <分支>」就用它，否则 `main`）。开工消息写了「接手 PR #n」时改成对齐那个 PR 的分支（`git reset --hard origin/<PR 分支>`），不开新 PR。推送一律 `git push origin HEAD:<PR 分支名>`（新 PR 的分支名自己起，按目标仓约定）。
3. **尽早开 Draft PR。** 按任务 issue 范式：
   - `bash ~/AI-Agent/Claude/capabilities/source/scripts/check-pr-issue.sh <子 issue>`
   - `bash ~/AI-Agent/Claude/capabilities/source/scripts/make-pr-body.sh <子 issue>` 生成正文骨架（目标仓有自己的 PR 模板时加 `--repo-template <模板文件>`），补上实际内容
   - `bash ~/AI-Agent/Claude/capabilities/source/scripts/check-pr-body.sh --stage open <正文文件> <子 issue>`
   - `gh pr create --draft`。正文第一行写 `任务 issue：<子 issue>`。
   - 开出后马上用 cindy_helper 的 `manage_session_prs`（`action: attach`，`pr: {repo, number}`，不传 `session_id`）把 PR 挂到本会话顶上，侧栏和会话顶部会显示 PR 号（用户 2026-11-07 定）。
   - 再用 `set_current_session_title` 在标题前补 `#<PR号>-`，改成 `#<PR号>-<人话任务名>丨<MMDD>`。命名方式不变，只加这个前缀。
   PR 本身就是进度存档：会话断了，接手的会话从这个 PR 接着做。
4. **写代码、测试、提交。** 按目标仓规则跑测试。PR 正文里每条「已验证」都写实际跑的命令和退出码（例：`pnpm --filter <包> exec tsc --noEmit -p . → exit 0`），只写「通过」不算；没跑过的写进「未执行的验证」，不写成已验证。分批提交、推送，不攒到最后。上下文快满时先提交推送。界面有变化（界面、画布观感、提示和文案、面板与设置页），PR「效果展示」必须附改后的截图、录屏或自包含 HTML demo；没有可见变化才写「不涉及」并说明为什么。PR 正文「验收对照」要覆盖子 issue 的每一条 SC。目标仓规定每个 PR 必须附的交接文件（如 Mivo 的 `docs/pr/<PR号>/review.md`、`qa.md`）按仓库要求写，不算越出子 issue 范围。
5. **等 CI，不结束本轮。** 反复运行 `timeout 540 gh pr checks <PR号> --watch --fail-fast`，直到全部检查跑完。「CI 全绿」指当前 head 的全部检查跑完且通过（skipping 算通过），不只是必需检查；lead 验收用同一口径。单条命令最多约 9 分钟，没跑完就再跑一次。红了就修、推送，再等。
6. **叫 lead 验收。** CI 全绿后，先把 PR 正文「验收对照」每条 SC 的状态和证据填好（人工手测项在「未执行的验证」写清谁验、何时验），跑 `check-pr-body.sh --stage ready <owner/repo#PR号> <子 issue>` 通过，再发「待验收」，然后结束本轮。lead 验收会跑同一个检查。
7. **lead 回复后：**
   - `批准执行要改 …`：逐条改完，回到第 5 步。
   - `批准执行通过 …`：跑 `check-pr-body.sh --stage ready <owner/repo#PR号> <子 issue>`，通过后 `gh pr ready <PR号>`，再确认当前 head CI 仍全绿，然后发「已转正式」。到这里任务完成。
8. **转正式之后。** 审查意见和后续 CI 问题归盯梢处理（Mivo 仓按其生命周期门禁），执行会话不再改代码、不再推送。例外：lead 对「已转正式」的复核没过、回了「要改」——非 Mivo 仓按回复修，CI 全绿后再发「已转正式」（不要再发「待验收」，验收档要求 Draft，正式 PR 过不了）；Mivo 仓转正式后的问题归盯梢，回复 lead「已交盯梢」即可。

## 给 lead 发消息

用 cindy_helper 的 `send_to_session`，`target_session_id` 填开工消息里的 lead 会话 id。消息第一行固定：

| 时机 | 第一行 |
|---|---|
| Draft PR 当前 head CI 全绿 | `批准执行待验收 <子 issue> PR #<号> head <40 位 sha>` |
| lead 判通过后已转正式、CI 仍全绿 | `批准执行已转正式 <子 issue> PR #<号>` |
| 缺权限、缺环境，或范围、验收标准必须改 | `批准执行卡住 <子 issue>`，下一行起写原因和需要谁做什么 |

发完看回执，确认送到再结束本轮：

- `ok: true`（`wake_kind` 是 `queued` 也算）：送到了。lead 正在忙时会排队，这一轮结束后送到，不用重发。
- `DELIVERY_UNKNOWN`：先用 cindy_helper `get_chat_history` 查 lead 会话有没有收到，没收到再发一次。
- `ARCHIVED`、`DELETED`、`NOT_FOUND`、`AGENT_NOT_READY`、`HOST_NOT_READY` 等送不到的：用 `gh issue comment` 在子 issue 上评论「批准执行未送达：<原消息第一行>（<错误码>）」，再结束本轮。用户看「进展」或子 issue 时能看到，不会两边互相干等。
