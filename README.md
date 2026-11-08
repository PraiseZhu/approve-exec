# approve-exec — 批准执行

Mini 常驻盯梢消费者的版本化源码已迁至独立仓 [Vigil](https://github.com/PraiseZhu/vigil)。它独立扫描本人 PR，不要求 PR 由本 skill 创建；该仓不包含运行态，也不修改服务器审查机。

接在「开 issue」之后：用户说「批准执行 owner/repo#号」，lead 读总 issue（或独立 issue / 单个子 issue），按并行/串行原则把依赖已合入的子 issue 一次全派出去，每个子 issue 开一个独立会话（1 子 issue = 1 PR = 1 会话），派会话不带模型参数。2026-11-07 起不走 KEEL、不建台账、不挂定时任务：lead 派完就停；执行会话推到 Draft PR CI 全绿后发消息叫醒 lead 验收，lead 判通过后执行会话转正式 PR 即收工；用户在 lead 会话说「合并」后，Mivo 仓 PR 交合并伙伴、合入后伙伴通知 lead，其他仓 PR 由 lead 按 pr-merge 自己合；PR 合入后 lead 归档已完成的会话、派下一批。

- 看现状、开工消息、派发防重 `scripts/batch.mjs`；验收与收工检查 `scripts/check-pr.mjs`；执行会话的做法 `references/owner-protocol.md`
- 改版前开工的旧 run 按 `references/legacy-ledger-flow.md` 收尾（旧脚本 `issue-plan.mjs`、`issue-run.mjs`、`accept-check.mjs`、`issue-watch.py` 等保留到旧 run 全部收工）
- 合并只由用户对指定 PR 当次授权：用户在提示词里明确授权的加急 admin 合并由 lead 执行；用户说「合并」的 PR，Mivo 仓由合并伙伴合，其他仓由收到这句话的会话按 pr-merge 的标准自己合。除此之外本 skill 不合入
- 保证等级 T1：脚本校验防疏忽和漂移，不防有意绕过

步骤见 `SKILL.md` ⓪。测试：`node scripts/run-tests.mjs`、`python3 -B -m unittest discover -s tests -p 'test_*continuation.py'`。
