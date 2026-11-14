# 回放数据

`scripts/replay-capture.mjs` 录下的真实批准执行 run 的 GitHub 时间线，只读，供测试重跑对账器。

- `xindong__mivo-canvas-plugin__2089.json`：画布边界（2026-11-10 至 11-12 的子 issue 阶段，以及之后的修正子 issue）
- `xindong__mivo-canvas-plugin__2214.json`：单文件 1200 行（2026-11-12，7 个并行 PR 合进集成分支）

结构（`schema: approve-exec/replay@1`）：`root`（总 issue 和评论）、`children`（每个子 issue 的正文、状态、评论）、`prs`（每个写着「任务 issue：<子 issue>」的 PR：目标分支、合并时间、时间线事件、提交、review）、`login`（录制账号，解析时只认它发的评论）。时间都是 GitHub 返回的 UTC 原值。

不含会话聊天记录。这里的数据是瘦身版（`--slim`）：评论只留第一行（最多 200 字符）和 approve-exec 的机器标记，issue 正文清空；邮箱换成 `[EMAIL]`，命中密钥样式的整条换成 `[REDACTED]`。
