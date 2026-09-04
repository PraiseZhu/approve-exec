# 0904 批准执行问题终稿（Sol 裁决版）

日期：2026-09-05  
状态：Final decision / target contract  
实现状态：**尚未落地，不能据本文声称当前系统已经修好**  
适用范围：approve-exec 场景 C、goal 执行、PR 盯梢修复

## 1. 最终裁决

0904 的核心问题不是单纯“窗口开多了”，而是 **PR 的唯一责任主体、责任终点和 handoff 执行契约都没有闭合**。

最终目标必须是：

> 一个 PR 在任一时刻只能有一个活跃 owner session。它拿到通过机器校验的完整 handoff 后立即开工，自主完成实现、验证、提交、推送、开 PR、CI/review 修复，直到远端 PR 达到机器可证明的 PR Ready。candidate 只是中间检查点。lead 只读取证据、做取舍和裁决真正的例外，不替 owner 执行。

Grok 原 final 的事故事实和部分方向可以保留，但 **不能直接批准执行**，原因是它仍把 owner 的终点写成 candidate，并把 ready-check、开 PR、CI/review 跟进等执行工作交回 lead。

“session 不会自己停下来”在本终稿中的准确含义是：

- happy path 和所有可恢复失败中不得停、不得把普通问题问回 lead；
- 真正命中安全、授权、范围或事实矛盾时，可以进入 DECISION_REQUIRED；
- 进入 DECISION_REQUIRED 后 owner lease 仍保留，session 不算完成、不归档、不卸责；lead 只给决定，同一个 owner 随后继续。

## 2. 对 Grok final 的准确性判断

### 2.1 准确，可保留

1. **1 PR 应只有一个实现责任窗。** probe、verify、e2e、review worker 都不能成为第二个 PR owner。
2. **turn-by-turn 来回是流程问题，不是子 session 抗命。** gate_goal、gate_routing 被做成逐窗 jump，天然制造等待。
3. **0904 handoff 不充分。** 真实现场摘录、具体改法、逐 SC 验证命令和 exact receipt 样例不足。
4. **派发身份发生错配。** p1/SC417 使用了 probe-448 标题，p3/SC448 使用了 probe-417 标题。
5. **标题门禁过松。** 当前只校验“丨 MMDD”，没有把 title、group、SC、branch、handoff 绑定成同一身份。
6. **盯梢修复窗命名不一致。** Mini 上的 owner/repo#号 盯梢不符合“项目名-中文任务名丨 日期”。
7. **open_unknowns 没有正确 fail-closed。** #450、#461 与 host 落点仍存在会影响跨组关系的未知项时，不应直接全量 fan-out。
8. **candidate 后存在人工接力。** 现行 accepted、run ready、pr-open 链仍要求 lead 驱动，确实会把执行拉回 lead。

### 2.2 不准确或与用户目标冲突，必须改

1. 把 owner 的终点写成 candidate，而不是 PR Ready。
2. 让 lead 手动对 SHA、写台账、跑 ready-check、开远端 PR、追 CI/review。这些是执行，不是判断。
3. 一处要求 429、进程崩、创建失败立即停等 lead，另一处又要求走 fallback，停机口径互相冲突。
4. 同时写“1 PR=1 session”和“每 PR 再开盯梢 session”，却未区分 owner 与 observer。
5. 保留 gate_goal / gate_routing 的聊天放行；安全 gate 应保留，但不应要求 lead 逐窗搬运 receipt。
6. 把只读 probe 的 README.md 字段直接视为实际写冲突。allowed_paths、报告中的 real_write_paths 与真实写入不是一回事。
7. 暗示可以在 ledger init 后按新路径重拆。现有 manifest/core hash 已冻结，事后重拆会造成 HASH_MISMATCH 和双重分组真源。
8. 把 candidate SHA、集成后 PR head、CI/review SHA 强制写成同一个值。rebase、squash 或受控集成后 SHA 可能变化，必须校验内容谱系，而非假设哈希永远相等。

### 2.3 原 final 的关键遗漏

1. 一个 PR 只能有一个 active owner 的宿主级约束。
2. owner lease、epoch、心跳、崩溃恢复和原子 ownership transfer。
3. owner、worker、read-only sub、watcher、lead 的责任边界。
4. candidate 之后到 PR Ready 的 per-PR 状态机。
5. 当前 run-level ready 与目标 per-PR Ready 的迁移关系。
6. owner receipt 的宿主认证、CAS、版本校验、防重放和当前 attempt/head 绑定。
7. create gateway：真实 send_to_session 必须与 canonical handoff 原子绑定；当前 session-dispatch.mjs 只有 dry-run。
8. handoff 中对 git push、PR create/update、外部消息等动作的明确授权范围。
9. PR Ready 的唯一 schema，以及每项证据来自哪个检查器。
10. watcher 只观察、优先唤醒原 owner；不得静默创建第二 owner。
11. happy-path 的“lead 执行调用数为 0”验收。
12. 旧 ledger 不可原地套用新语义的版本化迁移。

## 3. 当前模型与目标模型必须分开

### 3.1 当前模型（事实）

当前实现大致是：

- group accepted：合法 candidate；SC/e2e/review/size 等 receipt 对齐，但还没有远端 PR URL。
- run phase=ready：需要 ready-check receipt、当前 ledger_version、最终集成 tip、全部组至少 accepted、所有 wave 按顺序 integrated。
- accepted → pr-open：还要求 run 已 ready，并消费 confirm-pr-open receipt。
- lead 负责开远端 PR、注册 Mini watch、清场和归档；merge 由人执行。
- session-dispatch.mjs 只做 dry-run，真实 create 仍由宿主 send_to_session 完成。
- watcher 当前绑定 session_id，没有 owner lease / epoch / transfer schema。

这些是现状，不满足用户目标。

### 3.2 目标模型（vNext）

vNext 新增 per-PR owner 状态，不直接篡改旧字段含义：

HANDOFF_VALIDATED  
→ EXECUTING  
→ LOCAL_VALIDATED  
→ CANDIDATE_SUBMITTED  
→ CANDIDATE_ACCEPTED  
→ PR_OPEN  
→ CI_REVIEW_LOOP  
→ PR_READY

run 另有聚合态：

ALL_PR_READY + 既有依赖/wave/integration receipt 全部通过  
→ RUN_READY

约束：

- per-PR PR_READY 是 owner 的责任终点。
- RUN_READY 是整批任务的自动聚合结果，不由 lead 手工推进。
- 当前 accepted 仍解释为本地 candidate accepted；不能直接改名冒充 PR Ready。
- 当前 run phase=ready 的旧顺序与 vNext 不兼容，必须升级 schema/version 和迁移代码。
- 旧 ledger 保持 legacy 语义，只读收尾；不得原地转换。
- vNext 只用于新建 run，除非有独立、可回滚的迁移工具和验证报告。

## 4. 唯一责任模型

| 角色 | 负责什么 | 明确不负责什么 |
|---|---|---|
| Lead | 决定 PR 拆分、优先级、SC、先后顺序；读取证据；裁决 DECISION_REQUIRED；决定是否交给人 merge | 不改代码、不跑测试、不执行 git/gh、不派实现 worker、不手工搬 receipt、不替 owner 开/修 PR、不追 CI/review |
| PR owner session | 从合法 handoff 到 PR Ready 的全部执行；持续持有责任 | 不把普通实现选择推回 lead，不在 candidate 后完成，不把 PR 责任转给 worker/sub |
| Worker | 在 owner 指定的窄任务内做实现、e2e 或 review | 不直接向 lead 汇报，不拥有 PR 生命周期，不自行扩大范围 |
| Read-only sub | 搜索代码、核规则、查证据、比较方案 | 不改产品代码，不成为第二 owner；结论只回 owner |
| Watcher | 监听 CI、review、冲突和远端状态并唤醒 owner | 只观察，不拥有 PR，不自行创建并行 owner |
| Host gateway / ledger | 验证 transport identity、lease、hash、CAS、receipt 和状态转换；原子入账 | 不做产品判断，不要求 lead 手工抄写状态 |
| 人 | merge；批准人类专属、缺授权或不可逆动作 | 不承担 happy-path 的日常推进 |

硬不变量：

- 同一 PR 任一时刻最多一个 active owner lease。
- worker、sub、watcher 都不是 PR owner。
- 所有执行结果只回 owner，不绕过 owner 交给 lead 接手。
- owner 只有在 PR_READY 后才能正常结束；DECISION_REQUIRED 只暂停推进，不释放 lease。
- 只有原子 transfer 可以更换 owner；旧 lease 必须先失效。
- lead 的 happy-path mutation / execution 调用数为 0。

## 5. vNext per-PR 状态机

### 5.1 状态与写入者

| 状态 | 进入条件 | 谁触发 | 谁确认 |
|---|---|---|---|
| HANDOFF_VALIDATED | canonical handoff、身份、授权、hash 全通过 | create gateway | host gateway |
| EXECUTING | owner 首轮自检通过并开始真实动作 | owner | host heartbeat |
| LOCAL_VALIDATED | SC、本地测试、e2e、review、repo policy gate 全绿 | owner 提交 receipts | deterministic validators |
| CANDIDATE_SUBMITTED | owner 提交当前 attempt 的 candidate | owner | host gateway |
| CANDIDATE_ACCEPTED | receipt、内容、head、SC 和 CAS 全通过 | gateway 状态迁移 | host gateway；不是 lead，也不是 owner 自批 |
| PR_OPEN | 已授权的 PR create/update 成功 | owner 调 API | host 校验 remote receipt |
| CI_REVIEW_LOOP | CI/review/mergeability 未达到 Ready | owner + watcher | 当前 PR head 的 remote receipts |
| PR_READY | 第 10 节全部通过 | owner 提交 pr_ready | host gateway + deterministic/remote receipts |

### 5.2 attempt 与内容谱系

每次影响 PR 内容的 commit、rebase、squash、cherry-pick 或冲突修复都必须：

- 增加 attempt_id；
- 更新 current_pr_head_sha；
- 使旧 CI/review/mergeability receipt 失效；
- 重新跑受影响的 SC/测试；
- 保存 source_candidate_sha → current_pr_head_sha 的 lineage。

若两个 SHA 相同，可直接绑定；若不同，必须由确定性检查器产出 content_equivalence_receipt，例如 tree hash、patch-id 或仓库认可的等值证明。不能只凭 owner 文字声明“内容一样”。

### 5.3 跨 PR 依赖

- 会改变 base、write set 或 SC 的上游依赖必须在创建下游 owner 前解决。
- final execution graph 明确 downstream_base_receipt 和可启动条件。
- 条件未满足时不提前创建 owner，避免造出只能空等的 session。
- PR Ready 之后若远端 head/base 又变化，旧 Ready 自动失效；watcher 唤醒原 owner，或在原 owner不可恢复时走原子 transfer。

## 6. handoff：创建前必须完整且不可错配

### 6.1 唯一生成链

目标链路：

task-priority + SiteScout  
→ final execution graph  
→ manifest/core hash  
→ ledger init  
→ canonical handoff render  
→ handoff validator  
→ host create gateway  
→ 唯一 owner

原则：

1. task-priority 提供优先级、SC、初始 paths/dependencies。
2. SiteScout 在 ledger init 前补足真实现场、write capability、依赖和冲突证据。
3. 二者共同编译出一个 final execution graph；该 graph 才是唯一分组真源。
4. graph/hash 冻结后，task-priority 和 approve-exec 都不得二次重拆。
5. read-only probe 不进入写冲突边；需要的证据应在创建 owner 前进入 handoff，或由 owner 的 read-only sub 获取。
6. lead 只批准拆分/优先级/SC 决策；renderer、validator、create 由工具执行。
7. validator 失败时不创建 session。
8. session-dispatch.mjs 不能单独完成此目标；必须增加或改造 Cindy host 的真实 create API。

### 6.2 create gateway 绑定

gateway 必须原子绑定：

- schema_version
- run_id / pr_key / group / 全部 SC
- repo / remote / worktree / base / branch
- 中文 title
- manifest_hash / execution_graph_hash / handoff_hash
- owner_session_id / lease_id / owner_epoch
- delegation_capabilities
- external_action_scope
- expected_ledger_version

宿主给 owner 一个不可伪造、不可跨 session 使用的 opaque capability。它只存在于受保护的 tool transport，不写进 handoff、日志或用户可见正文。

### 6.3 第一条消息

第一条消息必须包含：

- 完整 canonical handoff 正文；
- handoff_hash；
- 宿主注入的身份上下文。

文件路径可以作为 provenance，但不能成为唯一载荷，避免路径不可读导致再次停顿。

禁止：

- “先停着”
- “等 lead jump”
- 缩写包
- 只有路径没有正文
- “请重新理解任务”
- “是否开始”

owner 只做一次快速 hash/身份自检；通过后在同一轮执行第一个真实动作。

### 6.4 canonical 0–10

每段必须非空、互相一致、可机器校验：

0. **本地开工闸**：goal/routing/manifest/graph/handoff hash；本地验证、gateway 自动入账，不等 lead。
1. **唯一身份**：项目、repo、pr_key/group、SC、绝对 worktree、base、branch、中文 title、lease。
2. **为什么改**：用户目标、当前痛点、优先级、非目标。
3. **真现场证据**：至少一条 file + line + current behavior；不能写“本包未附摘录”。
4. **正确改法**：目标行为、关键接口、状态迁移、不变量；不得复制禁令充当改法。
5. **边界**：文件级 allowed_paths、read_only_paths、forbidden_paths。
6. **完整 SC**：id、change、holds、expect、anchor/write capability、依赖。
7. **验证矩阵**：每颗 SC 对应真实命令、预期结果、失败后循环；gh pr diff 不能代替测试。
8. **自主执行**：worker/sub 能力、routing、fallback、commit/push/PR/CI/review/watch 流程。
9. **授权与硬停**：external_action_scope、人类专属动作、DECISION_REQUIRED 条件。
10. **exact receipts**：progress、decision_required、candidate、pr_open、pr_ready JSON 样例。

### 6.5 创建前 fail-closed

以下任一项失败，不得创建 owner：

- 0–10 缺段、空段或 hash 不一致。
- title、group、SC、repo、branch、worktree 任一身份不一致。
- SC 没有真实验证命令。
- allowed_paths 不能覆盖既定改法。
- open_unknowns 会改变拆分、依赖、write capability 或授权。
- delegation_capabilities 不支持 handoff 要求的 worker/sub 路径，且无合法 fallback。
- external_action_scope 不足以完成约定的 push / PR lifecycle。
- 同一 pr_key 已存在 active lease。
- execution graph 在 ledger init 后被修改。
- host create gateway、CAS 或 attestation 不可用。

## 7. owner 的自主决策与 delegation

合法 handoff 和 external_action_scope 内，owner 无需请示即可：

- 选择满足 SC、架构约束和 allowed_paths 的具体实现。
- 读取相关代码、规则、测试和已授权证据。
- 派 read-only sub 查信息。
- 按实时 routing.json 派实现、e2e、review worker。
- 在允许的同代 fallback 内处理 429、provider 不可用和 worker 创建失败。
- 自己完成 worker/sub 无法完成但仍在权限内的工作。
- 修改、测试、commit、push 当前 feature branch。
- 创建/更新 handoff 明确授权的 PR。
- 修复 CI、e2e、review、size 或分支冲突，再重新验证。
- 注册 watcher，让远端事件回到同一 owner。
- 向 gateway 提交 receipt；owner 不直接写 ledger。

责任不能下放：

- worker/sub 只提交证据或变更给 owner。
- owner 亲自整合、复核，并对最终 attempt、内容谱系和 PR Ready 负责。
- worker 的 PASS 不能替代 owner 和 gateway 验证。
- 不另开 verify/probe/review session 作为第二责任窗。
- worker/sub 不向 lead 请示，也不把结果直接交 lead 收尾。

## 8. 不许自行停：恢复与 DECISION_REQUIRED

### 8.1 下列情况不得停

- candidate submitted 或 accepted。
- 等 CI、review、worker、sub 或 watcher 返回。
- 普通测试失败、CI 红、review unresolved > 0。
- 429、单 provider 失败、单 worker 创建失败。
- 进程崩溃、会话重启或网络短暂中断。
- 实现有多种可行方案。
- 需要读取更多代码或规则。
- 第一或第二轮修复没有增量。
- 需要 commit、push、创建或更新已明确授权的 PR。

这些情况必须由 fallback、heartbeat、resume 或 watcher 继续，不能问 lead“下一步怎么办”。

### 8.2 仅以下情况可进入 DECISION_REQUIRED

1. handoff/hash/身份自检不一致。
2. SC、架构约束或现场事实矛盾，继续做会改变已批准方案。
3. 必须写出 allowed_paths，且没有范围内替代。
4. 需要新的用户授权、凭证或外部权限。
5. 所有规定 fallback 已耗尽，或连续 3 个完整循环没有新证据/新进展。
6. 发现安全、隐私或密钥风险。
7. 遇到人类专属或高风险动作：
   - force push main/master
   - 删除远程分支或标签
   - 删除/清理数据库或生产数据
   - 提交密钥、token、密码
   - 发送 external_action_scope 未明确授权的不可撤回外部消息
   - 修改 CI/CD pipeline
   - merge PR

本终稿将连续 3 轮零增量明确设为预授权的防失控硬上限，而不是 owner 自行选择的停点。触发后不算任务完成：owner 保留 lease，状态变为 DECISION_REQUIRED，等待 lead 的一个决定后继续。

### 8.3 decision request

只能发送一条结构化请求：

- 卡在哪颗 SC、哪个 attempt/head、哪条证据。
- 已尝试的 fallback 及结果。
- 需要 lead 判断的唯一问题。
- 2–3 个互斥选项、影响和 owner 推荐。
- lead 决定后同一 owner 如何继续。

lead 只返回 decision。gateway 根据 decision 走重新规划、扩权申请或恢复流程；lead 不亲自改 manifest、跑命令或修代码。

## 9. Gate 保留，但改成可信自动入账

必须保留：

- manifest/handoff 输入完整性。
- SiteScout 依赖与写冲突 fail-closed。
- goal、routing、manifest、graph、handoff hash。
- allowed_paths、external_action_scope、身份与 lease。
- candidate schema、SC/e2e/review/size/content lineage。
- PR remote identity、CI、review、mergeability、repo policy。
- watcher 注册、ownership transfer、归档与清理 receipt。
- 安全、隐私、人类专属动作 gate。

vNext receipt 最少包含：

- schema_version / kind
- run_id / pr_key
- owner_session_id / lease_id / owner_epoch
- attempt_id / expected_ledger_version
- handoff_hash
- source_candidate_sha / current_pr_head_sha
- evidence references
- checked_at
- host_attestation

写入规则：

1. owner 只能通过 host gateway 提交 receipt，不能直接改 ledger。
2. gateway 校验 transport identity、opaque capability、lease、epoch、hash 和 schema。
3. expected_ledger_version 必须等于 current version，使用 CAS 原子写。
4. stale attempt、旧 head、旧 epoch、重复 nonce 或 replay receipt 一律拒绝。
5. deterministic/remote checker 产证据，owner 不能用文字自证 PASS。
6. gate 通过自动进入下一状态，不 jump、不等 lead。
7. 可自修的失败回 owner 循环；只有第 8.2 节进入 DECISION_REQUIRED。
8. 现有 record-delivery / run-ledger 只认旧主体，必须做 vNext schema 和 gateway 迁移，不能用文档纪律假装已经具备认证。

## 10. PR Ready 的唯一完成定义

### 10.1 per-PR PR_READY

只有同时满足以下条件才能标记：

1. 远端 PR 存在，isDraft=false，repo/base/head/branch 与 pr_key 正确。
2. current_pr_head_sha 等于远端最新 head。
3. source_candidate_sha 与 current_pr_head_sha 相同，或存在有效 content_equivalence_receipt。
4. 所有 SC 对当前 attempt/content lineage 为 PASS，并有可复核证据。
5. 必需本地验证和 e2e 全绿。
6. 仓库声明的 required CI checks 对 current_pr_head_sha 全绿；无 required checks 时记录空集来源，不能伪造“全绿”。
7. review receipt 绑定 current_pr_head_sha，unresolved=0，且没有 CHANGES_REQUESTED。
8. mergeability checker 对当前 head/base 返回无冲突；若平台返回 unknown，继续等待。
9. 仓库规则声明的 size、security、privacy、secret scan 等 policy gate 全部通过；未声明的 gate 不凭空强制。
10. PR 标题、描述、SC/测试证据和已知风险完整。
11. watcher 已注册并绑定 pr_key、current head 和当前 owner；watcher 只观察。
12. pr_ready receipt 的 expected_ledger_version、attempt_id、owner_epoch 全部是当前值。

不能要求 candidate、PR head、CI/review receipt 永远使用同一 SHA。正确关系是：

- candidate 标识原始可验内容；
- PR head 标识当前远端代次；
- CI/review/mergeability 必须绑定当前 PR head；
- candidate 到 PR head 用相同 SHA 或确定性内容等值 receipt 连接。

### 10.2 RUN_READY 聚合

per-PR owner 在自己的 PR_READY 后完成责任。run 的聚合器还必须验证：

- 所有计划中的 PR 均为当前有效 PR_READY；
- 所有 group/wave 已按依赖顺序记录；
- 所需 integration/downstream_base receipt 有效；
- run expected_ledger_version 与最终集成状态一致；
- 没有 active DECISION_REQUIRED 或失效的 Ready。

integration receipt 只证明依赖/集成顺序、集成 tip 与下游 base，不代表执行 merge。任何 base/head 变化都使受影响的 PR_READY 失效，并要求原 owner 按新 attempt 复验。receipt 的产生者、字段和 CAS 绑定由 RUN_READY 聚合器定义。

通过后由 automation 标记 RUN_READY。lead 不执行该转换。

### 10.3 pr_ready receipt

至少包含：

- run_id、pr_key、owner_session_id、lease_id、owner_epoch
- repo、pr_url、base、branch
- attempt_id、source_candidate_sha、current_pr_head_sha
- content_equivalence_receipt（如需要）
- current ledger_version
- SC 逐项结果与证据
- local/e2e/CI/review/mergeability/policy 结果及来源
- unresolved_count、review_decision、isDraft
- watcher_id
- checked_at、host_attestation

合法 pr_ready receipt 被 gateway 接受后，owner 才能正常结束。merge 仍由人决定并执行。

## 11. watcher 与 pr-fix owner

目标态：

1. watcher 是 observer，不是第二 owner。
2. CI/review/head/base 变化优先唤醒原 owner。
3. 进程崩溃优先恢复同一 session、lease 和 attempt，不另开窗。
4. 只有原 owner 不可恢复或已按规则归档时，才允许 pr-fix owner。
5. transfer 必须 CAS 原子完成：旧 lease/epoch 失效后，新 lease/epoch 才生效。
6. pr-fix handoff 包含原 SC、当前 PR/head、失效的 Ready 证据、失败详情、已尝试动作、allowed_paths、authorization 和验证矩阵。
7. pr-fix owner 的责任同样到 PR Ready，不是修一下再交给 lead。
8. watcher 当前只有 session_id、没有 lease/transfer schema；这是待实现目标，不是当前能力。

实现窗和 pr-fix 窗统一标题：

{项目名}-{中文任务名}丨 {MMDD}

要求：

- 任务段至少含一个汉字。
- 用户可读标题不塞 p1/g1/SC id。
- pr_key/group/SC/branch/lease 放在机器 metadata 中硬绑定。

示例：

- MivoCanvas-修复复制PNG下载丨 0905
- Cindy-修复宿主剪贴板写入丨 0905

## 12. 分组与 SiteScout 的唯一真源

不能简单规定“只由 task-priority 分组”，因为现行 approve-exec 的 SiteScout 会根据现场 real_write_paths 建冲突图；也不能让两边都在不同时间重拆。

目标是：

1. task-priority 产出初始 SC、anchor/write capability 和依赖。
2. SiteScout 在 ledger init 前补齐现场证据。
3. 一个 compiler 合并两者，产出 final execution graph。
4. graph 明确每个 PR owner、SC、write set、依赖、启动条件和 base。
5. graph 经验证后生成 manifest/core hash 并初始化 ledger。
6. 初始化后任何新事实若会改变 graph，必须废弃本次 init，重新生成版本；不能现场回填后继续。
7. read-only probe 以 permission=read_only 表达，不用 README.md 伪装写路径。
8. approve-exec 只消费 final graph，不另有隐形分组算法。

## 13. 当前硬阻塞与迁移边界

以下能力当前不存在，未完成前不能宣称新流程可用：

1. **per-PR vNext 状态/schema**：当前只有 candidate accepted、run ready、pr-open 旧链。
2. **host create gateway**：session-dispatch.mjs 只有 dry-run；真实 send_to_session 没有 canonical handoff 原子绑定。
3. **owner 身份认证**：没有 opaque capability、lease、epoch、heartbeat、CAS、防重放。
4. **pr_ready receipt**：当前 ledger 没有该 schema、checker 或状态迁移。
5. **ownership transfer**：watcher 只认 session_id，没有原子 lease transfer。
6. **owner 自动恢复**：进程/会话失败后没有保证恢复同一 owner 的宿主机制。
7. **graph 编译顺序**：task-priority、SiteScout、manifest hash、ledger init 的权威顺序需改造。
8. **外部动作授权**：handoff 还没有可机器校验的 external_action_scope。
9. **Ready checkers**：CI/review/mergeability/repo policy/content equivalence 的 receipt 来源和当前 head 绑定需实现。
10. **旧 run 兼容**：现有 ledger 不能原地切换 vNext。

建议按真实仓边界拆成相互依赖的 PR，每个 PR 仍由一个 owner 推到 Ready：

1. Contract/schema PR：vNext state、receipt、lease、CAS、legacy 兼容。
2. Cindy host PR：create gateway、transport identity、heartbeat/resume、ownership transfer。
3. approve-exec/goal PR：handoff renderer/validator、owner lifecycle、自动 gate、lead 权限边界。
4. task-priority/SiteScout PR：final execution graph、init 前 fail-closed、单真源。
5. watcher PR：同 owner 唤醒、pr-fix transfer、中文标题。
6. e2e PR：故障注入、零 lead 执行和 PR Ready 全链验收。

依赖未满足的下游 PR 不得假装通过；handoff 必须写明前置 receipt。

## 14. 最终修复优先级

### P0：责任链与状态语义

1. 定义 per-PR vNext 状态机和 PR_READY。
2. candidate 固定为非终止 checkpoint。
3. owner lease 只在 PR_READY 或原子 transfer 后释放。
4. RUN_READY 保留为全局聚合，不再作为 owner 开 PR 前的人工卡点。
5. 明确 legacy ledger 不原地迁移。

### P0：可信 gateway

6. 实现 host create gateway，原子绑定 handoff、session、lease 和 ledger。
7. 实现 transport identity、opaque capability、CAS、防重放和 host attestation。
8. renderer → validator → create 必须一次完成；缺段、错配、占位全部拒绝。
9. owner receipt 只能经 gateway 写入，lead 不手工 set-state。

### P0：完整 handoff 与自主闭环

10. 补齐 canonical 0–10、external_action_scope、delegation、fallback 和 exact receipts。
11. 合法首条消息必须在同轮触发真实执行。
12. owner 自主完成 commit/push/PR/CI/review/Ready。
13. gate_goal、gate_routing、candidate、ready-check 改为可信自动校验，不聊天放行。
14. happy path 只向 lead 暴露最终 PR_READY；真正例外只发一条 decision request。

### P1：graph、watcher 与恢复

15. task-priority + SiteScout 在 init 前编译唯一 final execution graph。
16. open_unknowns 会改变拆分/依赖/write capability 时 fail-closed。
17. watcher 只唤醒 owner，不取得所有权。
18. owner 崩溃优先恢复；不可恢复时 CAS transfer 到唯一 pr-fix owner。
19. 批准执行与 pr-fix 标题统一为“项目名-中文任务名丨 MMDD”。
20. 429、provider/worker 失败、网络和进程故障都先走恢复/fallback。

### P1：Ready 证据

21. CI/review/mergeability receipt 绑定 current_pr_head_sha。
22. candidate 与变换后 head 使用 content_equivalence_receipt。
23. repo policy 决定必需 gate，不能凭空增加或跳过。
24. pr_ready 与 RUN_READY 都使用 current ledger_version / owner_epoch / attempt_id。

## 15. 验收 SC

### SC-01：合法 handoff 即刻开工

完整 handoff 只创建一个 owner；第一条消息包含完整正文与 hash；owner 首轮自检后执行真实命令。不得出现“先停着”“是否开始”“请 lead 放行”。

### SC-02：一个 owner 到 PR Ready

同一 owner 完成实现、验证、commit、push、PR open、CI/review 修复并发出 pr_ready receipt；candidate 后没有完成、卸责或换 owner。

### SC-03：lead 零执行

happy-path 审计中，lead 没有产品写入、git/gh、测试、worker 派发、receipt 搬运、PR 修改或 CI/review 跟进；只读取最终证据并做判断。

### SC-04：自主 worker/sub

owner 能派一个 read-only sub 和一个 worker；两者只回 owner；owner 复核整合；所有权不变。

### SC-05：可恢复故障不停

注入 429、单 worker 失败、测试红、CI 红、review unresolved、网络中断和 owner 进程重启；系统恢复同一 lease/attempt 或合法增加 attempt，不向 lead 提普通问题。

### SC-06：DECISION_REQUIRED 不卸责

注入 allowed_paths 不足或 SC 矛盾；owner 发一条完整 decision request，lease 保留。lead 只选方案，同一 owner 恢复到执行态并继续到 Ready。

### SC-07：candidate 不是终点

state machine 拒绝 candidate 后 complete/archive；只有合法 PR_READY 或原子 transfer 能释放 owner lease。

### SC-08：身份不可错配

交换 title/group/SC/repo/branch/worktree/handoff/lease 中任一字段，create gateway 必须 fail-closed。

### SC-09：receipt 不可伪造或重放

伪造 session、旧 epoch、旧 attempt、旧 head、旧 ledger_version、重复 nonce 的 receipt 全部被 gateway 拒绝。

### SC-10：内容变换可追溯

注入 rebase/squash 导致 candidate SHA 与 PR head 不同；无 content_equivalence_receipt 时不能 Ready，有有效确定性 receipt 后可继续，CI/review 必须重新绑定当前 head。

### SC-11：无双 owner

原 owner 活跃时 watcher 不得创建 pr-fix owner；模拟不可恢复后，旧 lease 原子失效、新 lease 生效，任一瞬间 active owner 数不超过 1。

### SC-12：PR Ready 可机器复核

PR remote identity、current head、内容谱系、SC、local/e2e/CI/review/mergeability/repo policy/watch 全部由当前代次 receipt 验证；任一必需项失败都不能 Ready。

### SC-13：RUN_READY 保留聚合约束

只有全部 PR_READY、全部 wave/dependency/integration receipt 有效且 ledger version 为当前值时，automation 才能标 RUN_READY。

### SC-14：中文标题统一

批准执行 owner 与 pr-fix owner 都满足“项目名-中文任务名丨 MMDD”；任务段至少含一个汉字；技术 id 只在 metadata。

### SC-15：前置依赖 fail-closed

open_unknowns 会改变拆分、依赖、base 或 write capability 时不创建 owner；解决后重新生成 graph/manifest/handoff/hash，再 init ledger。

### SC-16：外部动作授权

handoff 明确授权的 feature branch push 和目标 PR create/update 可自主执行；越出 scope、不可撤回外部消息、CI/CD 修改和 merge 必须进入 DECISION_REQUIRED 或交由人执行。

### SC-17：legacy 不被破坏

旧 ledger 继续按旧 schema 只读/收尾；vNext 不隐式改写旧状态，不出现同名字段不同语义。

## 16. 明确不采用

- 不让 owner 到 candidate 就停。
- 不让 lead 手动跑 ready-check、开 PR或追 CI。
- 不为同一 PR 常驻两个责任窗。
- 不删除安全、身份、SHA、SC、授权和人类专属 gate。
- 不用聊天 jump 承担机器 gate。
- 不允许 owner 直接写 ledger 或自证 PASS。
- 不在 ledger init 后回填路径并重拆。
- 不让 task-priority 和 approve-exec 各有一套分组真源。
- 不把只读 probe 的 README.md 字段当成真实写冲突。
- 不强制 candidate SHA 与变换后的 PR head 相等。
- 不把 group/SC id 塞进用户标题来代替 metadata 校验。
- 不把目标契约描述成当前已实现能力。
- 不在本终稿中修改或续跑 0904 现场 ledger。

## 17. 一句话完成合约

> 只有在“完整 handoff 经可信 gateway 创建唯一 owner → owner 无需 lead 放行立即执行 → 自主派 worker/sub 并处理所有可恢复失败 → receipt 经认证、CAS 和当前代次校验 → 同一 owner 把远端 PR 推到机器可证明的 PR Ready → lead happy path 全程零执行”全部成立时，才算修复完成。
