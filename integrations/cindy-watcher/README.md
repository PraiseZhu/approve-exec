# Cindy PR 盯梢修复工具

此目录是 Mini 盯梢消费者的 Cindy 仓副本。独立复制自 `integrations/mivo-watcher/`（v2：发现器 + 每 PR 轮询 + 每 PR 专属修复 session），**不得改 mivo-watcher 源码**。扫描当前登录用户在 `makecindy/cindy` 的 open PR；head 在 fork 上时由独立 session 修审查反馈与 CI，直到 `awaiting-maintainer-approval`，并继续轮询到 MERGED/CLOSED。

helper 的 complete 仅表示一轮修复完成；不会合并 PR、不会开 auto-merge、不会删远端分支、不会改 CI、不会请求或代替维护者审批。

## 与 Mivo 盯梢的差异

| 项 | Mivo | Cindy |
|----|------|-------|
| 仓 | `xindong/mivo-canvas-plugin` 同仓分支 | `makecindy/cindy`，head 在 `PraiseZhu/cindy-fork`（cross-repo） |
| origin | 插件仓 origin | PR head 仓（fork）；`upstream`=`makecindy/cindy` 只 fetch |
| push | origin 上的 PR 分支 | 只允许 fast-forward 到 fork 的 `headRefName`；绝不 push 到 `makecindy/cindy` |
| 准入 | required CI 绿 + 三审 ingress | required CI 绿（rules API，不读 `docs/sync/required-checks.json`） |
| 本轮通过 | `review:merge-ready` 标签 | `awaiting-maintainer-approval`（仍需维护者 1 个 approve，盯梢不催） |
| 严重度 | 评论 P0/P1 才改代码；P2/P3 reply-only | 评论 P0/P1/P2 授权修复；P3/建议/未定级 reply-only |
| 自动 resolve | 可信来源 P2/P3 | 仅可信来源且已定级 P3；403 降级为会话内报告 |
| 停盯 | `mivo-watch:off` 标签 | `config/optout.json` 或作者本人 issue comment 正文恰为 `/cindy-watch off` |
| CI 失败 | 可 `gh run rerun` | 不许 rerun；相关则修；flaky/外部则每 head SHA 最多一次 `git commit -s --allow-empty` |
| 验证 | `.githooks/pre-push` | cindy 预检脚本，禁止 skip；待推送 commit 必须 `Signed-off-by` |
| 冲突 | `git merge origin/main` | `git fetch upstream main` 后 merge 进 PR 分支再 push fork |

可信审查来源：`greptile-apps` 与 `github-actions[bot]`。GraphQL `Bot.login` 不带 `[bot]` 后缀，按 `__typename=="Bot"` 归一后再比较。

## 运行参数

环境变量前缀 `CINDY_WATCHER_*`（`HOME` / `LIVE` / `ENABLED` / `DISPATCH` / `MODE` / `PR` / `NODE_ID`），另：`CINDY_NODE_BIN`、`CINDY_WATCHER_REPO`、`CINDY_WATCHER_BRIDGE`、`GH_BIN`。

| 项 | 默认 |
|----|------|
| runtime home | `/Users/praise/AI-Agent/Claude/projects/Project CINDY/_ops/cindy-watcher` |
| 本地仓 | `/Users/praise/AI-Agent/Claude/projects/Project CINDY` |
| PR 工作树 | `<仓>/.worktrees/watch/pr-<N>`（独立 clone，origin=fork） |
| 合并后备份 | `<仓>/_backup/` |

运行时必须显式设置 `CINDY_WATCHER_HOME`。不得在本目录执行 live watcher 或存放 state、worktree、DB、日志、凭证。

## 发现器 / 每 PR 调度

发现器：`workingDir` = Cindy 本地仓，cron `*/5 * * * *`，timeout 180s，command `cindy-watch-script.py --mode discover`。**部署时发现器调度用同一 primary**（`providerId=xd`，`model=openai/gpt-6-luna`，Cindy 界面显示为「Cindy AI」，`effort=max`）。

每 PR 轮询由修复 session 用 `cindy-repair.mjs schedule-params` 生成后 `schedule_create`：

- `name`: `Cindy watch #<N>`
- primary：`agentKind` `codex`，`model` `openai/gpt-6-luna`，`providerId` `xd`（界面「Cindy AI」），`effort` `max`
- fallback：`agentKind` `codex`，`model` `gpt-6-luna`，`providerId` `art-cindy`，`effort` `max`（仅当 schedule_create / 首轮 dispatch 报 `NO_PROVIDER_FOR_AGENT`、`PROVIDER_ROUTE_UNAVAILABLE` 或模型不存在时用一次；其它错误直接 blocked，不静默换模型）
- `executionMode` `script`，`capabilities` `["sessions.dispatch"]`，禁止 `silentWhenIdle`
- command 形态：

```
/usr/bin/env CINDY_WATCHER_LIVE=1 "CINDY_WATCHER_HOME=<home>" CINDY_NODE_BIN=/opt/homebrew/bin/node GH_BIN=/opt/homebrew/bin/gh PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 "<home>/bin/cindy-watch-script.py" --mode poll --pr <N> --node-id <id>
```

## 停盯

1. runtime `config/optout.json`：PR 号数组，例如 `[5307]`。
2. 该 PR 作者本人发一条正文恰为 `/cindy-watch off` 的 issue comment。

用户不能给 base 仓 PR 加标签，因此没有标签停盯。

## 部署（本次不执行）

首次部署 runtime 为空时：

```sh
node integrations/cindy-watcher/deploy.mjs bootstrap --home "$RUNTIME"
node integrations/cindy-watcher/deploy.mjs verify --home "$RUNTIME"
node integrations/cindy-watcher/deploy.mjs preview --home "$RUNTIME" --database "$HOST_METADATA_DB" --id "$RELEASE_ID" --plan "$EXTERNAL_PLAN"
node integrations/cindy-watcher/deploy.mjs apply --plan "$EXTERNAL_PLAN"
```

`preview` 在 home 尚无 `state/` 时会自动 bootstrap。`verify` 不带 `--home` 只检查源码 manifest 闭包。

## 验证

```sh
node --test integrations/cindy-watcher/*.test.mjs
node --test integrations/mivo-watcher/*.test.mjs
node scripts/run-tests.mjs
node integrations/cindy-watcher/deploy.mjs verify
```

## 归属查询

```sh
node integrations/cindy-watcher/bin/cindy-ownership.mjs --repo makecindy/cindy --pr 5307 [--home "$CINDY_WATCHER_HOME"]
node integrations/cindy-watcher/bin/cindy-ownership.mjs --repo makecindy/cindy --session-id <id> [--home "$CINDY_WATCHER_HOME"]
```

home 解析：`--home` > `CINDY_WATCHER_HOME` > Cindy 仓 `_ops/cindy-watcher`（取第一个存在 `state/` 的）。
