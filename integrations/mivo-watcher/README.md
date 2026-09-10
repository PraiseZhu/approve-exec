# PR 盯梢修复工具

此目录是 Mini 盯梢消费者的唯一可维护源码。放在 approve-exec 工具仓仅表示版本管理归属，**不要求 PR 由批准执行 skill 创建**。它独立扫描当前登录用户在目标仓的 open PR，满足本机交付准入后由同一 PR/session 接手；不依赖手动 handoffReleased。

本机 owner 做到 push、当前 CI 绿并满足审查入口后交接。Mini 复用唯一 session 修后续反馈、CI 和冲突，直到生产公开审查协议判定整体通过。helper 的 complete 仅表示一轮修复完成；不会合并 PR、自动合并，也不会修改审查机 workflow 或配置。

旧治理根的运行文件软链只供源码引用，不作旧CLI兼容保证；执行watcher/repair使用这里或Mini runtime的真实路径。只有旧`deploy-watcher.mjs`入口明确支持软链调用，参数改为下述verify/preview/apply。

`bin/` 十个文件逐字节来自 2026-09-10 已验收 live。包含120秒有界续扫、回执先落盘、公平游标、公开 APPROVE/SKIP 校验和唯一 session 交付。原治理目录父级源码与旧部署脚本不再是维护入口；历史 release/备份仅供取证和回滚。

验证：

```sh
node --test integrations/mivo-watcher/*.test.mjs
node scripts/run-tests.mjs
```

源码与运行态分开。不得在本目录执行 live watcher 或存放 state、worktree、DB、日志、凭证、实际部署计划和原始备份。运行时必须显式设置 `MIVO_WATCHER_HOME` 到已批准的项目二级 runtime；Cindy 现有调度使用该 runtime 的 `bin/mivo-watch-script.py`，不改变其180秒上限。

唯一新部署入口 `deploy.mjs`：先保存显式目标的 preview，审核后 apply；使用源/目标/状态 hash CAS、session idle 只读核对、租约、唯一备份、失败原子回滚。不会写 Host 数据库或调度。持锁时等待 watcher 正常释放，不强抢；unknown/stale lease 由既有 watcher 处理。

```sh
node integrations/mivo-watcher/deploy.mjs verify --home "$RUNTIME"
node integrations/mivo-watcher/deploy.mjs preview --home "$RUNTIME" --database "$HOST_METADATA_DB" --id "$RELEASE_ID" --plan "$EXTERNAL_PLAN"
node integrations/mivo-watcher/deploy.mjs apply --plan "$EXTERNAL_PLAN"
```

部署须在目标机器运行，源包来自审核过的 Git commit；preview文件放runtime外的已批准运维目录。复制源码包时包含整个目录但不复制任何运行态。当前版本仅补版本管理，**本次不重新部署**。live watcher SHA `7b10d4b45667b126a1876f9fe9cf8d1109f31d075fe76184ed42d337295c8c1d`，snapshot SHA `b65a36b6846acb9c300f51c330ef3bb07d15e51ae97c140e4019e7bf2443b006`。

已观测的三次自然调度09:20/09:30/09:40均success约120秒；回执消费、尾部优先续扫及#595新反馈复用原session已验证。审查未通过仍保持waiting/blocked，不把这些运行证据当作所有PR已通过。
