# ready-gaps — gap 夹具派生规则（sc-p1f 消费契约）

ready-gaps 不存放完整 JSON 副本：所有 gap 夹具 = **ready-full 复制 + 单点改动**，
由 tests/ready-check.test.mjs 的 `buildEnv(t, repo, mutate)` 程序化派生（测试即派生文档）。

## 派生规则清单（mutate 就地修改后的效果 → 期望 gap）

| 用例 | 改动点 | 期望 gap |
|---|---|---|
| 缺组 | 台账 waves 删除 g2 组 | ledger-partition |
| 组非 verified | g2.state = "delivered" | ledger-partition |
| tip_sha 对账失败 | g1 delivery 事件 detail.tip_sha 改 `a`×40 | ledger-partition |
| verdict SHA 过期 | verdict.candidate_sha 改 `a`×40 | verdict-anchors |
| verdict 缺 SC | verdict.scs 删 sc-p1f | verdict-anchors |
| 锚点文件不存在 | evidence[1].file 改 `evidence/anchors/missing.txt` | verdict-anchors |
| summary 不一致 | evidence[0].summary 改 `bogus` | verdict-anchors |
| rounds 超限 | g2.review.rounds = 4（> reviewMaxRounds） | review-clean |
| unresolved>0 | g1.review.unresolved = 1 | review-clean |
| 审查绑定 SHA 过期 | g1 最后一条 delivery 的 candidate_sha 改 `a`×40 | review-clean |
| e2e 文件缺失 | 删除 e2e-report.json | e2e-report |
| e2e status fail | e2e.status = "fail" | e2e-report |
| e2e SHA 过期 | e2e.candidate_sha 改 `a`×40 | e2e-report |
| presubmit 缺文件 | 删除 intent.json | presubmit-gates |
| size result STOP | size.result = "STOP" | presubmit-gates |
| presubmit SHA 过期 | size.candidate_sha 改 `a`×40 | presubmit-gates |
| git 脏 | repo 内写未跟踪 dirty.txt | git-clean |
| detached HEAD | repo `git checkout --detach` | feature-branch |
| main 分支 | repo 分支名 = "main" | feature-branch |
| 组合缺口 | e2e 缺失 + main 分支 | e2e-report + feature-branch（逐项独立，不短路） |

## ready-check 消费契约（与 ready-full 同构）

- 台账：schema_version / run_id / slug / manifest_path / manifest_core_hash / version（CAS 乐观锁计数）/
  phase / waves[].groups[]{group_id,state,sc_ids,tip_sha,review{rounds,unresolved}} /
  events[]{type,at,detail}；type ∈ {dispatch,delivery,...}（g4 run-ledger schema）
- verdict：candidate_sha（验收时点候选 HEAD）+ scs[]{sc_id,status,evidence[]{file,command,summary}} +
  output_records{file: summary}（内嵌输出摘要记录；evidence.summary 必须与 output_records[file] 逐字一致）
- e2e-report：status∈{pass,fail} + candidate_sha
- presubmit/{size,format,intent}.json：result 各自 pass 语义（size≠STOP / format≠FAIL / intent∈{OK,REBUILT}）+ candidate_sha
