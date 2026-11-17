# approve-exec — 批准执行

Mini 常驻盯梢消费者的版本化源码已迁至独立仓 [Vigil](https://github.com/PraiseZhu/vigil)。它独立扫描本人 PR，不要求 PR 由本 skill 创建；该仓不包含运行态，也不修改服务器审查机。

接在「开 issue」之后：用户说「批准执行 owner/repo#号」，lead 读总 issue（或独立 issue / 单个子 issue），按并行/串行原则把依赖已合入的子 issue 一次全派出去，每个子 issue 开一个独立会话（1 子 issue = 1 PR = 1 会话），执行会话按执行类型读共享 `orca-fanout/routing.json` 的 `session` 路线；派发失败依次用同类型备选重派。2026-11-07 起不走 KEEL、不建台账、不挂定时任务：lead 派完就停；执行会话推到 Draft PR CI 全绿后发消息叫醒 lead 验收，lead 判通过后执行会话转正式 PR 即收工；Mivo 仓 PR 交合并伙伴、合入后伙伴通知 lead（正文写了「合并顺序」的由伙伴自动合，lead 在转正式时用 `batch.mjs notify` 把通知地址登记给伙伴；没写的等用户在 lead 会话说「合并」），用户说「合并」后其他仓 PR 由 lead 按 pr-merge 自己合；PR 合入后 lead 归档已完成的会话、派下一批。

- 看现状、开工消息、派发防重 `scripts/batch.mjs`；验收与收工检查 `scripts/check-pr.mjs`；执行会话的做法 `references/owner-protocol.md`
- 改版前开工的旧 run 按 `references/legacy-ledger-flow.md` 收尾（旧脚本 `issue-plan.mjs`、`issue-run.mjs`、`accept-check.mjs`、`issue-watch.py` 等保留到旧 run 全部收工）
- 合并只由用户对指定 PR 当次授权：用户在提示词里明确授权的加急 admin 合并由 lead 执行；用户说「合并」的 PR，Mivo 仓由合并伙伴合，其他仓由收到这句话的会话按 pr-merge 的标准自己合；另有用户的长期授权（2026-11-08）：Mivo 仓满足自动接单条件的 PR（本人 PR 正文要有「合并顺序」）由合并伙伴自动合。除此之外本 skill 不合入
- 保证等级 T1：脚本校验防疏忽和漂移，不防有意绕过

步骤见 `SKILL.md` ⓪。测试：`node scripts/run-tests.mjs`、`python3 -B -m unittest discover -s tests -p 'test_*continuation.py'`。

## v3：对账式流水线（2026-11-14，PraiseZhu/approve-exec#101）

进度仍然只从 GitHub 现算，不存状态。v3 加了五样东西：对账器、事件写通道、运行章程、共享记忆（运行笔记和仓库卡）、预审与预开工。

### 对账器

```sh
node scripts/reconcile.mjs --root <owner/repo#号>            # 现读一个总 issue：每个子 issue 在等谁、等了多久、该叫醒谁
node scripts/reconcile.mjs --root <owner/repo#号> --report   # 运行报告（Markdown）
node scripts/reconcile.mjs --replay tests/fixtures/replay/xindong__mivo-canvas-plugin__2089.json --at 2026-11-11T16:00:00Z
```

只读 GitHub，不写 GitHub、不发消息、不写本地文件；同一份事实永远得到同一份输出。期限表在 `scripts/lib/reconcile-rules.mjs` 顶部。判停滞只看提交、检查、标签和 review，不看多久没有评论。

### 对账任务

入口 `scripts/reconcile-tick.py`，挂在 Cindy 定时任务的脚本模式下，不调用模型。全账号只建一条，建在 lead 所在的 Mac 上（不建在 Linux 网关上）；建之前先用 `schedule_list` 按名字「批准执行对账」查重。创建参数：

- `executionMode: "script"`，`scriptConfig.command: "python3 <本仓绝对路径>/scripts/reconcile-tick.py"`，`scriptConfig.capabilities: ["sessions.dispatch"]`（只记不敲模式也可以给空数组）
- `intervalMs: 600000`（10 分钟一轮），`recurring: true`，`workingDir` 填本仓目录，`notify: {desktop: false, feishu: false}`
- 不带 `silentWhenIdle`：脚本模式会被宿主拒收（`evolution/ledger.json` 里记过 3 次）。没有到期动作时脚本自己安静结束
- 想让 GitHub 事件立刻触发，再加 `webhookTrigger`（GitHub App 预设，`manual: false` 与定时并存）；目标仓没连 Cindy 的 GitHub App 时不加，只靠 10 分钟一轮

两种模式由环境变量 `APPROVE_EXEC_TICK_MODE` 决定，写在 `scriptConfig.command` 前面：

- `record`（默认）：到期动作只追加到 `~/.claude/state/approve-exec/due-log.jsonl`，不敲门。上线第一周用它对照真实进展，确认没有误报
- `ring`：用 `sessions.dispatch` 叫醒会话。执行会话送不到时改成叫醒 lead；lead 也送不到时本轮以失败结束，宿主会通知

去重缓存在 `~/.claude/state/approve-exec/doorbell.json`，同一段等待 24 小时内只敲一次；缓存坏了当成空的。脚本读 GitHub 用本机 `gh`，和本仓其他脚本一样。停用：`schedule_pause`。

对账任务只管有运行章程、带「总issue」标签、还开着的总 issue。

### 事件

```sh
node scripts/event.mjs emit --type verdict_pass --item <子 issue> --pr <号> --head <40 位 sha> [--note "…"]
node scripts/event.mjs list --item <子 issue>
```

9 种类型：`dispatch`、`ready_for_verdict`、`verdict_pass`、`verdict_revise`、`ready`、`blocked`、`withdraw`、`archived`、`prereview`。每个事件是子 issue 上的一条评论：第一行人话，后面跟机器标记。同一事件重复发不会产生第二条评论。只认当前 gh 账号本人发的。

`check-pr.mjs --stage recheck --accepted-head <sha>`：判通过后 PR 又有新提交时，只查新增改动的范围、存量测试有没有被删行或改名、CI。当前版本不是在判通过的版本上往前加提交（被回退或分叉）时不过，要整体重新验收。

### 运行章程

阶段启动时的一次收口授权见 [SKILL.md「阶段 PR 收口授权」](SKILL.md#⓪-issue-入口)；执行消息未消费的 30 分钟检查见同节「会话失联」。这两项由 lead 按协议处理，现有对账器期限和章程格式保持原样。

```sh
node scripts/charter.mjs write --root <总 issue> --json <章程文件>
node scripts/charter.mjs read  --root <总 issue>
```

| 字段 | 含义 |
|---|---|
| `merge.auto_request` | 真：本次 run 的 PR 审查放行后由 lead 自动交合并请求 |
| `merge.bases` | 自动交合并请求对哪些目标分支生效，只能含 `main`、`integration/*` |
| `conflict.same_file` | 两个 PR 改同一个文件：`serial` 按住后一个，`parallel` 各自转正式、按 PR 正文「合并顺序」排先后 |
| `prereview` | `feature`（改了非测试、非文档源码的 PR 要预审）、`all`、`off` |
| `early_start` | 真：下游子 issue 可以在上游判通过后预开工 |
| `max_parallel` | 同时在跑的执行会话上限，1–12 |
| `manual_test` | 谁做实机手测 |
| `user_words` | 用户授权的原话，原样保存 |
| `lead_session` | lead 会话的跨电脑地址 `<deviceId>::<会话 id>` |

章程没写的事一律不自动做。章程不授权加急 admin 合并。`batch.mjs merge-request` 只核对章程并生成 `pr-merge` 的输入，不发消息、不合并；它只认本次 run 的 PR：正文「任务 issue」是这个总 issue 的子 issue、带审查放行标签 `review:merge-ready`、最新裁决是通过且判通过后代码没变。`max_parallel` 由 `batch.mjs status` 的 `dispatch_budget` 给出还能派几个，名额用完时 `brief` 拒绝。

### 共享记忆

- 运行笔记：`node scripts/note.mjs add --root <总 issue> --from <子 issue> --kind <decision|pitfall> --text "…" [--broadcast]`，`note.mjs list --root <总 issue>`。记在总 issue 下，所有会话读得到。笔记只是候选经验
- 仓库卡：`repo-cards/<owner>__<repo>.json`，字段和新增办法见 `repo-cards/README.md`。验收时放行 `always_allowed`，开工消息带上热点文件、会拦人的检查和常见坑。进仓库卡要走 PR
- 范围三档：在子 issue「范围」里的通过；命中仓库卡 `always_allowed` 的通过；其余文件在 PR 正文「范围对照」写了说明的交 lead 判断，没写的不过

### 预审和预开工

都由章程开关控制，默认不做。做法见 `references/owner-protocol.md`「预审」「预开工」。预开工时 PR 的目标分支仍是 main 或阶段集成分支，不指向上游 PR 的分支。

### 回放数据

`tests/fixtures/replay/` 是两次真实 run 的 GitHub 时间线，测试在上面重跑对账器。重录：`node scripts/replay-capture.mjs --root <owner/repo#号> --out tests/fixtures/replay --slim`（只发读请求，一次约 300–500 个请求，几分钟）；校验：`node scripts/replay-capture.mjs --check tests/fixtures/replay`。不录会话聊天记录；邮箱和密钥样式的内容会被替换。进仓库的数据一律带 `--slim`：评论只留第一行和机器标记，issue 正文清空，目标仓的讨论内容不随测试数据带出来。


## 执行类型与分类

执行类型认「界面 / 逻辑 / 混合」，旧前端→界面、后端→逻辑。`brief` 在派发前核对首行声明与范围、验收层：逻辑声明碰界面文件或需要看画面时拒绝；界面/混合声明判为逻辑时保留声明并输出 `kind_hint` 与理由；未声明走混合路线并给提示。`--kind` 可以覆盖类型，也必须通过安全检查。

只读查看分类：`node scripts/batch.mjs classify --repo owner/repo --repo-dir /path/to/repo --item owner/repo#123`；本地正文改用 `--body-file /path/to/issue.md`。输出 `{kind, ui_files, logic_files, visual_layers, reasons}`，不写 GitHub、不创建会话。

分类用 `git ls-files` 展开范围 glob，未入库的新文件按路径判断。界面表来自仓库卡的可选 `ui_globs`；未写时用 TSX、JSX、Vue、CSS、SCSS、HTML、locales、i18n 通用表。测试和夹具不计，普通文档不计；卡片明确列出的设计文档算界面。界面与逻辑都有为混合；只有界面为界面；只有逻辑且验收包含 browser-fixture/cindy-mac/cindy-windows 为混合，否则为逻辑；没有代码文件时保守判混合。仓库卡的空 `ui_globs` 表示显式禁用通用表。已识别的代码和配置文件算逻辑；图片、字体等资源及未知扩展名保守不计。裸目录按索引里的子文件展开。

## 执行会话路线

路线唯一真源是 `orca-fanout/routing.json`：`APPROVE_EXEC_ROUTING` 优先，否则读 defaults 的 `routingPath`（`~/.claude/skills/orca-fanout/routing.json`，脚本展开 `~`）。界面取 `session.ui`、逻辑取 `session.logic`、混合或首行没写取 `session.mixed`。首选和 `fallbacks` 每项都有 `agent`、`model`、`effort`、`agent_device_id`，不得带 `provider_id`。缺文件、缺 session、缺类型或缺字段时拒绝派发，先跑 `model-route check`；`selfcheck --live` 也核对三类配置。

当前约定：界面、混合首选 Praise-VPS 的 Opus 订阅，备选 Pro 的 Cindy AI Opus；逻辑（兼容 `执行类型 后端`，新写法 `执行类型 逻辑`）首选 Mac mini 的 Art Cindy GPT-6.1 Sol，备选 Pro 的 Cindy AI GPT-6.1 Sol。运行时以共享 session 配置为准，不在本仓写第二份模型表。

先跑 `brief --route-index 0`，把 `request` 原样交给 `send_to_session`（必须支持 `agent_device_id`）。遇 `AGENT_NOT_READY`、`PROVIDER_ROUTE_UNAVAILABLE`、明确用量上限或网关离线，先归档回执里创建出的失败会话，已 claim 的先 release，再按 `routes` 顺序以 `--route-index 1`、2…生成新请求，并写明错误码和换路线原因。未知错误、能力缺口、候选耗尽就停；`DELIVERY_UNKNOWN` 先核对是否建出会话。旧 `--gateway` 报错提示改用 `--route-index`。

成功后 `claim --item <子 issue> --session <会话 id> --title <标题> --route-json '<brief.route 的 JSON>'`，记录实际成功路线的 agent、model、kind、route_index。运行报告增加「类型」「模型」，取最近一次派发事件；旧事件没有 route 时模型写「未记录」，旧事件仍可识别在做状态。测试通过 `APPROVE_EXEC_ROUTING` 读 `tests/fixtures/routing.json`，不依赖本机路线。
