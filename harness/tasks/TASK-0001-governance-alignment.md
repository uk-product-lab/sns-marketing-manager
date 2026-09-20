# TASK-0001 現行方針への文書・ハーネス整合

- 状態: `SELF_TESTED`（失敗証跡強制後の最終独立再監査待ち）
- 種別: governance（製品実装ではない）
- 承認: 2026-09-16「文書・ハーネス整備を開始してよい」
- 前提: DEC-009。管理者アカウントの自動化を許可し、実装と独立レビューの分離は維持する。

## 対象

- Plan、Harness、Runbook、現在状態、取締役会記録、実装・レビューSkillの整合。
- 同一管理者IDを拒否する旧検証条件の置換と、合成API応答による回帰テスト。
- GitHub/Notionの文書反映。公開可能な要件だけを使う。
- 長編動画・録音・写真・文章から統合マーケティング成果物を作る最終目標と、現MVPとの区別。

## 対象外

- 製品コード、製品E2E合格、実GitHub準備ゲートの合格宣言。
- GitHub保護設定・Environment設定の変更、App作成・鍵設定、workflowの稼働開始。
- 新規課金、Driveフォルダ作成、Cloudflare/Google実接続、本番公開、SNS投稿。
- MATLySの全情報、共有Notion DBの構造、既存ビュー、sources/。

## 受け入れ条件

1. 承認済み決定、提案、過去監査、現在の検証結果を区別する。
2. 管理者切断・machine account作成・write権限固定を現行の必須条件としない。
3. 同一IDでは本人操作の技術的証明ができないことを明示し、本人承認をエージェントが代行しない。
4. 固定SHA・独立レビュー・証跡・7つの品質チェック・製品実ブラウザE2Eを維持する。
5. Environmentの自己承認防止を無断で解除しない。実行actor衝突を含む実承認フローの正負試験を製品開始前の残ゲートとする。
6. 検証器の設定検査成功を実リポジトリ準備合格・人間承認の証明と混同しない。
7. 既存5機能、画像最大10枚、短尺15〜30秒9:16、Better Auth、手動投稿、保持必須の次期機能を維持する。
8. 独立した担当が固定スナップショットをレビューし、文書・ハーネス限定の結果を出す。
9. 文書・ハーネス専用のverdictとlease解放経路が、製品PASSを要求・発行せずに正負テストされる。
10. GitHubへの初回反映は実行workflowを除くdraft PRとし、merge・workflow稼働・live保護設定は実施しない。

## 検証

- 全Nodeスクリプト構文、変更した検証器の正常系・異常系テスト。
- workflow YAML・埋め込みJavaScript・外部Actionの完全SHA固定。
- Skill形式、参照先、文書間の整合、公開除外・秘密情報混入の検査。
- 文書・ハーネス専用verdict validatorとlease解放の正常/異常系。
- 外部反映後の再取得・内容照合。ローカルのみの成果は明記する。

## 作業方法

既存未コミット変更を保持する。コード担当はsources/を含めない独立した一時Git作業域でleaseを取得し、変更を引き渡す。統合後のレビューは別作業域・固定SHAで行う。ローカルの履歴を既存GitHub mainへ上書きしない。

## ローカル独立監査

- 対象固定SHA: `52cca6f964c2fe3daa42282279240b8c98deff4e`
- 判定: `HARNESS_LOCAL_PASS` / `BOARD_REVIEW_CANDIDATE`
- 結果: 必須12/12、ハーネステスト151/151合格、skip/fail 0
- 境界: 製品PASS、製品E2E、実GitHub準備合格、merge承認ではない
- 残作業: 本記録を含む最終固定SHAの再監査、GitHub draft PR、SNS側Notionへの要約反映と再取得確認

### 最終再監査での差し戻し

- 対象固定SHA: `bccb97efe92de88b7cd1ff8086bb577f12aa03d5`
- 判定: `FAIL` / `RETURN_TO_IMPLEMENTER`
- 指摘: `requiredChecks`をverdict自身が任意に縮小でき、必須12チェックを省略した偽の`HARNESS_LOCAL_PASS`を拒否できなかった
- 修正候補: validator所有の`docs-v1` / `harness-local-v1`を固定し、未知profile、outcome不一致、欠落・追加・偽1件集合、実行集合・証跡集合の不一致をvalidator直呼びと両profileのlease解放経路で拒否する。`FAIL`/`BLOCKED`は成功用JSON validatorと分離する
- 現在地: 修正候補の自己検証後、別session・別worktree・新しい固定SHAで最終再監査する。合格前にGitHub/Notionへ反映しない

### P1修正後レビューでの差し戻し

- 対象固定SHA: `0b0996b17ed48fb231ad8d658049c65d60fad386`
- 判定: `FAIL` / `RETURN_TO_IMPLEMENTER`
- 指摘1: `FAIL`/`BLOCKED`も成功判定用JSON validatorを使うように読める文書と、verdictなしで失敗leaseを解放する実装が矛盾していた
- 指摘2: check集合の不正をvalidator直呼びでは検証していたが、両profileのlease解放経路を通す完全な負試験行列が不足していた
- 修正候補: 成功判定だけをprofile付きJSONで検証し、`FAIL`/`BLOCKED`は成功用JSONなしで理由とcheck証跡を保存する。両profileについて偽1件、欠落、追加、未知profile、outcome不一致、実行集合不一致、証跡集合不一致をlease解放経路でも拒否する
- 現在地: 全必須テストを再実行して固定SHA化し、別session・別worktreeで最終再監査する。合格前にGitHub/Notionへ反映しない

### P2修正後レビューでの差し戻し

- 対象固定SHA: `66e57cc81910c75b25ce63cf59a84bb87e1d7e89`
- 判定: `FAIL` / `RETURN_TO_IMPLEMENTER`
- 指摘: 文書は`FAIL`/`BLOCKED`でも理由とcheck証跡を必須としていたが、`release-lease.mjs`は証跡入力なしでreviewer leaseを解放でき、既存テストもその抜けを正常動作としていた
- 修正内容: `failure-record.json`、`summary.md`、`checks.json`、`commands.log`を必須化し、固定SHA、clean worktree、SELF_TESTED実装lease、reviewer lease、別session、時間範囲、失敗/阻害check、阻害理由、証跡path、成功用verdict不在を専用validatorとlease解放経路で検証する
- 自己検証: 失敗証跡の正常/異常系を含むハーネステスト186/186、Node構文、workflow YAML、Action固定、両Skill形式、差分checkが合格。合否は本記述で自己宣言せず、固定SHAに対する別session・別worktreeの独立再監査を正とする
- 現在地: 新しい固定SHAを別session・別worktreeで再監査する。合格前にGitHub/Notionへ反映しない
