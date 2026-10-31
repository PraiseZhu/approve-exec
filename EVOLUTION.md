# approve-exec 自进化台账

自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。
条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md 第⑱节。

## 待维护者拍板(扩权类提案,永不自动落地)

- `repo-handoff-path-missing-from-scope` **拆 issue 时漏了目标仓强制要求的路径** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 mivo#1328：改写范围时漏了 docs/pr/**，而 Mivo 的 pr-handoff-gate 强制要求，派发前才发现，要释放认领重出计划。
  - 提案:issue-plan 对 xindong/mivo-canvas-plugin 校验范围含 docs/pr/**，缺失时 fail-closed。
- `fork-only-repo-handoff-gap` **开工包没有覆盖只读仓的 fork 推送** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 makecindy/cindy#8080：账号只有读权限，origin 推不上去，开工包没写 fork 流程，lead 只能派发后补一条消息并转插话。
  - 提案:issue-plan 查 repo permissions；push=false 时开工包写明 fork 远端和 --head 写法。
- `stalled-signal-false-positive` **停滞信号只看台账，owner 正常干活也会误报** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 两个 run 派发 33 分钟后都报停滞，核实时两个 owner 都 idle_minutes=0 且已有提交。台账到验收点才更新，长任务必然误报；SKILL 要求还在就催一次，催促消息只会排到本轮结束，多跑一轮。
  - 提案:issue-watch 判停滞时先用 get_task_digest 的 phase 和 idle_minutes 过滤；SKILL 改成确实无活动才催。
- `schedule-silent-when-idle-rejected` **第 5 步写的 silentWhenIdle 被 script 调度拒绝** — 出现 1 次,首见 2026-10-30,最近 2026-10-30,status: open
  - 现象:2026-10-30 makecindy/cindy#8080、mivo#1328：schedule_create 在 executionMode=script 时返回 INVALID_PARAMS: script execution does not support silentWhenIdle，还要求 agentKind、kind、useWorktree、notify。
  - 提案:SKILL 第 5 步去掉 silentWhenIdle，写全必填字段，并写 notify 全 false，避免每 5 分钟通知一次。
- `plan-premise-not-checked-in-source` **上线步骤按记忆判断 KEEL 能力，没先读源码核实，向 Jev 提问时带了错误前提** — 出现 1 次,首见 2026-10-29,最近 2026-10-29,status: open
  - 现象:2026-10-29 PraiseZhu/approve-exec#67 第 4 步：主控把 stages.ts「Pi 不用于 KEEL 派工」（限制阶段 Worker）误读为 KEEL 不接受 Pi 当主控，三台 Pi 规则改错；GPT 审查 project-keel PR #68 时指出，已按原计划更正。#68 issue-plan 的 Pi 拒绝提示也沿用了这个不准确的理由（待用户决定）。
  - 提案:涉及另一个仓能力边界的判断（谁能当主控、哪个入口做什么），先在该仓源码里找到校验代码再下结论；问 Jev 时把源码证据原文放进 context。
- `scope-path-prefix-omitted` **子 issue 范围列文件时省略目录前缀，issue-plan 按字面当根目录文件，accept-check 判超范围** — 出现 1 次,首见 2026-10-29,最近 2026-10-29,status: open
  - 现象:2026-10-29 PraiseZhu/approve-exec#70：范围行「`scripts/run-ledger.mjs`、`context-intake.mjs`…」只有第一个带 scripts/，e2e 在 PR #73 上 accept-check 判 26 个删除文件超出范围；补全前缀后通过。
  - 提案:open-issue §1 与 task-issue-child 模板写明「每个文件写仓根起的完整路径，不省略目录前缀」；或 issue-plan 在同一范围行里带目录与不带目录的文件混写时 fail-closed 并点名。
