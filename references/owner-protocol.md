# Skill-only owner 推进协议

本协议随完整 handoff 发送。只用已有 Cindy 工具；不修改宿主、不重启桌面。以下脚本都来自同一个 approve-exec skill 目录，不执行另一份旧副本。

## 派窗前（lead 的编排工作）

1. 只读 sub 对每条 SC 查现场，产出 site-report.json：manifest_core_hash、per_sc[{sc_id,group_id,real_write_paths,read_only}]、cross_sc_edges[{from,to}]、open_unknowns。from 是前置 SC，to 是依赖者。无写入只能明确 read_only=true；未知问题必须先裁决，不能默认为无依赖。
2. 新版先按文末显式归属表建账，再运行 site-check.mjs --ledger <台账> --site <报告>，报告另带 execution_plan_hash；旧版继续 --manifest <final>。共享写路径或依赖顺序不符时回 task-priority 重新出 final；不在 lead 当前窗口偷偷改 allowed_paths。相同波可并行，跨 PR 的波必须满足现有 ledger 的前波集成与基线闸，同 PR 内部阶段不等待合并。
3. 给每 PR 准备独立 worktree、准确 base/branch，写 pending identity。渲染 0–10 完整包；不可只发摘要。摘录带文件指纹，prepare 时重新核对。新增文件仍要在包里说明相关现有接口。
4. 执行 owner-dispatch.mjs prepare --ledger <绝对路径> --group <组> --handoff <包文件> --site <报告> --now <当前ISO时间>。脚本只发放一次 create 请求：返回 action=create_once 时，把 args 原样交给现有 send_to_session 工具且只调用一次。action=resume 只处理已返回的 session_id，不再 create。
5. 真实工具结果保存到任务目录，执行 owner-dispatch.mjs bind --ledger <同一台账> --group <同一组> --claim-id <prepare返回值> --result <工具JSON> --now <当前ISO时间>。不凭标题猜 ID，不手写成功结果。工具结果已保存时可重复 bind；未知结果保留 claim 并上报唯一决策，不自动删 claim、换代或换目录绕过。
6. get_session_runtime → 必要时 set_session_runtime(provider_id=art, expected_generation=刚读值) → 再 get_session_runtime 确认。模型/权限切换遵守工具本身的授权，不穿透确认。
7. 对已绑定身份重新 render-packet，再用 mem-probe 的真实快照推进 pending→dispatched。这是元数据入账，不是重新生成任务或第二次派窗。owner 可能先启动；它读本组状态等待这一小段登记，不问 lead 是否开工。

prepare 使用台账路径旁固定的 .owners 目录。持久 claim 的作用是“一次外部调用”，不是宿主事务。没有结果时不能区分“尚未创建”和“创建成功但回执丢失”；因此暂停该 PR，不影响其它独立 PR。恢复只认原工具结果，经 bind 完成，不自动扫描会话标题后猜测关联。

确需替换已知 owner 时，lead 先裁决并归档旧 session，把真实 archive_sessions JSON 交给 owner-dispatch.mjs retire --ledger <台账> --group <组> --claim-id <原claim> --result <归档工具JSON> --now <时间>。随后按原台账重派规则增加 assignment_seq、重新核现场及出包，才能 prepare 新一代。未知 create 不得 retire；同一 owner 的域内修复用 rework，不用换代。

## owner 收到包后

正文已列出 SC、优先级、写入范围、基线、文件指纹与改法；消费它们，不重新做整轮规划。必要的定点读文件和调试仍允许，不应把“不重复规划”误读成“不能看代码”。

- 先核自己的 runtime 与 ledger.session_id、worktree、branch、base；确认 Art、完整包身份无误。绑定或 dispatched 登记尚未到达时，读台账等待，保留该 owner；不要写代码或重复派窗。
- 真实读取自己的 goal skill；新版先执行文末 owner-gate.mjs baseline，通过后再执行随包给出的 owner-gate.mjs goal 命令，旧版不补造 baseline。脚本重算文件 hash、检查干净基线、CAS 入账 gate_goal 并推进 executing。不得补造已有改动之前的开工证据，不用 jump 等逐步放行。
- 自主完成本 PR 的 SC。可以开只读 sub 获取信息，也可提前派 tester 验证。提前验证不能替代最终当前提交的全量 SC/e2e。本地禁止派 reviewer。
- 首次及每次重新派 worker 前，现读共享 routing.json，执行 start_team({worker_permission_mode:"bypassPermissions"}) 并确认实际返回。用 owner-gate.mjs routing --owner-model <当前模型ID> --team-result <真实工具结果JSON> 连同台账/组/时间入账。脚本输出当前 e2e 档；agent、model、effort、provider_id 原样传给 Orca。只派 tester（e2e 档），禁止派 reviewer。配置缺项或 auto 不得冒充通过。
正常 owner 不因 PR Ready 停写；只有真实 Mini 接管后才禁止本机重做。
- 每次等待保留原任务 ID、状态、已尝试动作和下次唤醒条件；使用当前工具的等待/回执机制。无等待能力时如实报能力缺失，不能声称有后台自动唤醒。连续三轮无新证据，或授权/SC/接口/跨 PR 依赖改变，只发一个 DECISION_REQUIRED。停止的是受阻动作，不是宣布任务完成。

## 一个 PR 的验收与接手

1. 同一 owner 走 executing→e2e→review，提交本组 candidate（record-delivery）。提交内 branch、tip_sha、scs、goal_skill_path、e2e、size_gate、fallbacks_tried 按渲染器第10段 schema；最终证据必须绑定同一提交。组状态名 `review` 只是本机验收前检查点，不再表示本地 GPT/Claude 单审。
2. owner 自主完成原 SC、优先级和已授权收尾，不逐步回 lead 请示。lead 在本机交卷完成后对该 PR 的全部 priority/SC、e2e 与当前 head 作独立验收；无验收不得发 Mini 信号。
3. owner 对本组运行 ready-check.mjs --group <组> --ledger <台账> --manifest <final> --repo <本组worktree> --verdict <真实SC验收JSON> --e2e-report <真实报告> --presubmit-dir <size/format/intent目录> --receipt <输出路径> --now <当前ISO时间>。成功是 LOCAL_PR_VALIDATED；note-event local_validated --detail 的 group_id/receipt 消费这份回执。其它组尚未完成不阻塞本组。
4. owner 提交/推送/开对应非 draft PR，运行 confirm-pr-open.mjs --repo <owner/repo> --branch <branch> --head <已验收SHA> --now <当前ISO时间> --ledger-version <当前版本> --assignment-seq <本组代次>；真实 stdout 给 local_validated→pr-open（accepted 仅兼容旧台账） 的 --pr-open-receipt。
5. 重新运行 confirm-pr-open 获取新鲜 OPEN/非draft/head 回执；Mivo 还必须证明当前提交必需 CI 全绿。随后 note-event pr_ready，表示本机可交接。审查机结论不在本机继续等待。
6. 对应任务 lead 验收通过后，立即派 native cleanup sub，不再铸造 Mini lead signal / register。
7. Mini Cindy 常驻程序以 PR nodeid 维护唯一修复 session，title 为 `{项目名}-{任务名}丨修复丨YYYY-MM-DD`；本协议不创建第二个 session。
8. wrapup-cleanup --mode delivered-local-only 只清本地（不删远端分支），成功后 lead archive_sessions 并消费真实归档回执。GitHub 合入另需用户授权；本任务 skill 不自动 merge。

## lead 发信号与 Mini 接收

lead 先调用 Cindy 的 get_session_runtime({})，不指定其他 session，把真实非敏感回执保存为本任务 sender-runtime.json。PI、Claude 和 Codex 共用这一入口；Codex 也可使用宿主 CODEX_SESSION_ID，但它必须与原派工记录中的 lead ID 相同。脚本核对原 owner claim 的 handoff、request hash、owner session、代次和当前全部验收证据；自报 role=lead 不成立。

完成本机验收后，lead 执行以下命令。signal.json 保存原始输出；重试使用同一份，不按新时间重复铸造。

```bash
node scripts/pr-watch/lead-signal.mjs --ledger <ledger.json> --group <group_id> --lead-session-id <真实lead_ID> --sender-runtime <sender-runtime.json> --now <当前ISO时间> > <signal.json>
node scripts/confirm-watch-registered.mjs --ledger <ledger.json> --group <group_id> --lead-signal @<signal.json> --sender-runtime <sender-runtime.json> --owner <owner> --repo <repo> --pr <number> --branch <branch> --now <当前ISO时间> --ledger-version <当前版本> --assignment-seq <当前代次>
```

信号只授权当前 PR 的普通 push 和当前 PR 内回帖，不授权合并、自动合并、启用 auto-merge、调用 gh pr merge、force push、删远端、扩写入范围或处理其它 PR。只有用户对指定 PR 的当次明确授权才允许合并；PR Ready、cloud_ready、required checks 通过或管理员权限均不构成授权。远端 OPEN/非 draft/head 的确认必须在铸造信号前五分钟内；缺旧任务原始 claim 或验收证据时不自动补造授权。

Mini 收到反馈后按投递包先准备 PR worktree，提炼反馈 SC，把绑定 dispatch_id/session_id/head_sha 的 SC JSON 放到该名册的 receipts 子目录，再执行 ack-received。SC id 必须精确覆盖全部反馈 id、CI 红与冲突；该 ack 仅表示收到 SC，不表示修复完成。核到实际文件后才推进反馈游标；host 的 target_session_id、queued、success 均不等于已接收 SC。结果未知保留原 outbox，绝不自动重复 create。

全部 SC PASS 后另存完成输入，不覆盖原 SC 接收文件。使用本 skill 的 scripts/pr-watch/finalize.mjs --state-dir <名册> --owner <owner> --repo <repo> --pr <pr> --session-id <Mini身份> --dispatch-id <本次ID> --feedback-head <派发SHA> --receipt @<SC-PASS输入路径>；它核验真实 HEAD、干净分支、push remote、OPEN 非 draft PR 和精确 SC 集合后才普通 push，并生成 receipts/<dispatch_id>.post-fix.json。不得手写该输出。再通过 session-watch.mjs ack-post-fix --head <完成SHA> 消费同一完成回执，清除 post_fix_pending。合法无需改码允许同一 head/no_changes:true，不造空 commit。

云端可合并必须同时满足全部真实 snapshot 门禁、mergeable=true、没有新反馈、没有待确认修复；新 head/新反馈/CI 红/取数失败使旧标记失效。生产调度启动前校验 config 中的 Mini hostname，本机即使误启动相同脚本也不能派发。始终不自动合并。

这是 T1 流程约束和可追溯记录，不是密码学认证：同一 OS 用户能改源码或伪造本地文件，脚本无法阻止主动绕过。不将内容 hash 称为签名，不将夹具测试称为真实跨机模型运行。

## 显式 PR 归属与阶段

阶段式 final 必须先提供独立归属表，例如：

```json
{
  "schema_version": "pr-map-v1",
  "source_manifest_core_hash": "原 final 的 64 位 core hash",
  "prs": [{ "pr_id": "PR1", "source_groups": ["p1", "g1", "v1"] }]
}
```

示例归属只能在已明确批准这些组属于 PR1 时使用；不以组名、priority_id 或同文件写入推断归属。每个源组和 SC 必须恰好出现一次。六份已确认的业务计划分别建账，每份的三个阶段映射到一个 PR，合计六个 owner，不是十八个。

- `run-ledger.mjs init --manifest <原final> --pr-map <归属表> --ledger <新台账> --run-id <id> --now <ISO> --baseline <SHA>`：生成 pr-ledger-v2；不得覆盖已有台账。原 final 与原回执继续按原 hash 校验，转换视图不携带原回执。
- `site-check.mjs --ledger <新台账> --site <报告>`：报告绑定 manifest_core_hash 和 execution_plan_hash；per_sc.group_id 使用业务 PR，路径按原阶段授权检查。probe 为只读。跨 PR 依赖决定前后波，同 PR 依赖保留在内部。
- renderer 从台账出包，包含全部阶段、全部 SC、各阶段路径与验证命令，以及 execution_plan_hash。claim 同时绑定原计划和执行计划，恢复必须重读归属表；同一 PR 转阶段只继续原 owner。
- owner 在 dispatched 后先运行 `owner-gate.mjs baseline --ledger <台账> --group <业务PR> --now <ISO>`。脚本在原基线干净工作树逐项执行 probe.verify 的 cmd/args，无 shell，单条超时两分钟；前后 HEAD/branch/status 不符或任一失败即拒。记录结果码和输出 hash，不保存原始输出。之后才能通过 goal 开工闸进入实现。
- Ready 必须包含全部 probe/fix/verify SC 的 PASS 证据，不接受只有 fix 的交卷。新版执行单元按 git diff 的全部新增＋删除执行 size-gate：800 行起预警，1600 行起硬 STOP，包含测试；二进制无法计数时拒绝自动通过。验收回执额外绑定 execution_plan_hash。
- 旧台账保持旧版语义，不添加 pr_plan、不合并 owner、不修改 claim。发现旧任务已经派出会话或存在工作树时保留现场，单独裁决。尚未派出的阶段计划使用原 final 与独立归属表新建台账，不复用旧凭据。

## 保证边界

这是 T1 skill 脚本检查：防意外错派、重复恢复、过期证据、误清现场；不能阻止拥有同一文件权限的 agent 故意手改台账，也不能证明 LLM 阅读过程。只读 sub 不替代正式 tester。bypassPermissions 仅是 worker 工具权限模式，不扩大任务允许的文件、动作或用户授权。
