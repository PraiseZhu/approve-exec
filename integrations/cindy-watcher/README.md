# Cindy PR 盯梢修复工具

此目录是 Mini 盯梢消费者的 Cindy 仓副本。独立复制自 `integrations/mivo-watcher/`（v2：发现器内联轮询 + 每 PR 专属修复 session），**不得改 mivo-watcher 源码**。扫描当前登录用户在 `makecindy/cindy` 的 open PR；head 在 fork 上时由独立 session 修审查反馈与 CI，直到 `awaiting-maintainer-approval`，并继续轮询到 MERGED/CLOSED。

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
| 自动 resolve | 可信来源 P2/P3 | 仅当 thread **全部评论**都是可信 Bot 且都定级 P3；有人类评论或 P0/P1/P2 不关。已 resolve 视为已处理（不授权改代码）。outdated 且未 resolve 的高优先级仍待处理，派工时要求先核实旧提交 |
| 停盯 | `mivo-watch:off` 标签 | `config/optout.json` 或作者本人 issue comment 正文恰为 `/cindy-watch off` |
| CI 失败 | 可 `gh run rerun` | 不许 rerun；相关则修；flaky/外部则每 head SHA 最多一次 `git commit -s --allow-empty` |
| 验证 | `.githooks/pre-push` | cindy 预检脚本，禁止 skip；待推送 commit 必须 `Signed-off-by` |
| 冲突 | `git merge origin/main` | `git fetch upstream main` 后 merge 进 PR 分支再 push fork |

可信审查来源：`greptile-apps` 与 `github-actions[bot]`。GraphQL `Bot.login` 不带 `[bot]` 后缀，按 `__typename=="Bot"` 归一后再比较。

已处理判据：thread 已 resolve 视为该 thread 反馈已处理，不授权改代码（混合 P1+P3 不会被盯梢自动 resolve，因此 resolve 只可能来自人工/作者）。fresh 的 identity key 不含 isResolved；unresolved→resolved 不派工，resolved→unresolved 的高优先级才重新待处理。评论 SHA 用 originalCommit/commit oid，不改写为当前 head。

## 运行参数

环境变量前缀 `CINDY_WATCHER_*`（`HOME` / `LIVE` / `ENABLED` / `DISPATCH` / `MODE` / `PR` / `NODE_ID`），另：`CINDY_NODE_BIN`、`CINDY_WATCHER_REPO`、`CINDY_WATCHER_BRIDGE`、`GH_BIN`。

| 项 | 默认 |
|----|------|
| runtime home | `/Users/praise/AI-Agent/Claude/projects/Project CINDY/_ops/cindy-watcher` |
| 本地仓 | `/Users/praise/AI-Agent/Claude/projects/Project CINDY` |
| PR 工作树 | `<仓>/.worktrees/watch/pr-<N>`（独立 clone，origin=fork） |
| 合并后备份 | `<仓>/_backup/` |

运行时必须显式设置 `CINDY_WATCHER_HOME`。不得在本目录执行 live watcher 或存放 state、worktree、DB、日志、凭证。

## 发现器（唯一调度）

发现器：`workingDir` = Cindy 本地仓，cron `*/5 * * * *`，timeout 180s，command `cindy-watch-script.py --mode discover`，`executionMode` `script`，`capabilities` `["sessions.dispatch"]`。修复 session 的模型继承发现器调度（`providerId=xd`，`model=openai/gpt-6-luna`，界面「Cindy AI」，`effort=max`）；sessions.dispatch 不带 model/effort/providerId。

- 已绑定 PR：发现器每轮做一次 GraphQL 指纹比对，不变即跳过；变化才全量采集、投递给该 PR 的 session。投递失败且 session 已归档/不存在时建接班 session。
- **没有每 PR 调度**：修复 session 不建、不绑、不删任何调度；首次投递回执即认领（`claimedAt`）。
- PR 合并后由脚本清理 watch clone（合并前确认干净，未并入 main 的提交先打 bundle 备份）；关闭未合并、工作树不干净或旧调度遗留时写入 `closedownManual`，等人处理。
- 省 token：全部反馈都是 P3 reply-only 或基础设施时脚本直接记 no-change，不派 session；Greptile 5/5 总结不算发现项；派工提示词要求收口后立即结束回合、不自行等待维护者审批，反馈正文去标记限长，PR 快照写入 task 文件 `prSnapshot`。
- watch clone 用 `git clone --reference-if-able <Cindy 本地仓>` 复用本地对象，clone 超时 15 分钟。

`--mode poll --pr <N> --node-id <id>` 仍可手动单跑一个 PR（排障用），不再由调度触发。

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

## 回执推进与反馈验收

每 PR 轮询的快速跳过条件同时检查 GitHub 指纹与本地结果回执。新回执、损坏/归属不符的回执，以及尚待 CI 重查的任务不能因 GitHub 无变化而被跳过；已消费的完成回执仍可走空闲快速路径。

待维护者审批之前，必须没有尚未处理的授权反馈：普通 issue comment 和 `COMMENTED` review 正文中的可信 P0/P1/P2 与行内讨论一样会派修。游标已消费但 owner 尚未交回结果时仍算在途，保留有界恢复；完成回执消费后不重复派。P3、未知来源、已解决讨论的权限边界不变。

`poll-progress.test.mjs` 覆盖这些推进/权限/去重场景。`repair-lifecycle.test.mjs` 贯通发现、绑定、准备、预检失败、代码修复、DCO、推送、等待 CI、复查、回执消费与清理；Git/脚本/文件操作是真实执行的临时本地仓操作，GitHub API 与 Host dispatch/scheduler 为受控 fixture，不能冒充真实云端或模型执行验收。

## 运行锁

`state/locks/<name>.lock` 始终在 canonical 路径上（PR 状态锁、`helper-pr-<N>`、全局 helper、`deploy.lock` 共用同一套实现）。内容是 JSON `{pid, token, createdAt}`；旧格式 `pid timestamp token`（空格分隔）仍按 pid 存活判断，同 token 可重入/释放。两种格式都解析失败时才用 mtime 宽限（60s）。

过期接管：`mkdirSync(<name>.lock.reclaim)` 拿守卫（EEXIST 即 busy，**锁层从不自动删除别人的守卫**）。持守卫后重读确认仍是同一份 stale 字节才 `unlink` 再 `wx`。锁文件不会被搬走。

不自动清守卫的原因：A 看到旧守卫已死、B 删掉它、C 建了新守卫、A 再把 C 的活守卫删掉，B 和 C 会同时持锁。fail-closed：看见守卫就 busy；owner 已死时原因是 `reclaim-guard-orphan:<lockName>`。

孤立守卫何时出现：reclaimer 在 `unlink` 之后、`wx` 之前崩溃。守卫只保护「删除 stale 文件」这一步；canonical 已不存在时正常 `wx` 不受守卫影响，盯梢能继续跑。部署只把 **owner pid 仍存活** 的守卫当成锁活动；死守卫不挡部署，但 verify/preview/apply 和 discover 结果会列出 `orphanGuards`。它只挡该锁的 stale 接管。

人工清理：

```sh
node integrations/cindy-watcher/bin/cindy-repair.mjs lock-doctor --home "$CINDY_WATCHER_HOME"
node integrations/cindy-watcher/bin/cindy-repair.mjs lock-doctor --home "$CINDY_WATCHER_HOME" --clear-guard discover
```

`--clear-guard` 先 `wx` 独占 `state/locks/maintenance.lock`（JSON `{pid, token, createdAt}`，**不做 stale 回收**）。已存在则拒绝并打印持有者，提示确认没有清理在跑后手工删除该文件。持锁期间才检查+删除守卫，finally 只在 token 匹配时释放。因此重叠 `--clear-guard` 不可能同时删守卫。`maintenance.lock` 只要文件存在，部署扫描就拒绝。`--clear-guard` 仍仅当守卫 owner pid 已死且 mtime 超过 10 分钟才删。

## 归属查询

```sh
node integrations/cindy-watcher/bin/cindy-ownership.mjs --repo makecindy/cindy --pr 5307 [--home "$CINDY_WATCHER_HOME"]
node integrations/cindy-watcher/bin/cindy-ownership.mjs --repo makecindy/cindy --session-id <id> [--home "$CINDY_WATCHER_HOME"]
```

home 解析：`--home` > `CINDY_WATCHER_HOME` > Cindy 仓 `_ops/cindy-watcher`（取第一个存在 `state/` 的）。
