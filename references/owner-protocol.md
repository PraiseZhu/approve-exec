# Skill-only owner 推进协议

本协议随完整 handoff 发送。只用已有 Cindy 工具；不修改宿主、不重启桌面。以下脚本都来自同一个 approve-exec skill 目录，不执行另一份旧副本。

## 派窗前（lead 的编排工作）

1. 只读 sub 对每条 SC 查现场，产出 site-report.json：manifest_core_hash、per_sc[{sc_id,group_id,real_write_paths,read_only}]、cross_sc_edges[{from,to}]、open_unknowns。from 是前置 SC，to 是依赖者。无写入只能明确 read_only=true；未知问题必须先裁决，不能默认为无依赖。
2. site-check.mjs --manifest <final> --site <报告>。共享写路径或依赖顺序不符时回 task-priority 重新出 final；不在 lead 当前窗口偷偷改 allowed_paths。相同波可并行，跨波必须满足现有 ledger 的前波集成与基线闸。
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
- 真实读取自己的 goal skill 后，执行随包给出的 owner-gate.mjs goal 命令。脚本重算文件 hash、检查干净基线、CAS 入账 gate_goal 并推进 executing。不得补造已有改动之前的开工证据，不用 jump 等逐步放行。
- 自主完成本 PR 的 SC。可以开只读 sub 获取信息，也可提前派 tester/reviewer 验证。提前验证不能替代最终当前提交的全量 SC/e2e/review。
- 首次及每次重新派 worker 前，现读共享 routing.json，执行 start_team({worker_permission_mode:"bypassPermissions"}) 并确认实际返回。用 owner-gate.mjs routing --owner-model <当前模型ID> --team-result <真实工具结果JSON> 连同台账/组/时间入账。脚本输出当前 e2e/review 档；agent、model、effort、provider_id 原样传给 Orca。GPT owner 使用 review.when_lead.gpt（存在时）。配置缺项或 auto 不得冒充通过。
- 本机测试红、review 未解决项，先 owner-gate.mjs rework --ledger <台账> --group <组> --reason <失败证据> --now <时间>，保留同一 session/branch/base 并使旧候选与验收失效，再在授权路径内修复重测。交给 Mini 后禁止本机重做。新链路不用旧 run 级 phase=ready 提前冻结各 PR。429 按 Retry-After 在原路由等待；只有 NO_PROVIDER_FOR_AGENT、PROVIDER_ROUTE_UNAVAILABLE、BUDGET_MODEL_REQUIRES_API_MODE 才允许依共享 fallbacks 降级。创建结果未知先查原 worker，不重复建；queued 表示已入队，不重发消息。
- 每次等待保留原任务 ID、状态、已尝试动作和下次唤醒条件；使用当前工具的等待/回执机制。无等待能力时如实报能力缺失，不能声称有后台自动唤醒。连续三轮无新证据，或授权/SC/接口/跨 PR 依赖改变，只发一个 DECISION_REQUIRED。停止的是受阻动作，不是宣布任务完成。

## 一个 PR 的验收与接手

1. 同一 owner 走 executing→e2e→review，提交本组 candidate（record-delivery）。提交内 branch、tip_sha、scs、goal_skill_path、e2e、review、size_gate、fallbacks_tried 按渲染器第10段 schema；最终证据必须绑定同一提交。
2. lead 只判断这颗 PR 的证据是否满足原 SC、优先级和授权；通过则 accepted。不通过给一份集中意见，由同一 owner 修复。candidate 不是完工，禁止另开 verify session 接走责任。
3. owner 对本组运行 ready-check.mjs --group <组> --ledger <台账> --manifest <final> --repo <本组worktree> --verdict <真实SC验收JSON> --e2e-report <真实报告> --presubmit-dir <size/format/intent目录> --receipt <输出路径> --now <当前ISO时间>。成功是 LOCAL_PR_VALIDATED；note-event local_validated --detail 的 group_id/receipt 消费这份回执。其它组尚未完成不阻塞本组。
4. owner 提交/推送/开对应非 draft PR，运行 confirm-pr-open.mjs --repo <owner/repo> --branch <branch> --head <已验收SHA> --now <当前ISO时间> --ledger-version <当前版本> --assignment-seq <本组代次>；真实 stdout 给 accepted→pr-open 的 --pr-open-receipt。
5. 重新运行 confirm-pr-open 获取新鲜 OPEN/非draft/head 回执，再 note-event pr_ready，detail 为 group_id、pr_url、current_pr_head_sha、receipt。回执必须晚于 pr_opened，五分钟内。PR Ready 的含义是“本机完成且可交给 Mini”，不是云端反馈已全部处理完。
6. lead 仅对这颗 Ready PR 发 Mini：confirm-watch-registered.mjs 按配置注册，再读 Mini takeover 首扫心跳。TAKEOVER_PENDING 时只等待/复查接手，保留本机现场；不替 owner 写代码、不因另一颗 PR 未完成而拖住它。
7. watch_registered 要有本 PR Ready 之后、十分钟内、同配置的有效首扫心跳。Mini 每 PR 一个持久 session，首次有反馈 create，以后只 jump；没有反馈时保持零 LLM 轮询。Mini 负责后续 GitHub CI/review 修复，本机 owner 不再同时写该 PR。
8. 接管确认后 owner 才 wrapup-cleanup（不删远端分支），lead archive_sessions 并消费真实归档回执。GitHub 合入另需用户授权；本任务 skill 不自动 merge。

## 保证边界

这是 T1 skill 脚本检查：防意外错派、重复恢复、过期证据、误清现场；不能阻止拥有同一文件权限的 agent 故意手改台账，也不能证明 LLM 阅读过程。只读 sub 不替代正式 tester/reviewer。bypassPermissions 仅是 worker 工具权限模式，不扩大任务允许的文件、动作或用户授权。
