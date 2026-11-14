# 仓库卡

每个目标仓一份数据文件，文件名 `<owner>__<repo>.json`（全小写）。批准执行的脚本直接读它：验收时放行 `always_allowed`，开工消息带上 `hot_files`、`guards`、`pitfalls`，预审读 `review_rules`。

| 字段 | 含义 |
|---|---|
| `schema` | 固定 `approve-exec/repo-card@1` |
| `repo` | `owner/name` |
| `always_allowed` | glob 数组。任何子 issue 的 PR 改到这些路径都算在范围内；`{pr}` 会换成 PR 号 |
| `hot_files` | `[{path, why}]`。很多 PR 都会改的文件 |
| `guards` | `[{name, rule}]`。仓库里会拦人的检查 |
| `verify` | `[{name, command}]`。常用验证命令 |
| `review_rules` | 仓库审查规则文件的路径 |
| `pitfalls` | 常见坑，一句一条 |

新增或修改一张卡：每一条都要有出处（目标仓的规则文件，或本仓 `evolution/ledger.json` 里的记录），写在条目里；没有出处的不写。改动走 PR，`tests/repo-card.test.mjs` 会校验仓里每张卡。运行笔记里的经验只是候选，确认反复出现后再进卡。
