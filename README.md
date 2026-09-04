# approve-exec — Graph loop 编排 skill

把 task-priority 产出的 `task-manifest.json` 拆成 **每 GitHub PR 一个 owner session**。owner 拿到完整 handoff 立即开工，自主做到机器可证明的 **PR Ready**。candidate 只是检查点。lead 只拆 PR、写开工包、派 session、读证据、裁决 `DECISION_REQUIRED`。

- 执行环节硬约束：必须以 goal skill 场景 C 触发；E 席 `dispatch=session`
- R/T 由 **owner session** 现读 `routing.json` 派 worker，结果只回 owner
- lead happy path 零执行：不改产品代码、不跑测试、不 git/gh、不搬 receipt、不替人开/修 PR
- 缺 Cindy 宿主 create gateway / lease / CAS 时，skill 侧 `HOST_GATEWAY_MISSING` fail-closed，不得真派
- 旧台账 `accepted` / run `ready` 保持 legacy 语义，不得原地改名冒充 PR Ready
- 标题：`{项目名}-{中文任务名}丨 {MMDD}`（任务段必须含汉字）；盯梢修复窗同一套
- 本 skill 不合入、不跑三机同步；merge 由人点

状态：vNext owner 契约已在本仓落地（handoff 校验、标题、盯梢命名、缺宿主 fail-closed）。宿主 create gateway 与 per-PR `PR_READY` 状态机尚未实现，不能声称当前系统已经修好。Fable 决策是状态机外 sidecar（`config/fable-decision.json` + `scripts/decision-broker.mjs`）。
