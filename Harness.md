# SNS管理サービス 自律開発ハーネス

更新日: 2026-09-17

## 現行方針の優先適用（DEC-009）

管理者`ukyo-0001`による承認済み作業の自動化を許可する（DEC-009）。管理者切断・別machine account・role `write`固定は必須条件ではない。文書・ハーネス整備はDEC-010で着手承認済み。製品の独立レビュー・必須テスト・実ブラウザE2E・本人の最終承認は維持する。過去の`HARNESS_PASS`は旧設計の履歴であり、改訂版や実GitHub設定の合格を意味しない。

## 目的

CodexとClaude Codeが同じルールで自律的に実装・レビューを進め、独立したブラウザE2Eが合格した変更だけを次工程へ進める。

「CEO」「取締役会」は、このプロジェクト内の意思決定上の役割名として使う。

## 正本の優先順位

矛盾がある場合は、上にあるものを優先する。

1. システム指示、プロジェクト指示、`AGENTS.md`
2. 取締役会で確定し、`harness/board_decisions.md`へ記録した決定
3. `Plan.md`
4. GitHub Issueまたは`harness/tasks/`のタスク契約
5. PR本文、実装メモ、レビューコメント

`sources/`は常に読み取り専用とする。

実際の開始・再開手順は`harness/RUNBOOK.md`、導入済み回帰テストの正本は`harness/regression_manifest.md`とする。

## 組織

### 取締役会代表

利用者本人。次を共同決定する。

- 有料サービス、支払い手段、無料枠超過
- MVP範囲、媒体、認証方針、データ削除方針の変更
- 外部公開、独自ドメイン、実OAuth、本番デプロイ
- セキュリティ、個人情報、重大な互換性変更
- 品質ゲートの例外

### CEO

主エージェント。承認済み範囲内で次を行う。

- 作業順、依存関係、担当エージェントを決める
- 1タスク単位で実装担当とレビュー担当を分離する
- 実装詳細、テスト方針、可逆なリファクタリングを判断する
- `PASS`証跡を確認してマージ・次工程を許可する
- 真の経営判断だけを取締役会へ上げる

CEOはレビューゲートを代行・免除しない。

### 実装責任者

CodexまたはClaude Codeの独立セッションを1名割り当てる。

- 承認済みタスクだけを実装する
- 1 Issue、1担当、1ブランチ、1 PRを守る
- 自己テストを完了してからレビューへ渡す
- 自分の変更を最終承認しない
- `skills/implement-sns-change/SKILL.md`に従う

### 品質保証責任者

実装担当とは別のサブエージェント・別セッションを割り当てる。

- 固定コミットSHAだけを検証する
- 製品コードを修正しない
- 静的レビュー、自動テスト、実ブラウザE2Eを行う
- 証跡付きで`PASS / FAIL / BLOCKED`を出す
- `skills/review-sns-change/SKILL.md`に従う

レビュー担当が製品コードを直した場合、そのPRのレビュー資格を失う。

## Claude CodeとCodexの分担

- 同じ作業ディレクトリを同時編集しない。
- GitHub接続後は別worktree・別ブランチを使う。
- 作業開始前に`harness/scripts/acquire-lease.mjs`で実装またはレビューの排他的leaseを取得する。lease状態は全worktreeが共有するGit common dir配下へ固定し、branch・worktreeのlockを排他的ファイル作成で取得する。任意の状態フォルダへ切り替えない。取得失敗時は作業を開始しない。
- leaseにはタスク、役割、エージェント、セッション、ブランチ、worktree、開始日時を記録する。
- 正常終了、引き継ぎ、異常終了時はCEOが`harness/scripts/release-lease.mjs`で結果を記録して解放する。実装者・レビュアー自身が所有者を勝手に変更しない。期限切れleaseから`SELF_TESTED`または`PASS`は出せない。
- レビューleaseは、実装leaseが`SELF_TESTED`で解放済み、固定SHAがあり、実装と異なるセッションの場合だけ取得できる。
- `SELF_TESTED`と`PASS`の解放時にworktreeがcleanで、HEADが固定SHAと一致することを再検査する。`PASS`ではGitHubの現在のPR headも同じSHAでなければならない。
- Codexの新規ブランチ名は`codex/issue-<番号>-<短い名称>`とする。既存ブランチ名は変更しない。
- Issueには`agent:codex`または`agent:claude`を付け、所有者を固定する。
- 原則として、Claude Code実装をCodexがレビュー、Codex実装をClaude Codeがレビューする。
- 引き継ぎ時は理由と固定SHAを残し、口頭の状態だけに依存しない。

## タスク契約

実装開始前に、Issueまたはタスクファイルに次が必要。

- 目的と利用者価値
- Plan.mdの要件IDと関連する決定ID
- 対象範囲と対象外
- 受け入れ条件
- 必須テスト
- 変更可能な領域
- 依存タスク
- 無料運用・セキュリティ制約
- 未決事項
- 実装・レビューlease ID
- 当該PRで`REQUIRED`へ昇格させる回帰シナリオID

不足している場合は`BLOCKED`とし、推測で範囲を広げない。

## 状態遷移

```text
PROPOSED
  → BOARD_DECISION（必要な場合）
  → READY
  → IMPLEMENTING
  → SELF_TESTED
  → REVIEWING
  → PASS
  → MERGED
  → POST_MERGE_PASS
  → DONE
```

- `FAIL`は`IMPLEMENTING`へ差し戻す。
- `BLOCKED`は原因が解消するまで次工程へ進めない。
- 修正後は失敗箇所だけでなく、必須テスト全件を再実行する。
- 再実行時だけ通る不安定なテストは`PASS`にしない。

文書・ハーネス専用governanceタスクは`SELF_TESTED → REVIEWING → DOCS_PASS`または`HARNESS_LOCAL_PASS`を使う。別session・別worktree・固定SHA・lease・証跡を必須とし、成功判定は専用verdict validator、`FAIL`/`BLOCKED`は専用failure-record validatorで検証する。失敗時は成功判定用JSONを発行せず、`failure-record.json`と失敗理由を含む証跡が検証できた場合だけleaseを解放する。いずれも製品`PASS`、`REPOSITORY_GATE_PASS`、マージ承認へ読み替えない。

## 実装担当の自己テスト

レビュー依頼前に以下をすべて通す。

1. 型チェック
2. Lint
3. 単体・結合テスト
4. Production build
5. D1マイグレーションテスト
6. 受け入れ条件に対応するブラウザ予備確認
7. 秘密情報、有料API、意図しない外部通信がないことの確認

自己テストは独立レビューを代替しない。

## 独立レビューゲート

### 文書・ローカルハーネス専用ゲート

製品コードを含まないgovernanceタスクは、validatorに版管理された信頼済みチェックプロファイルを固定SHAで実行する。レビュー担当は`harness/templates/governance_review_report.md`を使い、`summary.md`、`checks.json`、`commands.log`を共有証跡へ保存する。`DOCS_PASS`または`HARNESS_LOCAL_PASS`を出す場合だけ専用JSON verdictと`checkProfile`を必須とし、次の対応だけを許可する。

- `DOCS_PASS` / `docs-v1`: `scope-diff`、`docs-consistency`、`public-boundary`、`secret-patterns`、`source-immutability`
- `HARNESS_LOCAL_PASS` / `harness-local-v1`: `scope-diff`、`docs-consistency`、`node-syntax`、`harness-tests`、`workflow-yaml`、`workflow-embedded-js`、`action-pins`、`skill-validation`、`governance-diff-policy`、`public-boundary`、`secret-patterns`、`source-immutability`
- `FAIL`: 必須チェック不合格。成功用JSON verdictを作らず、`failure-record.json`の`failedChecks`を`checks.json`のFAIL項目と一致させ、根拠を記録して実装担当へ戻す。
- `BLOCKED`: 固定SHA、環境、lease、証跡不足などで判定不能。成功用JSON verdictを作らず、`failure-record.json`へBLOCKED項目と阻害理由を記録する。

`requiredChecks`、`executedChecks`、`checks.json`のcheck IDは、選択した信頼済みプロファイルと完全一致しなければならない。verdictが独自のcheck集合や未知profileを自己宣言して合格条件を差し替えることはできない。

`FAIL`/`BLOCKED`でも固定SHAとcleanなreviewer worktreeを維持し、共有`reviews/<gate-id>/`に非空の`summary.md`、`checks.json`、`commands.log`、`failure-record.json`を保存する。`validate-review-failure-record.mjs`がSELF_TESTED実装lease、reviewer lease、別session、レビュー時間、check結果、阻害理由、証跡pathを照合する。成功用`governance-verdict.json`または`review-verdict.json`が同じ失敗証跡に存在する場合は解放しない。

合格時も製品E2E、実GitHub設定、実App発行元、本人承認、マージ可能性を証明しない。製品がないことを理由に製品PASSを発行したり、製品タスクのブラウザ検査を省略したりしない。詳細は`harness/RUNBOOK.md`の専用手順を正とする。

### 静的ゲート

- タスク範囲と差分が一致する
- `sources/`変更が0件
- 秘密情報・実データ混入が0件
- 有料API・SNS投稿APIへの通信が0件
- 型、Lint、単体テスト、ビルド、DB移行がすべて成功
- テスト削除・スキップ・期待値弱体化がない

### 実ブラウザE2E

レビュー担当はアプリを起動し、Browserで主要フローを実際に操作する。Browserが利用できない、アプリを起動できない、証跡を保存できない場合は`BLOCKED`であり、`PASS`にしない。

必須表示条件:

- Mac相当: 1440×900
- MacBook相当: 1512×982
- iPhone相当: 390×844
- iPhone相当: 393×852

モバイルビューポートとWebKitは「iPhone相当」であり、実機SafariやVoiceOverの証明ではない。一般公開前は別途実機ゲートを設ける。

### 共通回帰シナリオ

全候補は`harness/regression_manifest.md`で管理する。各シナリオには`PLANNED`または`REQUIRED`と、必須化するIssueを記録する。

- レビュー時に実行するのは、既存の`REQUIRED`全件と、当該PRで初めて`REQUIRED`へ昇格するシナリオである。
- 未実装の`PLANNED`はテストのskipとして数えない。まだテスト対象に登録されていない将来要件である。
- 機能を初めて実装するPRは、対応シナリオ、テスト、manifestの`REQUIRED`化を同じPRへ含める。
- 一度`REQUIRED`になったシナリオを`PLANNED`へ戻す、削除する、適用除外にするには取締役会の期限付き例外が必要である。
- `PASS`の「必須テスト100%」は、その固定SHAで`REQUIRED`になっている全件を意味する。

回帰候補:

- 許可済みメールでログイン・ログアウトできる
- 未認証利用者が保護画面へ入れない
- ブランド作成・切り替えができる
- 投稿キャプションを全体・本文・ハッシュタグ別にコピーできる
- 画像1〜10枚を登録・並べ替えでき、11枚目を拒否する
- 15秒・30秒の9:16動画を登録・確認できる
- 字幕行を編集し、SRT・WebVTTを取得できる
- 予定時刻到来時に`要手動`と表示される
- 手動投稿後にURL・実公開日時を保存できる
- Instagram、X、TikTok、noteの投稿APIへ通信しない

日時テストは時計を固定し、日本時間、UTC変換、日付境界、月跨ぎを確認する。

### アクセシビリティ

- axeの`critical`・`serious`違反が0件
- キーボードだけで主要フローを完了できる
- フォーカス表示・順序・戻り先が適切
- 入力、ボタン、アイコンに識別可能な名前がある
- エラーを色だけで伝えない
- 200%拡大でも主要機能が欠落しない
- タッチ対象は原則44×44px以上

### 合格条件

- 必須テスト100%成功、スキップ0件
- 予期しないコンソールエラー、4xx、5xxが0件
- セキュリティ、データ損失、主要機能、レスポンシブ、重大アクセシビリティ不具合が0件
- 固定SHA、環境、画面寸法、実行日時、スクリーンショット、ログが揃っている

軽微な見た目の改善だけは、Issue化したうえで`PASS`を許可できる。必須要件の免除は取締役会決定として期限付きで記録する。

## 判定

- `PASS`: マージ・次工程の候補
- `FAIL`: 製品または要件に問題があり、実装担当へ差し戻し
- `BLOCKED`: 環境、認証、起動、証跡不足などで判定不能

レビュー担当はマージしない。CEOが`PASS`と証跡を確認後にマージを許可する。

## 証跡

```text
<git-common-dir>/sns-marketing-harness/reviews/<gate-id>/
  summary.md
  test-results.xml
  playwright-report/
  screenshots/
    mac/
    iphone/
  traces/
  console.log
  network.log
  accessibility.json
  environment.json
```

Cookie、トークン、パスワード、OAuth資格情報、個人データを証跡に含めない。

## GitHubゲート

現行の身元・権限モデルは `shared-admin`。人間の取締役会代表と自動化経路が同じ `ukyo-0001` を使える。実装・レビューのセッション、worktree、lease、固定SHAは引き続き分離する。

### 保証の境界

- 機械検査するもの: 固定SHA、テスト結果、証跡digest、status発行App、branch protection、Environment設定、実装/レビューsessionの分離。
- 同じ管理者IDだけでは証明できないもの: 操作したのが人間本人かエージェントか、管理者が将来保護設定を変更しないこと。
- `governance:approved` の付与者login照合は「許可されたID」の確認であって本人性の証明ではない。エージェントは取締役会承認ラベル、Environment承認、本人の最終承認を代行しない。
- 専用Gatekeeper Appはstatus発行元を限定するために維持するが、管理者そのものからの完全な隔離を保証したとは記載しない。
- 管理者利用の許可は、課金、公開、Secrets取得、保護設定の解除、MVP拡張の包括許可ではない。

### 維持する技術条件

既定ブランチ `main` に管理者を含む保護を適用し、bypass、force push、削除を禁止する。PRは最新mainを含む固定SHAで検証する。必須statusは次の7件とし、expected sourceを専用Gatekeeper Appへ固定する。

- `governance/protected-files`
- `quality/static`
- `quality/unit`
- `quality/e2e-chromium`
- `quality/e2e-webkit-mobile`
- `quality/accessibility`
- `review/independent`

workflow、Harness、Skills、意思決定記録、検証器の変更は製品PRと分離する。既定branchの信頼済み検証器を使い、PRコードを実行するjobへApp秘密鍵を渡さない。外部Actionは40文字の完全commit SHAに固定する。回帰manifestは通常PRで `PLANNED → REQUIRED` の昇格だけを許す。

独立レビュー証跡は固定SHA・leaseに結び付け、GitHub取得後に再ハッシュする。`review-evidence/**` は作成後の更新・削除・force pushを禁止する。公開証跡は合成データだけとし、原本、私的URL、実メール、実ブランド、Cookie、tokenを含めない。

### 本人承認と残ゲート

`board-review` Environmentは取締役会代表1名、管理者bypass禁止、既定branch限定、自己承認防止を維持する。App鍵はこのEnvironmentだけに置く。**自己承認防止を本整備のために無断で解除しない。**

同じ `ukyo-0001` がworkflowの実行actorになった場合、本人も承認できないことがある。schedule起動も別主体を保証しない。実runでactorを確認し、正当な本人承認が完了する正の試験と、未承認・拒否・古いSHA・偽statusを拒否する負の試験を実施する。衝突時は実行主体/承認方式を取締役会へ提案し、設定を勝手に弱めない。

`verify-repository-gates.mjs` は設定検査であり、成功しても実承認フローや人間本人の確認を証明しない。文書レビュー、ローカルハーネステスト、実リポジトリ準備、製品E2Eは別々の判定として記録する。

マージ後の `quality/post-merge-smoke` 合格まで `DONE` と次タスク解放を禁止する。製品の必須テストを文書検査で代替しない。正本は `harness/github_enforcement.md`、具体的操作は `harness/RUNBOOK.md`。

## 決定と例外の更新権限

- エージェントは取締役会案件を`PROPOSED`または`BOARD_DECISION`として提案できる。
- `APPROVED`、`REJECTED`、品質ゲート例外への変更は、利用者本人の明示的な発言をCEOが`harness/board_decisions.md`へ記録した場合だけ有効とする。
- 品質ゲート例外には対象、理由、承認者、承認日時、失効日時、再審査条件が必要である。
- 期限や対象が不明な例外は無効であり、通常ゲートを適用する。

## 禁止事項

- `sources/`の編集、移動、削除
- 課金、有料API、支払い手段登録
- SNSへの実投稿、実利用者へのメール送信
- 秘密情報、OAuth資格情報、実データのコミット
- 承認なしの破壊的DB変更
- Issue外の機能追加
- テスト削除・スキップによる見かけ上の合格
- 実装担当による自己承認
- 証跡なしの`PASS`
