# approve-exec 自进化台账

自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。
条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md 第⑱节。

## 待维护者拍板(扩权类提案,永不自动落地)

- `masked-path-breaks-session-dispatch` **远程主控看到的路径被改写，照抄进 send_to_session 报项目未登记** — 出现 1 次,首见 2026-11-15,最近 2026-11-15,status: open
  - 现象:2026-11-15 #111 首次派发：lead 跑在 Praise-VPS，工具输出里本机的用户目录被显示成另一种路径，lead 照抄 project_path、working_dir 后 send_to_session 报 NOT_FOUND（Project is not registered）；改用 brief 输出的原始值重发成功。
  - 提案:派发参数由程序从 brief 的 request JSON 读出原样传，不从屏幕照抄路径；SKILL 第 2 步可补一句。
  - 备注:归属：lead 派发时的参数传递（SKILL 第 2 步）；只在主控跑在远程网关、工具输出改写路径时出现，保留观察
- `lead-test-expectation-off-contract` **lead 写给测试 Worker 的期望和子 issue 契约冲突，测试据此判不通过** — 出现 1 次,首见 2026-11-15,最近 2026-11-15,status: open
  - 现象:2026-11-15 PR #113：lead 派 e2e 时写「Mivo 范围只有 docs/** 期望混合」，但 #111 契约要求 Mivo 仓库卡把 docs/design.md 算界面；测试按 lead 的期望判 P2 不通过，lead 核对契约后请测试复核改判，多了一轮。
  - 提案:派 e2e 前把每条期望对回子 issue 的契约和仓库卡；期望从子 issue 的 SC 和契约派生，不由 lead 另编。
  - 备注:归属：lead 派 e2e 的派工包（pr-merge 第 4 节、orca-fanout 派工包模板）；出现第二次再在派工包模板里加「期望逐条对回子 issue 契约」
- `deps-line-related-item-unparseable` **依赖一句提到关联项「互不依赖」时出计划被拒** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 mivo#1612：依赖写「无，随时可开工。与关联项 makecindy/cindy#8488 互不依赖，谁先合都行」，parseDeps 判断不了类型而拒收；「互不依赖」「不依赖」这类否定句应按无依赖处理，或模板注明依赖段只写会挡开工的项。
  - 备注:归属：issue-plan.mjs parseDeps；留到 open-issue 体检（下一期）
- `scope-desc-leading-slash-rejected` **范围说明里的端点名（如 /app-context）被当成绝对路径拒收** — 出现 1 次,首见 2026-11-02,最近 2026-11-02,status: open
  - 现象:2026-11-02 mivo#1612：范围行说明文字里写了反引号的 /app-context，isPathLike 因含 / 收进 scope，再被「必须是仓内相对路径」拒收。说明格里以 / 开头的词应跳过而不是整份拒收。
  - 备注:归属：issue-plan.mjs 的范围解析；留到 open-issue 体检（下一期）
- `spec-file-gaps-in-existing-issue` **issue 写了派发前未修的验收矛盾** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-30 mivo#1328：原范围写已有就直接回 ACK，与 libraryWriteEpoch.protocol.test.ts 冲突，靠诊断时发现才改写。若直接派发，owner 会一路做到不通。
  - 提案:拆 issue 时把范围里涉及的协议约定与现有守卫测试对照一遍。
  - 备注:归属：open-issue 体检（下一期，总 issue 与子 issue 验收项一致性检查）
- `worktree-lost-during-blocked-run` **owner 阻塞等待时工作树被夜间清理** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-30 至 31 mivo#1328：等 Mac 测试和预算恢复期间，KEEL 工作树两次消失，分支还在；未推送的提交只靠本地分支保住。
  - 提案:写 blocked_user 前先把分支推到远端或打保护标记；查清理工作树的日任务为何不避开台账在途的工作树。
  - 备注:归属：扫地僧的清理范围（不在本仓）；对账任务会在 6 小时无动静时探活，能更早发现
- `pending-question-blocks-unattended-owner` **写着问用户的待定问题，会卡住验收** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-31 makecindy/cindy#8081：待定问题写“开工后问用户”，owner 无人值守问不了，accept-check 因此不过，lead 要在验收时补写结论。
  - 提案:issue-plan 派发前提示写着问用户的待定问题，要求开工前定好，或写明默认做法。
  - 备注:归属：batch.mjs status 已把未定的待定问题判成 needs_decision 不派；写着「问用户」的由 lead 先问 Jev，保留观察
- `owner-skip-local-gate-unreported` **owner 自行跳过本地门禁，lead 验收时没发现** — 出现 1 次,首见 2026-10-31,最近 2026-10-31,status: open
  - 现象:2026-10-30 makecindy/cindy#8080：owner 问 Jev 后用 SKIP_DEMO_GATE=1 推送，只写在 PR 正文和最后回报里，accept-check 不看，lead 验收漏报给用户；#8081 同样被拦时 owner 改为 needs_lead，由用户批准。
  - 提案:开工包写明：跳过任何本地或仓库门禁都写 needs_lead，不用 Jev 代替用户授权；accept-check 增加 PR 正文跳过声明提示。
  - 备注:归属：lead 验收靠 PR 正文「已验证」的命令和退出码核对；预审（#107）会多一道，仍可能漏，保留观察
- `fork-only-repo-handoff-gap` **开工包没有覆盖只读仓的 fork 推送** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 makecindy/cindy#8080：账号只有读权限，origin 推不上去，开工包没写 fork 流程，lead 只能派发后补一条消息并转插话。
  - 提案:issue-plan 查 repo permissions；push=false 时开工包写明 fork 远端和 --head 写法。
  - 备注:归属：owner-protocol.md 没有覆盖只读仓的 fork 推送；出现第二次再补
- `scope-path-prefix-omitted` **子 issue 范围列文件时省略目录前缀，issue-plan 按字面当根目录文件，accept-check 判超范围** — 出现 1 次,首见 2026-10-29,最近 2026-10-29,status: open
  - 现象:2026-10-29 PraiseZhu/approve-exec#70：范围行「`scripts/run-ledger.mjs`、`context-intake.mjs`…」只有第一个带 scripts/，e2e 在 PR #73 上 accept-check 判 26 个删除文件超出范围；补全前缀后通过。
  - 提案:open-issue §1 与 task-issue-child 模板写明「每个文件写仓根起的完整路径，不省略目录前缀」；或 issue-plan 在同一范围行里带目录与不带目录的文件混写时 fail-closed 并点名。
  - 备注:归属：issue-plan.mjs 的范围解析与 open-issue 的写法；v3 的范围三档让这类漏列可以在 PR 正文说明后由 lead 判断，根因留到 open-issue 体检（下一期）

## 已处理的提案(已落地 / 已失效)

- `plan-premise-not-checked-in-source` 上线步骤按记忆判断 KEEL 能力，没先读源码核实，向 Jev 提问时带了错误前提 — status: obsolete，批准执行 2026-11-07 起不走 KEEL（2026-11-14 清理，#108）
- `schedule-silent-when-idle-rejected` 第 5 步写的 silentWhenIdle 被 script 调度拒绝 — status: landed，#108：对账任务不带这个参数，README「对账任务」写明；没有到期动作时脚本自己安静结束
- `stalled-signal-false-positive` 停滞信号只看台账，owner 正常干活也会误报 — status: landed，#103：对账器判停滞只看提交、检查、标签和 review，不看台账或评论多久没写
- `repo-handoff-path-missing-from-scope` 拆 issue 时漏了目标仓强制要求的路径 — status: landed，#106：仓库强制的交接目录由仓库卡 always_allowed（docs/pr/{pr}/**）放行，没有仓库卡的仓固定放行 docs/pr/<PR号>/
- `keel-max-attempts-after-real-findings` 审查轮数上限和批准执行的验收点冲突 — status: obsolete，批准执行 2026-11-07 起不走 KEEL，判要改不设轮数上限（2026-11-14 清理，#108）
- `merged-after-handoff-head-mismatch` 交接后盯梢推新提交再合并，台账 cleanup/archived 因 head 不一致拒绝 — status: obsolete，旧台账流程的问题，该流程 2026-11-07 起退役（2026-11-14 清理，#108）
- `duplicate-lead-after-old-lead-revived` 旧 lead 被归档后又被用户消息唤醒，不知道新 lead 已接手，又派了一个重复的新 lead — status: landed，#105：lead 会话地址写在章程里，换 lead 时发新章程，对账任务只叫醒最新章程里的 lead
- `scope-misses-test-helpers` 范围只写 *.test.ts 时测试夹具会被 accept-check 判越界 — status: landed，已落地：测试 glob 自动带上同目录 __tests__/ 里的夹具（issue-plan.mjs toTestHelperGlob）
- `owner-turn-ends-without-checkpoint` owner 会话多次没写 checkpoint 就结束本轮 — status: obsolete，旧台账流程的问题，该流程 2026-11-07 起退役（2026-11-14 清理，#108）
- `send-to-session-rejects-gateway-model` send_to_session 新建不接受 Cindy AI 网关模型 — status: obsolete，2026-11-07 起按 dispatchRoute 显式传执行框架、模型和网关，不再继承（2026-11-14 清理，#108）
- `scope-negation-parsed-as-path` 范围行里写「不改 .github/」会被解析成可改路径 — status: landed，已落地：3df77b8 写域解析忽略「不改 …」这类否定语境
- `script-schedule-rejects-silent-when-idle` SKILL 第 5 步让 script 调度带 silentWhenIdle，宿主拒收 — status: landed，#108：对账任务不带这个参数，README「对账任务」写明；没有到期动作时脚本自己安静结束
- `user-direct-ready-bypasses-ledger` 用户直接让 owner 转 Ready 后，台账没有路走到收尾 — status: obsolete，旧台账流程的问题，该流程 2026-11-07 起退役（2026-11-14 清理，#108）
- `scope-placeholder-not-rejected` issue 范围写了模板占位符 docs/pr/<PR号>/，issue-plan 原样收进计划，验收时把真实交接文件判越界 — status: landed，#106：仓库强制的交接目录由仓库卡 always_allowed（docs/pr/{pr}/**）放行，没有仓库卡的仓固定放行 docs/pr/<PR号>/
- `watch-schedule-silent-rejected` 第 5 步续跑调度的 silentWhenIdle 被宿主拒绝 — status: landed，#108：对账任务不带这个参数，README「对账任务」写明；没有到期动作时脚本自己安静结束
- `owner-brief-virtual-paths` 开工包里的绝对路径是 lead 会话的虚拟路径，owner 会话解析不到台账 — status: obsolete，旧台账流程的问题，该流程 2026-11-07 起退役（2026-11-14 清理，#108）
- `repo-mandated-handoff-scope` 开工包 scope 漏了目标仓强制的 PR 交接目录 — status: landed，#106：仓库强制的交接目录由仓库卡 always_allowed（docs/pr/{pr}/**）放行，没有仓库卡的仓固定放行 docs/pr/<PR号>/
- `ui-evidence-not-checked-at-acceptance` lead 验收与 accept-check 不查 PR「效果展示」：改了界面却没有截图或 HTML 模拟界面也能过 — status: landed，已落地：SKILL.md 第 4 步「界面有变化却没附截图或 demo 判要改」（2026-11-07 改版）
- `root-check-rejects-watcher-fixes-after-ready` Mivo PR 转 Ready 后由 Mini 盯梢修审查意见是仓库规定流程，但 root-check 把 lane=null 当 personal 车道，盯梢推的新提交被判「没验收过」，总验收 handoff 无法交接（mivo#1664/#1675，2026-11-04） — status: obsolete，旧台账流程的问题，该流程 2026-11-07 起退役（2026-11-14 清理，#108）
- `post-accept-head-drift` 验收后只改文档的新提交没法在台账里重新验收 — status: landed，#104：check-pr.mjs --stage recheck 只查判通过后的新增改动，通过后对新版本再记一次 verdict_pass
- `integration-pr-no-auto-intake` 集成分支 PR 转正式后只登记通知，没交合并请求，PR 一直不合 — status: landed，#105：章程授权后对账器对审查放行未入队的 PR 产生 request_merge，batch.mjs merge-request 按目标分支核对授权
- `child-scope-misses-necessary-files` 子 issue 范围清单反复漏列必要文件，每个 PR 验收都要 lead 补范围 — status: landed，#106：范围三档 + 仓库卡 always_allowed/hot_files；开 issue 时预查范围属于 open-issue，留到下一期
- `post-ready-fix-breaks-child-sc` 转正式后盯梢的修复可能破坏子 issue 验收项，lead 没有合并前复核 — status: landed，#104：对账器发现判通过后代码变了就产生 recheck；recheck 检查存量测试有没有被删行
- `routing-entry-without-device` routing.json 的 Worker 条目没写运行位置，派工方换了电脑就派不出去 — status: landed，model-route 2026-11-15：每条 Worker 与 session 条目必须有 agent_device_id，set 必须带 --device；routing.json 已全部补齐

## 已否决的提案(留档防止重复提出)

- `cleanup-rejects-watcher-head-after-merge` PR 转 Ready 后 Mini 盯梢推新提交再合并，cleanup/archived 因验收 head 与 PR head 不一致拒绝收尾，台账永远停在 ready — 重复登记，合并到 merged-after-handoff-head-mismatch
