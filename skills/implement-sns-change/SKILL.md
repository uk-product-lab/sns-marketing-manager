---
name: implement-sns-change
description: Implement one approved SNS management project Issue or local task as a small reviewable vertical slice. Use for feature work, bug fixes, refactoring, database migrations, tests, or Claude Code/Codex handoffs after the task status is READY. Enforces scope, free-operation constraints, self-tests, fixed-SHA handoff, and separation from independent review.
---

# SNS変更を実装する

## タスク種別

製品変更と文書・ハーネス専用governance変更を混在させない。後者は`harness/RUNBOOK.md`の「文書・ハーネス専用タスク」に従い、構文・正常/異常系・Skill形式・独立監査を行う。製品コードを含まない場合に製品E2Eを適用しないことは、製品の必須テストを省略する許可ではない。

管理者`ukyo-0001`による承認済み自動化を許可する。別machine accountや管理者切断を要求しない。実装/レビューの別session・worktreeは維持し、本人の承認ラベル・Environment承認を代行しない。

## 開始条件

1. プロジェクト直下の`AGENTS.md`、`Harness.md`、`Plan.md`、`harness/board_decisions.md`、`harness/RUNBOOK.md`、`harness/regression_manifest.md`を読む。
2. 担当Issueまたはタスクファイルを読む。
3. 状態が`READY`で、受け入れ条件・対象外・必須テストが明記されていることを確認する。
4. `harness/scripts/acquire-lease.mjs`で実装leaseを取得する。取得できなければ作業しない。
5. 未決の取締役会判断、課金、秘密情報、破壊的変更がある場合は`BLOCKED`としてCEOへ返す。

## 実装

1. 1 Issue、1担当、1ブランチ、1 PRを守る。
2. CodexとClaude Codeで同じworktreeを同時編集しない。
3. 利用者が置いた変更を保持し、無関係な修正を混ぜない。
4. `sources/`を変更しない。
5. 画面、API、保存、テストが一緒に確認できる小さな縦切りで実装する。
6. DB変更にはマイグレーションと互換・復旧方針を含める。
7. 有料サービス、SNS投稿API、実メール、実ユーザーデータを使わない。
8. 新しく実装する利用者フローは、テストと`harness/regression_manifest.md`の`REQUIRED`化を同じ変更へ含める。
9. 通常実装PRではHarness、workflow、Skills、意思決定記録、検証スクリプトを変更しない。回帰manifestは`PLANNED`から`REQUIRED`への昇格だけ許される。

## 自己テスト

レビューへ渡す前に次をすべて成功させる。

1. 型チェック
2. Lint
3. 単体・結合テスト
4. Production build
5. D1マイグレーション
6. 受け入れ条件に対応するブラウザ予備確認
7. 秘密情報、課金、外部SNS通信がないことの確認

失敗した状態、テストをスキップした状態、未完了を隠した状態でレビューへ渡さない。

## 引き継ぎ

1. `harness/templates/implementation_handoff.md`の全項目を埋める。
2. 受け入れ条件ごとにテスト名または確認手順を対応づける。
3. レビュー対象の固定コミットSHAを記録する。
4. 状態を`SELF_TESTED`へ更新する。
5. 独立レビュー担当へ、PR・固定SHA・生のテスト結果・スクリーンショットを渡す。
6. CEOに実装leaseを`SELF_TESTED`として解放してもらい、レビューlease取得可能な状態にする。

文書・ハーネス専用タスクでは判定範囲を明記し、製品PASSや実GitHub準備完了として引き渡さない。未決の保存先・API・承認方式を実装者判断で確定しない。

実装担当の推測、内部推論、想定される不具合をレビュー担当へ答えとして渡さない。

## 禁止

- 自分の変更へ最終`PASS`を出さない。
- レビュー不合格を避けるためにテストや期待値を弱めない。
- 取締役会決定なしに範囲、技術基盤、料金方針を変えない。
- 実装完了とマージ可能を同義にしない。独立レビューの`PASS`が必要。

詳細チェックは`references/implementation-checklist.md`を読む。
