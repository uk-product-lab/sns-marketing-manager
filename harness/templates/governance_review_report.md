# 文書・ハーネス独立レビュー報告

- Gate ID:
- Task ID:
- Fixed Commit SHA:
- Scope: docs | harness-local
- Implementer Session:
- Implementation Lease ID:
- Reviewer Session:
- Review Lease ID:
- Review Started:
- Review Completed:
- Verdict: DOCS_PASS | HARNESS_LOCAL_PASS | FAIL | BLOCKED
- Recommendation: BOARD_REVIEW_CANDIDATE | RETURN_TO_IMPLEMENTER | WAIT
- Check Profile: docs-v1 | harness-local-v1 | N/A（FAIL/BLOCKED）

## 必須チェック

- Required Checks:
- Executed Checks:
- Failed Checks:
- Blocked Checks:
- Blocked Reasons:

各チェック名、コマンドまたは確認方法、生の結果、対象ファイルを対応付ける。

`DOCS_PASS`には`docs-v1`、`HARNESS_LOCAL_PASS`には`harness-local-v1`を使う。`requiredChecks`、`executedChecks`、`checks.json`のcheck IDは、`Harness.md`に定義されたvalidator所有の固定集合と完全一致させる。レビュー担当が独自profileや縮小した集合を自己宣言して合格条件を差し替えてはならない。`FAIL`/`BLOCKED`はCheck Profileを`N/A`とし、成功用JSON verdictを作らず、`failure-record.json`と本報告へ失敗または阻害要因を記録する。

## 対象と対象外

製品コード、製品E2E、実GitHub設定、外部公開、課金を確認していない場合は明記する。

## 指摘

## 秘密情報・公開除外

## 証跡

- Evidence Path: `<stateRoot>/reviews/<gate-id>/`
- `summary.md`:
- `checks.json`:
- `commands.log`:
- `governance-verdict.json`: 成功判定の場合だけ`harness/templates/governance_verdict.example.json`を基に作成
- `failure-record.json`: `FAIL`/`BLOCKED`の場合だけ`harness/templates/review_failure_record.example.json`を基に作成

## 判定の境界

`DOCS_PASS`は文書整合、`HARNESS_LOCAL_PASS`は文書とローカルハーネス検証の合格だけを示す。製品`PASS`、`REPOSITORY_GATE_PASS`、マージ承認ではない。
