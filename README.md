# approve-exec — Graph loop 编排 skill

把 task-priority 产出的 task-manifest.json 自动执行到「可直接『提交 PR』」：
E(执行)→R(审查修复)→V(SC 验收)→T(e2e)→P(打包) 五阶段状态机，lead 只编排决策。

- 执行环节派工硬约束：worker 必须以 goal skill 场景 C 触发（claude-code 钉死）
- 并发 = min(内存允许, `orcaPlatformCap`（config/defaults.json）, 待派组数)，每次派工前现跑 mem-probe；
  平台侧 worker 硬上限不在此复述——由 Orca 运行时返回（create_worker 超限即拒），本仓只消费 config 里的执行档位
- 状态全落 run 台账（~/.claude/.orca/approve-exec/），断点续跑 = `批准执行 --resume <run_id>`（skill 触发词参数，非脚本子命令，详见 SKILL.md §⑥）

状态：实现收敛期——五阶段编排守则（SKILL.md）与 run-ledger / ready-check / selfcheck / mem-probe 四脚本已落地；run 台账在 ~/.claude/.orca/approve-exec/，支持 `批准执行 --resume <run_id>` 断点续跑
