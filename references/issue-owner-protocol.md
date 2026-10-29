# issue 入口的 owner 协议

本文件说明「批准执行」issue 入口里，owner 会话从拿到开工包到收工的每一步。开工包第 3 节是它的精简版，两者冲突时以开工包为准。对应实现：`scripts/issue-run.mjs`（台账）、`scripts/accept-check.mjs`（lead 验收）、`scripts/issue-watch.py`（续跑唤醒）。来源：PraiseZhu/approve-exec#69。

## 角色

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| owner 会话 | 用 KEEL 的 `keel_run` 推进一个子 issue 对应的 PR；到验收点写 checkpoint；收到裁决后照做 | 不给 lead 发消息报进度；不合并；不改 issue 的范围和验收标准 |
| 续跑脚本 | 每 5 分钟只读台账与 GitHub，发现「待验收、需要用户、可派、停滞」时叫醒 lead，同一情况只叫一次 | 不改台账，不调用模型 |
| lead 会话 | 派会话、跑 accept-check、判通过或要改、收尾归档、开下一批 | 不写产品代码，不代 owner 推进，不合并 |

## 台账状态

```
pending → claimed → dispatched → awaiting_acceptance ─┬─ 通过 → accepted → ready → cleaned → archived
                                     ▲                └─ 要改 → revising ─┘（最多 2 次，第 3 次 → blocked_user）
dispatch_unknown：派发回执不明，lead 核实后 release
blocked_user：等用户（owner 写，或第 3 次要改），用户处理后 lead unblock
closed：计划时子 issue 已关闭
```

## owner 的验收点

看 KEEL `pr_status` 返回的车道与下一步：

- **交接车道**（`draft-gated-handoff`、`gated-handoff`，下一步是 `handoff`）：CI 全绿、非作者审查通过、PR 还是 Draft 时就是验收点。lead 判通过之前不调 `pr_ready`：交接之后 KEEL 对作者返回 `LANE_HANDED_OFF`，不能再推送。
- **personal 车道**：`pr_status` 的 `nextAction` 是 `report_mergeable` 时就是验收点。

到验收点后写 checkpoint 并结束本轮：

```sh
node <skill>/scripts/issue-run.mjs checkpoint --ledger <台账> --item <ref> --state awaiting_acceptance \
  --pr <PR 号> --head <40 位 head sha> --keel-run <KEEL run_id> --lane <车道> \
  --sc '[{"id":"SC1","status":"pass"}, …]'
```

`--pr` `--head` `--sc` `--keel-run` `--lane` 都必须带；`--lane` 只能是 `personal` / `gated-handoff` / `draft-gated-handoff`。`--sc` 要覆盖子 issue 的每一条 SC：KEEL 判通过的写 `pass`；合并前拿不到证据的黑盒项（`github-live`、`cindy-mac`、`cindy-windows`、`paid`）写 `manual` 或 `not_run`。KEEL 管的 SC 还有没通过的，就没到验收点，脚本会拒收。

## 裁决之后

lead 用 `send_to_session` 发来一条消息：

- **通过**：交接车道调 `pr_ready`，`authorization_source` 用台账里的授权原话；成功后写 `--state ready --pr <号> --head <同一 sha>`。personal 车道直接写 `--state ready`。head 和验收时不一致会被拒收：那说明验收后又改了代码，要回到验收点重新写 `awaiting_acceptance`。
- **要改**：按列出的条目改完，回到验收点重新写 `awaiting_acceptance`。上一个 KEEL run 已经结束（例如 personal 车道已到 `report_mergeable`）时，用 `keel_run` 传 `pr=<PR 号>`（KEEL 的 `pr` 任务类型，检出已有分支）在同一 PR 上接着做。

## 只有用户能做的事

外部审批、规则集或权限、发布、缺凭据：

```sh
node <skill>/scripts/issue-run.mjs checkpoint --ledger <台账> --item <ref> --state blocked_user --reason "<要用户做什么>"
```

写完结束本轮。lead 判「要改」第 3 次后停下等用户时，owner 不能自己写回 `awaiting_acceptance`，要等 lead `unblock`。lead 被叫醒后告诉用户，用户处理完后 lead `unblock`，再通知 owner 继续。

## lead 的验收检查（accept-check）

`--stage acceptance` 逐项检查，任一项不过整体判不过：

| 检查 | 不过的条件 |
|---|---|
| `pr_head` | PR 当前 head 与 checkpoint 的 head 不一致 |
| `pr_open` | PR 不是 open |
| `ci` | 必需检查不是全绿；读不到必需检查（查询出错）也不过；仓库没设必需检查时看全部检查；一项检查都没有也不过 |
| `scope` | 改动文件超出子 issue「范围」的 glob（匹配规则与 KEEL `scope.ts` 相同） |
| `body_issue_line` | PR 正文缺「任务 issue：<ref>」一行 |
| `body_sc_rows` | PR 正文「验收对照」一节的表格缺某条 SC 的行（只认这一节，别处提到的 SC 不算） |
| `pending_questions` | 子 issue「待定问题」里有没写「已定」的条目 |

`--stage ready` 另查 `pr_not_draft`：PR 已不是 Draft。

`verdict --pass` 会自己再跑一遍 `--stage acceptance`，不接收外部传入的检查结果。检查全部通过只是必要条件。lead 还要对照子 issue 的「目标」「原因」「不做」看 diff 是否做对了事，再下裁决。

## 防重派

认领、登记、释放三种评论记在子 issue 自己的评论区，只认当前 gh 账号发的。同一子 issue 有未释放的认领或登记时，任何台账、任何入口的 `prepare` 都拒绝；两个 lead 同时认领时，评论 id 小的胜出，后到的一方发释放让位。评论区按每页 100 条读完，最多 50 页。
