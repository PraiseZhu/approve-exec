# approve-exec — 「批准执行」lead 侧多 worker loop 编排 skill

把 task-priority 产出的 task-manifest.json 自动执行到「可直接『提交 PR』」：
E(执行)→R(审查修复)→V(SC 验收)→T(e2e)→P(打包) 五阶段状态机，lead 只编排决策。

- 执行环节派工硬约束：worker 必须以 goal skill 场景 C 触发（claude-code 钉死）
- 并发 = min(内存允许, Orca 平台上限 8, 待派组数)，每次派工前现跑 mem-probe
- 状态全落 run 台账（~/.claude/.orca/approve-exec/），支持 --resume 断点续跑

状态：脚手架基线（v0，规划轮 bootstrap；功能按 task-priority 释放的派工包建设）
