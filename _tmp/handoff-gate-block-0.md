# 开工闸（包文第 0 块，逐字）

用 goal skill 执行。
--until-sc

这是执行指令，不要反问要不要开始。

执行顺序（乱序 = 未开工，立刻停，jump 回报 lead）：

1. 调用你自己的 goal skill。必须真的 Read 这个文件，读完按其正文走场景 C：
   /Users/praise/.agents/skills/goal/SKILL.md
   未 Read 这一文件 = 未调用 goal skill = 不得改 allowed_paths 里的任何文件。
2. 本 PR 的 SC 全 PASS 之后、派 tester/reviewer 之前：必须真的现读同一份 routing.json。
   先跑 `model-route show`
   或 Read
   /Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json
   （等价软链 /Users/praise/.agents/skills/orca-fanout/routing.json）
   未读这一文件、也未跑 model-route show = 不得 create_worker / create_workers。
3. tester 用现读 **e2e** 档的 agent/model/effort；reviewer 用现读 **review** 档。
   禁止把包里的模型 ID 抄进 create_worker。

检查你是否真的执行（自报「我读了」不算；必须先交收据）：

- 第 1 步完成后、改任何代码之前：jump 回报 lead，payload 类型 `gate_goal`，带 goal_skill_path + goal_skill_sha256（对该文件 utf-8 字节做 sha256，64 位 hex）。
- 第 2 步完成后、create_worker 之前：jump 回报 lead，payload 类型 `gate_routing`，带 route_source + routing_sha256（对 routing.json utf-8 字节做 sha256）+ e2e_model + review_model（从刚读到的 JSON 抄 primary，不是从本包快照抄）。
- lead 会用磁盘上的同一文件重算 sha256。对不上、缺收据、或收据到达前 worktree 已有新 commit = 未执行 = 不得开工。

未读 goal skill、或未读 routing.json、或收据未过 lead 对账：不得开工。不得写代码、不得开 PR、不得派 worker。停，jump 回报 lead，写明卡在第几步。
