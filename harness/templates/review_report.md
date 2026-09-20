# 製品変更の独立レビュー報告

文書・ハーネス専用governanceタスクには`harness/templates/governance_review_report.md`を使う。

- Gate:
- Task:
- 対象PR:
- Fixed Commit SHA:
- 対象機能:
- Implementer Agent:
- Implementer Session:
- Implementation Lease ID:
- Reviewer Agent:
- Reviewer Session:
- Review Lease ID:
- Review Lease Start:
- Review Lease Expires:
- Test Started:
- Test Completed:
- 判定: PASS | FAIL | BLOCKED

## 必須テスト

- 合格数:
- 総数:
- スキップ数:

## 回帰シナリオ

- manifest上の`REQUIRED` ID:
- 実行した`REQUIRED` ID:
- このPRで`REQUIRED`へ昇格したID:

## 静的レビュー

## ブラウザE2E

- Browser:
- Mac相当:
- MacBook相当:
- iPhone相当:

## アクセシビリティ

## コンソール・ネットワーク

## 未解決不具合

## 証跡

## 差戻し先

## CEOへの勧告

- PASSの場合: `MERGE_CANDIDATE`
- FAILの場合: `RETURN_TO_IMPLEMENTER`
- BLOCKEDの場合: `WAIT`

判定と異なる勧告は無効。`PASS`時だけ`review-verdict.json`を作り、同じ値にする。`FAIL`/`BLOCKED`時は成功用verdictを作らず、`harness/templates/review_failure_record.example.json`を基に`failure-record.json`を作る。非空の`summary.md`、`checks.json`、`commands.log`を同じ証跡directoryへ保存し、失敗または阻害checkと理由を一致させる。

## GitHub固定SHAゲート

- Evidence SHA-256:
- `review/independent`: 未発行 | PASS | FAIL
