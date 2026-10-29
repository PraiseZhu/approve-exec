# approve-exec — 批准执行

Mini 常驻盯梢消费者的版本化源码已迁至独立仓 [Vigil](https://github.com/PraiseZhu/vigil)。它独立扫描本人 PR，不要求 PR 由本 skill 创建；该仓不包含运行态，也不修改服务器审查机。

接在「开 issue」之后：用户说「批准执行 owner/repo#号」，lead 读总 issue（或独立 issue / 单个子 issue），按并行/串行原则给每个子 issue 开一个独立会话（1 子 issue = 1 PR = 1 会话），派会话不带模型参数。owner 会话用 KEEL 的 `keel_run` 推进到验收点写 checkpoint；零 token 续跑脚本 `scripts/issue-watch.py` 叫醒 lead；lead 跑 `scripts/accept-check.mjs` 后判通过或要改（最多 2 轮）；通过后转 Ready、清本地、归档会话，依赖合入后开下一批。

- 出计划 `scripts/issue-plan.mjs`；台账、checkpoint、裁决与收尾 `scripts/issue-run.mjs`；开工包 `scripts/render-issue-handoff.mjs`；验收检查 `scripts/accept-check.mjs`
- 本 skill 不合入；合并只由用户对指定 PR 当次授权
- 保证等级 T1：脚本校验防疏忽和漂移，不防同一 OS 用户主动改台账

步骤见 `SKILL.md` ⓪，owner 协议见 `references/issue-owner-protocol.md`。测试：`node scripts/run-tests.mjs`、`python3 -B -m unittest discover -s tests -p 'test_*continuation.py'`。
