# PR 盯梢修复工具

此目录是 Mini 盯梢消费者的唯一可维护源码。放在 approve-exec 工具仓仅表示版本管理归属，**不要求 PR 由批准执行 skill 创建**。它独立扫描当前登录用户在目标仓的 open PR，满足本机交付准入后由同一 PR/session 接手；不依赖手动 handoffReleased。

本机 owner 做到 push、当前 CI 绿并满足审查入口后交接。Mini 复用唯一 session 修后续反馈、CI 和冲突，直到生产公开审查协议判定整体通过。helper 的 complete 仅表示一轮修复完成；不会合并 PR、自动合并，也不会修改审查机 workflow 或配置。

旧治理根的运行文件软链只供源码引用，不作旧CLI兼容保证；执行watcher/repair使用这里或Mini runtime的真实路径。只有旧`deploy-watcher.mjs`入口明确支持软链调用，参数改为下述verify/preview/apply。

`bin/` 现为 v2：发现器 + 每 PR 轮询脚本 + 每 PR 状态文件（`state/prs/<nodeId>.json`）。旧单文件 `state/state.json` 只做一次性迁移，不改写。发现器每 5 分钟列本人 open PR，给未绑定且准入的 PR 建专属 session；已绑定 PR 只看心跳。每 PR 轮询脚本由该 session 自己 `schedule_create`（script 模式，禁止 `silentWhenIdle`），5 分钟只扫这一个 PR。工作树落在插件仓 `<P>/.worktrees/watch/pr-<N>`。原治理目录父级源码与旧部署脚本不再是维护入口；历史 release/备份仅供取证和回滚。

验证：

```sh
node --test integrations/mivo-watcher/*.test.mjs
node scripts/run-tests.mjs
```

源码与运行态分开。不得在本目录执行 live watcher 或存放 state、worktree、DB、日志、凭证、实际部署计划和原始备份。默认 runtime 示例：`/Users/praise/AI-Agent/Claude/projects/Project Mivo Canvas-Plugin/_ops/mivo-watcher`（即插件仓根 `P` 下 `_ops/mivo-watcher`）。运行时必须显式设置 `MIVO_WATCHER_HOME`。发现器调度：`workingDir=P`，command `... mivo-watch-script.py --mode discover`，cron `*/5`，timeout 180s。每 PR 轮询由修复 session 用 `mivo-repair.mjs schedule-params` 生成参数后 `schedule_create`。

唯一新部署入口 `deploy.mjs`：先保存显式目标的 preview，审核后 apply；使用源/目标/状态 hash CAS、session idle 只读核对、租约、唯一备份、失败原子回滚。不会写 Host 数据库或调度。持锁时等待 watcher 正常释放，不强抢；unknown/stale lease 由既有 watcher 处理。

```sh
node integrations/mivo-watcher/deploy.mjs verify --home "$RUNTIME"
node integrations/mivo-watcher/deploy.mjs preview --home "$RUNTIME" --database "$HOST_METADATA_DB" --id "$RELEASE_ID" --plan "$EXTERNAL_PLAN"
node integrations/mivo-watcher/deploy.mjs apply --plan "$EXTERNAL_PLAN"
```

部署须在目标机器运行，源包来自审核过的 Git commit；preview文件放runtime外的已批准运维目录。复制源码包时包含整个目录但不复制任何运行态。当前版本仅补版本管理，**本次不重新部署**。live watcher SHA `7b10d4b45667b126a1876f9fe9cf8d1109f31d075fe76184ed42d337295c8c1d`，snapshot SHA `b65a36b6846acb9c300f51c330ef3bb07d15e51ae97c140e4019e7bf2443b006`。

## watcher session 归属查询

只读 CLI，不写盘、不调 gh/ssh。按 PR 号或 session id 查 Mini watcher 台账里谁是该 PR 的专属修复 session：

```sh
node integrations/mivo-watcher/bin/mivo-ownership.mjs --repo xindong/mivo-canvas-plugin --pr 790 [--home "$MIVO_WATCHER_HOME"]
node integrations/mivo-watcher/bin/mivo-ownership.mjs --repo xindong/mivo-canvas-plugin --session-id <id> [--home "$MIVO_WATCHER_HOME"]
```

命中输出一行 JSON（`owned:true`，含 `sessionId` / `scheduleId` / `status` / `dispatchConflict`）；未命中 `owned:false`；台账不可读退出码 3。`closed` 只反映台账 `closedHandled`，不访问网络；归档闸在 `closed:true` 时另用 `gh pr view` 核实当前不是 OPEN。home 解析：`--home` > 环境 `MIVO_WATCHER_HOME` > 插件仓 `_ops/mivo-watcher` > 旧 Mini Automation 路径（取第一个存在 `state/` 的）。

任何批量归档或清理会话的操作，应先对候选 session 逐个跑 `mivo-ownership.mjs --session-id`；命中且 PR 仍开（`closed` 不是 true）的不要归档。approve-exec 清场前用 `confirm-session-archived.mjs --precheck --session-id <id>` 做同一道闸。

已观测的三次自然调度09:20/09:30/09:40均success约120秒；回执消费、尾部优先续扫及#595新反馈复用原session已验证。审查未通过仍保持waiting/blocked，不把这些运行证据当作所有PR已通过。
