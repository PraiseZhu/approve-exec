# approve-exec 自进化台账

自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。
条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md 第⑱节。

## 待维护者拍板(扩权类提案,永不自动落地)

- `post-ready-fix-breaks-child-sc` **转正式后盯梢的修复可能破坏子 issue 验收项，lead 没有合并前复核** — 出现 1 次,首见 2026-11-12,最近 2026-11-12,status: open
  - 现象:2026-11-12 PR #2204（#2094）：转正式后 Mini 盯梢为修 Greptile P2 改了存量测试 aliasWrap.contract.test.ts 一行，违反 #2094 SC10（存量测试只增不改）。lead 是因为用户问「完成了么」才去查到，留 P2 行内评论后盯梢撤回。若没发现，合并后验收机会判 SC10 不通过、开修正 issue。
  - 提案:合并伙伴合入前（或 lead 收到 praise-merge 已合并前）对 head 相对验收时有变化的子 PR 跑一次 check-pr.mjs 的 SC 静态项（至少测试 numstat 删除列）；或在子 issue 的 SC 里写明盯梢修复轮也受约束，让盯梢修复轮自查。需要改 praise-merge 或盯梢，批准执行这边只记录。
- `child-scope-misses-necessary-files` **子 issue 范围清单反复漏列必要文件，每个 PR 验收都要 lead 补范围** — 出现 1 次,首见 2026-11-12,最近 2026-11-12,status: open
  - 现象:2026-11-12 xindong/mivo-canvas-plugin#2089：#2100 漏 3 个（pendingWriteDrain.ts、useCanvasInteractionController.ts、首屏体积基线），#2092 漏 2 个（新文件 canvasBoundsEdits.ts 因 nodeMutationSlice.ts 到 1200 行结构守卫上限、首屏体积基线），#2094 漏 4 个（canvasStore.ts 注入读取器、图片格用户入口 3 个文件）。每次都是 check-pr.mjs 判范围不过、lead 核实后改 issue 再判通过。
  - 提案:开 issue 时对每个子 issue 预查：会加首屏 JS 的改动预列 scripts/ci/first-screen-size.baseline.json；要改的文件离结构守卫行数上限不足 50 行时预留新文件；新增能力被别的模块调用时列出调用方。属于 open-issue 拆分质量，批准执行这边只记录。
- `integration-pr-no-auto-intake` **集成分支 PR 转正式后只登记通知，没交合并请求，PR 一直不合** — 出现 1 次,首见 2026-11-12,最近 2026-11-12,status: open
  - 现象:2026-11-12 xindong/mivo-canvas-plugin#2089：PR #2141、#2184 指向 integration/canvas-bounds-s1，审查机 11-11 15:38Z / 16:55Z 已挂 review:merge-ready、CLEAN，但 10 小时没合。原因：第 4 步「已转正式」只要求发 praise-merge 通知登记，依赖伙伴按「合并顺序」自动接单；伙伴 auto_intake 的 base 只认 main（PraiseMerge docs/operations.md「bot PR 自动接单」、config/policy.example.json），集成分支 PR 不会被自动接单。#2142 当时是 lead 另交了合并请求才合入。
  - 提案:第 4 步「已转正式」按 PR base 分路：base 是 main 照旧只登记通知；base 是 integration/* 时，入口或用户已授权合并（如「所有 PR 都用合并 skill」）就走 pr-merge 交合并请求（带 notify_session），没有授权就告诉用户要说「合并」。batch.mjs notify 读到 base 不是 main 时输出提示。
- `merged-after-handoff-head-mismatch` **交接后盯梢推新提交再合并，台账 cleanup/archived 因 head 不一致拒绝** — 出现 4 次,首见 2026-11-01,最近 2026-11-04,status: open
  - 现象:2026-11-05 #1331/PR #1705：验收 head cdb57530f，Ready 后 Mini 盯梢按 review-pr P2 推 5 个提交到 03080a167（2 个代码修复、3 个交接文档），review-pr success 后闸门合并为 77c94dc50；cleanup 因 head 不一致拒绝
  - 提案:cleanup / archived 对已合并 PR，接受「验收 head 是合并 head 的祖先」，不再要求两者相等；续跑脚本对已合并且 issue 已关的 ready 项不再反复唤醒。
- `post-accept-head-drift` **验收后只改文档的新提交没法在台账里重新验收** — 出现 1 次,首见 2026-11-04,最近 2026-11-04,status: open
  - 现象:#1687：#1688 验收（6f57d559）后，作者按 lead 要求补了效果展示（只改 docs/pr/1730/），之后已经转 Ready。ready checkpoint 因 head 不同被拒；verdict --pass 要求 acceptance 阶段 PR 必须是 Draft，Ready 后无法重新判通过；unblock 又回到 accepted。#1671 同样因盯梢在 Ready 后推了提交、合入 head 和验收 head 不一致，cleanup 一直拒绝。台账只能卡在 awaiting_acceptance / ready，收尾要手工处理。
  - 提案:lead 加一个 reaccept 命令：核对新增提交只碰范围内文件后，允许把 accepted/ready 的 head 更新为当前 PR head，并留存 compare 证据；cleanup 可以接受「已合并且合入 head 的祖先包含验收 head」的情况。
- `root-check-rejects-watcher-fixes-after-ready` **Mivo PR 转 Ready 后由 Mini 盯梢修审查意见是仓库规定流程，但 root-check 把 lane=null 当 personal 车道，盯梢推的新提交被判「没验收过」，总验收 handoff 无法交接（mivo#1664/#1675，2026-11-04）** — 出现 1 次,首见 2026-11-04,最近 2026-11-04,status: open
- `ui-evidence-not-checked-at-acceptance` **lead 验收与 accept-check 不查 PR「效果展示」：改了界面却没有截图或 HTML 模拟界面也能过** — 出现 2 次,首见 2026-11-04,最近 2026-11-04,status: open
  - 现象:2026-11-04 用户指出 #1705 改画布观感却写「暂无截图」，#1478 新增提示却写「不涉及」，违反 Mivo CONTRIBUTING.md 第 14 行；维护者账号作者被前置审查豁免界面证据，所以没有自动拦住
  - 提案:accept-check --stage acceptance 检查：diff 命中 .tsx/.css/i18n locales/render 时，PR「效果展示」必须含图片、html 代码块、.html 文件或预览链接，否则 REJECT；开工包写明这条
- `repo-mandated-handoff-scope` **开工包 scope 漏了目标仓强制的 PR 交接目录** — 出现 1 次,首见 2026-11-04,最近 2026-11-04,status: open
  - 现象:mivo-canvas-plugin AGENTS.md 要求每个 PR 附 docs/pr/<PR号>/review.md、qa.md（必需检查 pr-handoff-gate），但 issue-plan 只从子 issue「范围」取 scope；#1687 的 13 个子 issue 都没写，#1671 到 PR 阶段被 KEEL 判 SCOPE_VIOLATION 停成 needs_lead。add 只允许改 needs_lead 项，其余子 issue 只能逐个等它们卡住再补。
  - 提案:issue-plan 按目标仓规则自动给 scope 追加 docs/pr/<PR号>/**（或 accept-check / KEEL 对仓库强制交接目录豁免）；open-issue 模板在 Mivo 仓的范围节默认带这一行。
- `owner-brief-virtual-paths` **开工包里的绝对路径是 lead 会话的虚拟路径，owner 会话解析不到台账** — 出现 1 次,首见 2026-11-03,最近 2026-11-03,status: open
  - 现象:2026-11-03 PraiseZhu/Review-PR#167：lead 在 remote-agent 工作区里运行，路径显示成 /home/box/.config/CindyGlobal/remote-agent/.../p/p/... 形式；台账因此建在 ~/AI-Agent/Claude/projects/Project Mivo Canvas-Plugin/.claude/.goal/ 而不是 ~/.claude/.goal/。owner 会话（同一台 Pro）把开工包里的路径解析成 ~/.claude/.goal/...，checkpoint 写不进去，停了 31 分钟才被续跑脚本发现。
  - 提案:出计划/建台账时把台账路径规范到 ~/.claude/.goal/<slug>（用 $HOME 展开后的真实路径），render-issue-handoff 输出用 ~ 开头的路径；issue-plan 校验台账目录不在目标仓或其它项目仓内
- `watch-schedule-silent-rejected` **第 5 步续跑调度的 silentWhenIdle 被宿主拒绝** — 出现 1 次,首见 2026-11-03,最近 2026-11-03,status: open
  - 现象:2026-11-03 PraiseZhu/Review-PR#166：schedule_create executionMode=script 带 silentWhenIdle:true 返回 INVALID_PARAMS「script execution does not support silentWhenIdle」；去掉后创建成功，首轮 run success。另 schedule_create 要求必填 agentKind/kind/useWorktree/notify，SKILL.md 第 5 步没写。
  - 提案:SKILL.md 第 5 步删去 silentWhenIdle:true，补上 agentKind、kind:cron、useWorktree:false、notify 必填字段
- `scope-placeholder-not-rejected` **issue 范围写了模板占位符 docs/pr/<PR号>/，issue-plan 原样收进计划，验收时把真实交接文件判越界** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 mivo #1604/#1605：lead 建 issue 时范围行沿用 <PR号> 占位符；issue-plan 不检查，accept-check 的 scope 把 docs/pr/1614/qa.md、review.md 判越界。补救走 verdict --revise → needs_lead → 重出计划 add → unblock → 同 head 重写 awaiting_acceptance。
  - 提案:issue-plan.mjs 遇到范围行含 <…> 占位符时 exit 2 并提示改成 glob（如 docs/pr/*/review.md）；task-issue-child.md 范围示例给出 docs/pr/*/ 写法
- `user-direct-ready-bypasses-ledger` **用户直接让 owner 转 Ready 后，台账没有路走到收尾** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 cindy#8488：用户在 owner 会话里说「转 ready」，owner 转了 PR #8497；lead 验收时 accept-check 要求 Draft，verdict --pass 走不通，只能写 blocked_user 并手工收尾。建议 verdict 支持「用户已直接转 Ready」：accept-check 改用 ready 档复核，通过后直接进 accepted→ready。另：本次 scope 只因抽出的新文件不在范围而不过，lead 补 issue 范围后仍需 needs_lead→add 才能改计划。
- `stalled-signal-false-positive` **停滞信号只看台账，owner 正常干活也会误报** — 出现 3 次,首见 2026-10-30,最近 2026-11-02,status: open
  - 现象:2026-11-02 22:35 mivo#1612、cindy#8488 同时报停滞（30、32 分钟）；get_session_runtime 两个都是 phase=running、最后活动是当下，KEEL worktree 刚提交先红测试。建议停滞判定先查会话 runtime 或 worktree 最近提交，活跃就不报。
  - 提案:issue-watch 判停滞时先用 get_task_digest 的 phase 和 idle_minutes 过滤；SKILL 改成确实无活动才催。
- `deps-line-related-item-unparseable` **依赖一句提到关联项「互不依赖」时出计划被拒** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 mivo#1612：依赖写「无，随时可开工。与关联项 makecindy/cindy#8488 互不依赖，谁先合都行」，parseDeps 判断不了类型而拒收；「互不依赖」「不依赖」这类否定句应按无依赖处理，或模板注明依赖段只写会挡开工的项。
- `scope-desc-leading-slash-rejected` **范围说明里的端点名（如 /app-context）被当成绝对路径拒收** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 mivo#1612：范围行说明文字里写了反引号的 /app-context，isPathLike 因含 / 收进 scope，再被「必须是仓内相对路径」拒收。说明格里以 / 开头的词应跳过而不是整份拒收。
- `script-schedule-rejects-silent-when-idle` **SKILL 第 5 步让 script 调度带 silentWhenIdle，宿主拒收** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 mivo#1612/cindy#8488：schedule_create executionMode=script 带 silentWhenIdle:true 返回 INVALID_PARAMS「script execution does not support silentWhenIdle」，去掉后才建成。SKILL.md 第 5 步应删掉这个参数。
- `scope-negation-parsed-as-path` **范围行里写「不改 .github/」会被解析成可改路径** — 出现 1 次,首见 2026-11-01,最近 2026-11-01,status: open
  - 现象:#1329 范围说明里带反引号的 .github/ 进了 KEEL 写域；issue-plan 应跳过否定语境的路径，或要求不做的事只写在「不做」段。
- `send-to-session-rejects-gateway-model` **send_to_session 新建不接受 Cindy AI 网关模型** — 出现 1 次,首见 2026-11-01,最近 2026-11-01,status: open
  - 现象:用户点名 Cindy AI 网关 sonnet 5.5 xhigh，send_to_session 只认当前位置的 anthropic 模型；只能用一次性定时任务（schedule_create 带 model/providerId/effort + run_now）开会话，bind 回执要手工拼。建议支持这种开会话方式的回执。
- `owner-turn-ends-without-checkpoint` **owner 会话多次没写 checkpoint 就结束本轮** — 出现 1 次,首见 2026-11-01,最近 2026-11-01,status: open
  - 现象:#1329 第 2、3 任 owner 都在长测试或上下文膨胀时停下且不写 checkpoint，靠 stalled 信号 30 分钟后才发现；第 2 任被误判卡死后又复活，与第 3 任同时写同一棵树。建议 release 前先停掉并归档旧会话，开工包写明上下文预算与分批 commit。
- `scope-misses-test-helpers` **范围只写 *.test.ts 时测试夹具会被 accept-check 判越界** — 出现 1 次,首见 2026-11-01,最近 2026-11-01,status: open
  - 现象:#1329：brainHarness.ts、depositTestHarness.ts 被 scope 检查拒；awaiting_acceptance 不能 add 计划，只能 revise→needs_lead→add→unblock 绕一圈。建议 issue-plan 给 *.test.ts 自动带上 __tests__/** 夹具，或允许 lead 在 awaiting_acceptance 时追加纯测试路径。
- `duplicate-lead-after-old-lead-revived` **旧 lead 被归档后又被用户消息唤醒，不知道新 lead 已接手，又派了一个重复的新 lead** — 出现 1 次,首见 2026-11-01,最近 2026-11-01,status: open
  - 现象:2026-11-01 mivo#1460/#1309：一次性调度建的新 lead aec30e8d 已接手并归档旧 lead f6b80a21，用户随后在 f6b80a21 里问「目前什么情况」，旧 lead 上下文里没有接手记录，又发了一份完整交接包给新会话 ce7bb5b3，并把 issue-watch.json 和两条续跑调度改指向它。靠 ce7bb5b3 核对台账、调度和 GitHub 评论才发现 #1461 已换过 owner，没有重复 release 或重派。
  - 提案:交接旧 lead 时，新 lead 在两份 issue-watch.json 旁写一个 LEAD_HANDOFF.md（新 lead id、时间、已做步骤）；旧 lead 被唤醒第一步先读它，有就只汇报不再交接；SKILL 第 6 步写明「交接前先查台账 lead_session_id 和 issue-watch 配置是否已经换人」。
- `spec-file-gaps-in-existing-issue` **issue 写了派发前未修的验收矛盾** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-30 mivo#1328：原范围写已有就直接回 ACK，与 libraryWriteEpoch.protocol.test.ts 冲突，靠诊断时发现才改写。若直接派发，owner 会一路做到不通。
  - 提案:拆 issue 时把范围里涉及的协议约定与现有守卫测试对照一遍。
- `worktree-lost-during-blocked-run` **owner 阻塞等待时工作树被夜间清理** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-30 至 31 mivo#1328：等 Mac 测试和预算恢复期间，KEEL 工作树两次消失，分支还在；未推送的提交只靠本地分支保住。
  - 提案:写 blocked_user 前先把分支推到远端或打保护标记；查清理工作树的日任务为何不避开台账在途的工作树。
- `keel-max-attempts-after-real-findings` **审查轮数上限和批准执行的验收点冲突** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-31 mivo#1328：4 轮审查都查出真 P2，KEEL astra-final-review 达 max_attempts 只给 stop，当前 head 没有非作者结论，到不了验收点。owner 提议开第 3 个 run 绕过；lead 改派独立 Orca reviewer，又查出 3 条 P2，修后复核通过。
  - 提案:到上限时开工包写明走 needs_lead，由 lead 派独立 reviewer；只复核上一轮修复；再出新 P2 交用户定。
- `pending-question-blocks-unattended-owner` **写着问用户的待定问题，会卡住验收** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-31 makecindy/cindy#8081：待定问题写“开工后问用户”，owner 无人值守问不了，accept-check 因此不过，lead 要在验收时补写结论。
  - 提案:issue-plan 派发前提示写着问用户的待定问题，要求开工前定好，或写明默认做法。
- `owner-skip-local-gate-unreported` **owner 自行跳过本地门禁，lead 验收时没发现** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-30 makecindy/cindy#8080：owner 问 Jev 后用 SKIP_DEMO_GATE=1 推送，只写在 PR 正文和最后回报里，accept-check 不看，lead 验收漏报给用户；#8081 同样被拦时 owner 改为 needs_lead，由用户批准。
  - 提案:开工包写明：跳过任何本地或仓库门禁都写 needs_lead，不用 Jev 代替用户授权；accept-check 增加 PR 正文跳过声明提示。
- `repo-handoff-path-missing-from-scope` **拆 issue 时漏了目标仓强制要求的路径** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 mivo#1328：改写范围时漏了 docs/pr/**，而 Mivo 的 pr-handoff-gate 强制要求，派发前才发现，要释放认领重出计划。
  - 提案:issue-plan 对 xindong/mivo-canvas-plugin 校验范围含 docs/pr/**，缺失时 fail-closed。
- `fork-only-repo-handoff-gap` **开工包没有覆盖只读仓的 fork 推送** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 makecindy/cindy#8080：账号只有读权限，origin 推不上去，开工包没写 fork 流程，lead 只能派发后补一条消息并转插话。
  - 提案:issue-plan 查 repo permissions；push=false 时开工包写明 fork 远端和 --head 写法。
- `schedule-silent-when-idle-rejected` **第 5 步写的 silentWhenIdle 被 script 调度拒绝** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 makecindy/cindy#8080、mivo#1328：schedule_create 在 executionMode=script 时返回 INVALID_PARAMS: script execution does not support silentWhenIdle，还要求 agentKind、kind、useWorktree、notify。
  - 提案:SKILL 第 5 步去掉 silentWhenIdle，写全必填字段，并写 notify 全 false，避免每 5 分钟通知一次。
- `plan-premise-not-checked-in-source` **上线步骤按记忆判断 KEEL 能力，没先读源码核实，向 Jev 提问时带了错误前提** — 出现 1 次,首见 2026-10-29,最近 2026-10-29,status: open
  - 现象:2026-10-29 PraiseZhu/approve-exec#67 第 4 步：主控把 stages.ts「Pi 不用于 KEEL 派工」（限制阶段 Worker）误读为 KEEL 不接受 Pi 当主控，三台 Pi 规则改错；GPT 审查 project-keel PR #68 时指出，已按原计划更正。#68 issue-plan 的 Pi 拒绝提示也沿用了这个不准确的理由（待用户决定）。
  - 提案:涉及另一个仓能力边界的判断（谁能当主控、哪个入口做什么），先在该仓源码里找到校验代码再下结论；问 Jev 时把源码证据原文放进 context。
- `scope-path-prefix-omitted` **子 issue 范围列文件时省略目录前缀，issue-plan 按字面当根目录文件，accept-check 判超范围** — 出现 1 次,首见 2026-10-29,最近 2026-10-29,status: open
  - 现象:2026-10-29 PraiseZhu/approve-exec#70：范围行「`scripts/run-ledger.mjs`、`context-intake.mjs`…」只有第一个带 scripts/，e2e 在 PR #73 上 accept-check 判 26 个删除文件超出范围；补全前缀后通过。
  - 提案:open-issue §1 与 task-issue-child 模板写明「每个文件写仓根起的完整路径，不省略目录前缀」；或 issue-plan 在同一范围行里带目录与不带目录的文件混写时 fail-closed 并点名。

## 已否决的提案(留档防止重复提出)

- `cleanup-rejects-watcher-head-after-merge` PR 转 Ready 后 Mini 盯梢推新提交再合并，cleanup/archived 因验收 head 与 PR head 不一致拒绝收尾，台账永远停在 ready — 重复登记，合并到 merged-after-handoff-head-mismatch
