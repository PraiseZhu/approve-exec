# approve-exec — Graph loop 编排 skill

Mini 常驻盯梢消费者的版本化源码已迁至独立仓 [Vigil](https://github.com/PraiseZhu/vigil)。它独立扫描本人 PR，不要求 PR 由本 skill 创建；该仓不包含运行态，也不修改服务器审查机。

把 task-priority 产出的 `task-manifest.json` 拆成 **每 GitHub PR 一个 owner session**。owner 拿到完整 handoff 立即开工，自主做到机器可证明的 **PR Ready**。candidate 只是检查点。lead 只拆 PR、写开工包、派 session、读证据、裁决 `DECISION_REQUIRED`。

- 执行环节硬约束：必须以 goal skill 场景 C 触发；E 席 `dispatch=session`
- T 由 **owner session** 现读 `routing.json` 派 e2e worker，结果只回 owner；本地不派 reviewer
- lead 不代执行产品任务；只读验收 `pr_ready` 后派 cleanup sub，再消费真实归档回执
- owner 派发通过 prepare → Cindy `send_to_session` → bind 记录一次性 claim；未知工具回执保留现场，不重复 create
- 旧台账 `accepted` / run `ready` 保持 legacy 语义，不得原地改名冒充 PR Ready
- owner 与 Mini 修复窗统一标题：`{项目名}-{中文任务名}丨 {MMDD}`；Mini 使用短中文任务名与 Asia/Shanghai 首次创建日，PR 号和修复角色留在 metadata，复用时保留原 session_id
- 本 skill 不合入、不跑三机同步；merge 由人点

状态：owner 自主验收、首次 CI 失败回修、`pr_ready`、本地清理和归档回执已由脚本校验。`scripts/lead-continuation.py` 为已显式配置的开工包提供 script-only 续跑；普通 owner 的阶段变化不逐轮唤醒 lead。它不自动注册未来任务，不替代宿主 Goal，也不保证 Cindy 离线时继续运行。Mini 独立发现目标仓本人 PR，不依赖本 skill 手动交接。保证等级仍是 T1 流程校验，不能阻止同一 OS 用户主动改账。Fable 决策是状态机外 sidecar（`config/fable-decision.json` + `scripts/decision-broker.mjs`）。
