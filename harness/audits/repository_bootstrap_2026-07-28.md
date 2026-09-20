# GitHubリポジトリ準備ゲート記録

更新日: 2026-07-28
対象タスク: `TASK-0000`
現在の判定: `BLOCKED`

> 履歴スナップショット: 以下は2026-07-28時点の監査記録です。DEC-009により、管理者切断・machine account必須・role `write`固定は現行要件ではありません。現在状態は`harness/current_status.md`、現行手順は`harness/RUNBOOK.md`を正とします。

## 独立レビュー判定

- ローカル準備: `REPOSITORY_LOCAL_PASS`
- DEC-008 Organization版ハーネス: `ORG_HARNESS_PASS`
- 実GitHub準備ゲート全体: `BLOCKED`
- レビュー担当: 実装・修正を行わない独立サブエージェント
- 重大指摘: なし
- 条件: 監査済みのsetup-node修正と本記録をcommitし、cleanな新HEADを確認してからだけpush候補にする

独立レビューでは、workflow・canary YAML 5件、埋め込みJavaScript 8件、全`.mjs`構文、Action 29参照、`git diff --check`、`git fsck --strict`が合格した。公開禁止情報の混入も確認されなかった。

初回監査時点のOrganization修正案は`DOCS_PASS`だった。当時はGitHub公式のfine-grained PAT制約、GitHub Free Organizationの成立条件、`DEC-007 BOARD_DECISION`、実GitHubゲート`BLOCKED`が整合していた。その後の承認・実施結果は本記録の「2026-07-28 取締役会更新」を正とする。

## 完了した確認

- `DEC-004`: GitHub Publicを承認済み
- `DEC-006`: board owner、automation ID、Gatekeeper Appの分離を承認済み
- ローカルGitリポジトリを既定ブランチ`main`で初期化
- 初回コミット: `39b69c061f968ceea72ae82977e45b1e3ce5f34e`
- 公開対象41ファイルに`sources/**`、秘密鍵、PAT、環境変数ファイルが含まれないことを確認
- 外部Action 29参照が40文字SHA固定であることを確認
- 5種類の外部Action commitをGitHub公式API・公式commitページで実在確認

## 検出して修正した問題

初回コミットに含まれていた`actions/setup-node@1e60f620b9541dca151540d0c570f0c2f13a69be`は、GitHub公式APIでcommitが存在しなかった。構文上の40文字SHAだけでは不十分だったため、GitHub公式の署名済みimmutable release `v7.0.0`のcommit `820762786026740c76f36085b0efc47a31fe5020`へ置き換えた。

置換後、29参照の固定検査、workflow YAML解析、埋め込みJavaScript 7件、全`.mjs`構文、両SkillのYAML前置きを再検査し、すべて合格した。

## 接続状態

- GitHubコネクタ認証ユーザー: `ukyo-0001`
- GitHub App installation: 0件
- コネクタから参照可能なリポジトリ: 0件
- ローカル`gh`: `ukyo-0001`のtokenが無効
- remote: 未設定

## 2026-07-28 取締役会更新

- `DEC-007`: APPROVED。GitHub Free Organization `uk-product-lab`へPublicリポジトリを移管した。
- 公開URL: `https://github.com/uk-product-lab/sns-marketing-manager`
- 実ブラウザ確認: Public、空、初回push未実施、GitHub Apps 0件、Environments 0件。
- `DEC-004`: Public継続を再確認。第三者によるコード、履歴、Issue、PR、Actions logの閲覧・複製可能性を受諾した。
- 公開前再検査: `sources/`、`.env*`、秘密鍵は追跡対象0件。一般的な秘密文字列パターンを含む追跡ファイル0件。
- `DEC-008`: APPROVED。`ukyo-0001`を唯一の人間board owner、`uk-sns-automation`をautomation専用machine accountとする構成を採用した。
- Organization版ハーネス: owner/member、Public repository所有、repository roleを分離検証する版へ改訂。独立再監査は`ORG_HARNESS_PASS`。実credential検証は未完了。
- 実GitHub準備ゲート: `BLOCKED`を維持。board owner切断、machine account作成、初回push、GitHub強制設定、負試験が未完了。

## 停止理由

`DEC-007`のOrganization所有・Public継続と`DEC-008`の役割割当は承認済みだが、automation専用machine accountは未作成である。

採用済み`DEC-008`に従い、`ukyo-0001`をboard owner専用としてCodex、Claude Code、GitHubコネクタ、ローカル`gh`、エージェント制御ブラウザから切断する。新しいmachine accountだけをOrganization member・対象repository `write`として自動化へ接続する。この切断とmachine account接続を実証するまで初回pushへ進まない。

`verify-repository-gates.mjs`はOrganization型、唯一owner、automation active member、Public repository所有、repository roleを別々に検証する版へ改訂済みである。独立再監査は`ORG_HARNESS_PASS`だが、実credential検証、Gatekeeper App、Environment、branch protection、ruleset、同名status負試験は未完了である。

パスワード、二要素認証コード、PAT、秘密鍵は会話やリポジトリへ書かない。
