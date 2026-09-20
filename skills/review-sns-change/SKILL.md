---
name: review-sns-change
description: Independently review one fixed commit for the SNS management project. Use after a product or governance task is SELF_TESTED to inspect the diff, run the task-specific gates, preserve evidence, and return the allowed fixed-SHA verdict. Product changes require real-browser responsive E2E and accessibility; docs-only or local-harness changes use their dedicated non-product verdict. Never implement fixes on the reviewed change.
---

# SNS変更を独立レビューする

## 判定対象

製品変更には以下の全製品ゲートを適用する。文書・ハーネス専用governanceタスクは`harness/RUNBOOK.md`の専用手順とタスク契約でレビューし、固定SHAに対する`DOCS_PASS`/`HARNESS_LOCAL_PASS`または`FAIL`/`BLOCKED`を報告する。成功判定では`harness/templates/governance_review_report.md`と専用JSON verdictを使い、`validate-governance-verdict.mjs`で検証する。`DOCS_PASS`は`docs-v1`、`HARNESS_LOCAL_PASS`は`harness-local-v1`だけを使い、verdictの`requiredChecks`を信頼済みprofileの代わりに扱わない。`FAIL`/`BLOCKED`は成功用JSON verdictを発行せず、報告書、check証跡、`failure-record.json`へ理由を残し、`validate-review-failure-record.mjs`で検証する。対象外の製品E2Eを実施済み・製品PASSと表現しない。

DEC-009により管理者の自動化利用は許可済み。GitHub IDの同一性を理由にレビューを拒否せず、実装/レビューsession・worktreeの分離を検証する。同一管理者IDだけでは本人操作を証明できないため、本人承認を代行せず、実承認経路の検証をローカル監査と区別する。

## 独立性

1. プロジェクト直下の`AGENTS.md`、`Harness.md`、`Plan.md`、`harness/board_decisions.md`、`harness/RUNBOOK.md`、`harness/regression_manifest.md`を読む。
2. 実装担当とは別セッション・別エージェントで実行する。
3. PRと固定コミットSHAを受け取る。PRのbaseがGitHub API上の現在の既定ブランチで、headがその最新commitを含むことを確認する。検証中にSHAまたはbaseが変わったら最初からやり直す。
4. `harness/scripts/acquire-lease.mjs`でレビューleaseを取得する。実装lease未完了、同一セッション、固定SHAなし、lease競合の場合は`BLOCKED`。
5. 製品コードを修正しない。不具合は実装担当へ差し戻す。
6. 実装担当の結論ではなく、差分・要件・テスト結果・動作を独立して確認する。

## 静的ゲート

1. タスク範囲と差分を照合する。
2. `sources/`変更、秘密情報、有料API、SNS投稿API、実メール送信がないことを確認する。
3. 型、Lint、単体・結合テスト、Production build、D1移行を実行する。
4. テストの削除、スキップ、期待値弱体化がないことを確認する。

どれか1つでも不合格ならブラウザゲートへ進まず`FAIL`を出す。実行不能なら`BLOCKED`。

## 実ブラウザE2E

1. テスト用DBと固定時計を使ってアプリを起動する。
2. Codex Desktopでは利用可能なブラウザ操作ツールの手順を読み、実ブラウザで操作する。存在しないBrowser Skillを前提にしない。利用可能な操作環境がなければ`BLOCKED`。
3. Claude CodeまたはCIではPlaywrightのChromiumとWebKitを実行し、加えて利用可能な実ブラウザで主要フローを確認する。
4. Mac 1440×900、MacBook 1512×982、iPhone相当390×844と393×852を確認する。
5. 受け入れ条件、`harness/regression_manifest.md`で既に`REQUIRED`の全シナリオ、当該PRで`REQUIRED`へ昇格するシナリオを操作する。`PLANNED`は未実装の将来要件であり、このPRのskipに含めない。
6. コンソール、ネットワーク、アクセシビリティ、スクリーンショット、トレースを保存する。

Browserを起動できない、証跡を保存できない、必須シナリオを実行できない場合は`BLOCKED`。静的テストだけで`PASS`を出さない。

## 判定

- `PASS`: 必須テスト100%成功、スキップ0件、重大不具合0件、証跡完備
- `FAIL`: 要件、実装、セキュリティ、レスポンシブ、アクセシビリティに不合格
- `BLOCKED`: 環境、認証、起動、固定SHA、証跡不足で判定不能

不安定なテスト、再実行時だけの成功、未確認項目がある場合は`PASS`にしない。

## 報告

1. `harness/templates/review_report.md`を使う。
2. lease出力の共有`stateRoot`にある`reviews/<gate-id>/`へ証跡を保存する。レビューworktree内へ証跡を置かない。
3. `PASS`時は同じ証跡ディレクトリへ`review-verdict.json`を保存する。`FAIL`/`BLOCKED`時は成功用verdictを作らず、`failure-record.json`、非空の`summary.md`、`checks.json`、`commands.log`を保存する。
4. 秘密情報、Cookie、トークン、個人データ、実ブランド情報を証跡へ含めず、合成テストデータだけを使う。PASS証跡は取締役会確認用の公開Git commitになる前提で内容を点検する。
5. `PASS`時もレビュー担当はマージしない。CEOへマージ許可を勧告する。
6. `FAIL`時は再現手順・期待結果・実結果・証跡を付け、`failedChecks`を`checks.json`のFAIL項目と一致させて実装担当へ差し戻す。`BLOCKED`時は`blockedChecks`と`blockedReasons`を記録する。
7. CEOは`harness/scripts/validate-review-verdict.mjs`の成功、PASS解放時のclean worktree・HEAD・PR head・固定SHA一致、GitHub側で再ハッシュされた証跡commit、取締役会Environment承認、専用Gatekeeper Appをexpected sourceとするGitHub `review/independent`成功を確認する。1つでも欠けた報告は`PASS`として扱わない。

文書・ハーネス専用タスクでは`harness/templates/governance_review_report.md`を使い、`summary.md`、`checks.json`、`commands.log`を共有`reviews/<gate-id>/`へ置く。成功時だけ専用JSON verdictへ対応する信頼済み`checkProfile`を記録し、`requiredChecks`、`executedChecks`、`checks.json`のIDをその固定集合と完全一致させる。独自profile、欠落、追加、outcomeとの不一致は合格にしない。`FAIL`/`BLOCKED`時は成功用JSON verdictを作らず、`failure-record.json`の不合格checkまたは阻害要因を`checks.json`と一致させる。CEOは成功時の専用validator、または失敗時の`validate-review-failure-record.mjs`、clean worktree、固定SHA、実装leaseとの対応を確認してからleaseを解放する。GitHub PR head・製品E2E証跡はgovernance成功経路では要求しない代わりに、製品PASSや実GitHub準備完了へ転用しない。

詳細チェックは`references/e2e-gate-checklist.md`を読む。
