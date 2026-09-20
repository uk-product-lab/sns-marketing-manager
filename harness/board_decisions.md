# 取締役会決定記録

更新日: 2026-09-16

## 確定

### DEC-001 無料運用

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-24
- 根拠: 本会話で課金しない方針を明示
- 対象範囲: 個人用MVP
- 決定: MVPでは課金が発生する外部サービスを利用しない。
- 影響: Xを含むSNS API連携は行わず、手動投稿パックまでを作る。

### DEC-002 認証

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-24
- 根拠: 本会話でBetter Auth、Google認証、メール認証を明示
- 対象範囲: 個人用MVP
- 決定: Better Auth、Google認証、メールアドレス + パスワード認証を使う。
- 影響: 個人利用中は許可メールを制限し、メール送信が必要な確認・再設定は後回しにする。

### DEC-003 品質ゲート

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-24
- 根拠: 本会話で独立レビュー、実ブラウザE2E、合格時のみ進行を明示
- 対象範囲: 全実装PR
- 決定: 実装担当とレビュー担当を分離し、レビュー担当が実ブラウザE2Eを含む全必須ゲートに`PASS`を出した場合だけ次工程へ進む。
- 影響: `FAIL`と`BLOCKED`ではマージ・次タスク解放を行わない。

### DEC-004 GitHubリポジトリ

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-28
- 根拠: CEOが「公開リポジトリで進めてよければGitHubリポジトリ準備ゲートへ入る」と提示し、取締役会代表が準備ゲートの進行を指示
- 決定: GitHub Free Organization `uk-product-lab`所有の`sns-marketing-manager`をPublicで準備する。
- 影響: ソースコードと合成データのレビュー証跡は公開される。秘密情報、実アカウント情報、`sources/`は公開しない。
- 2026-07-28再確認: 取締役会代表が「Publicで継続」と明示。初回push後はコード、履歴、Issue、PR、Actions logが第三者から閲覧・複製可能であり、後からPrivateへ変更しても既存の複製を回収できない前提を受諾する。
- 秘密管理: Cloudflareデータ、利用者情報、APIキー、OAuth secret、認証secretをGitへ入れず、CloudflareまたはGitHubのSecretへ保存する。push前に追跡対象と秘密パターンを検査し、検出時は公開しない。
- 参照: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

### DEC-006 独立レビュー承認ID

- 状態: PARTIALLY_SUPERSEDED_BY_DEC-009（以下は旧決定の履歴。管理者と自動化IDの分離条件は廃止）
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-28
- 根拠: DEC-004と同じ進行指示により、CEO推奨の準備ゲート構成を採用
- 決定: エージェント未接続のboard owner ID、対象リポジトリ限定のautomation ID、専用Gatekeeper GitHub Appを分離する。
- 現在の割当: `ukyo-0001`が唯一の人間board owner、`uk-sns-automation`がautomation専用machine account、専用Gatekeeper GitHub Appがstatus発行主体。machine accountとAppは未作成・未接続。
- 影響: owner IDをCodex、Claude Code、GitHubコネクタ、ローカル`gh`、エージェント制御ブラウザへ接続しない。Gatekeeper秘密鍵は`board-review` Environmentだけに置く。
- 参照: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments

### DEC-007 GitHub所有形態の修正

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-28
- 発見日: 2026-07-28
- 決定: GitHub Free Organization `uk-product-lab`でPublicリポジトリ`sns-marketing-manager`を所有する。
- 実施記録: `ukyo-0001`から`uk-product-lab`へのtransferと、公開URL`https://github.com/uk-product-lab/sns-marketing-manager`を実ブラウザで確認した。リポジトリは空であり、初回pushは未実施。
- 判明した制約: fine-grained personal access tokenは、token所有者がoutside collaboratorまたはrepository collaboratorであるリポジトリへの書き込みに対応していない。
- 影響: Organizationをresource ownerとする対象限定fine-grained PATを利用できる。ownerとautomationの割当は`DEC-008`で確定した。
- 参照: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- 参照: https://docs.github.com/en/organizations/collaborating-with-groups-in-organizations/about-organizations
- 参照: https://docs.github.com/en/get-started/learning-about-github/githubs-plans

### DEC-008 GitHubアカウントの役割割当

- 状態: PARTIALLY_SUPERSEDED_BY_DEC-009（以下は旧決定の履歴。管理者の自動化禁止とmachine account必須条件は廃止）
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-07-28
- 承認根拠: CEO提示の選択肢Aに対し、取締役会代表が「この構成で進めて」と明示した。
- 発見日: 2026-07-28
- 決定: GitHub利用規約と`DEC-006`の独立性を両立するため、選択肢Aを採用する。
- 制約: 1人は無料Personal Accountを1つだけ維持でき、それに加えて自動処理専用の無料machine accountを1つ維持できる。2つ目の人間用無料Personal Accountは作らない。
- 採用構成: 既存Personal Account `ukyo-0001`を唯一の人間board owner専用にし、新しい無料machine account `uk-sns-automation`をautomation専用としてGitHub Organization `uk-product-lab`のmember・対象repository `sns-marketing-manager`のrole `write`にする。
- 分離条件: `ukyo-0001`をCodex、Claude Code、GitHubコネクタ、ローカル`gh`、エージェント制御ブラウザから切断する。`uk-sns-automation`の対象repository限定fine-grained PATだけを自動化credentialとし、GitHubコネクタは同じmachine accountで最小権限を証明できる場合だけ接続する。
- Gatekeeper分離: 専用Gatekeeper GitHub Appは`uk-sns-automation`とは別主体として維持し、秘密鍵は`board-review` Environmentだけに置く。
- 未実施: board ownerの全自動化経路からの切断、machine account作成、Organization member化、repository role `write`、credential設定、Gatekeeper App作成は未完了であり、実GitHub準備ゲートは`BLOCKED`を維持する。
- 不採用案B: 別の実在する人をOrganization ownerに招待し、`ukyo-0001`をautomationにする。個人MVPに不要な外部依存が増える。
- 不採用案C: `ukyo-0001`をowner兼automationにする。独立承認が成立しない。
- 参照: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- 参照: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/switching-between-accounts

### DEC-009 管理者アカウントによる自動化を許可

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-09-16
- 承認根拠: 「管理者アカウントを自動化に使わないということを廃止します。」という明示指示。
- 決定: `ukyo-0001`による承認済み範囲の自動化・GitHub記入を許可する。管理者のコネクタ・CLI等からの切断を要求しない。
- 置換対象: `DEC-006`と`DEC-008`の管理者とautomation IDの分離、machine account作成、automationのrepository roleを`write`に固定する条件、専用machine accountのfine-grained PATのみを認める条件。新しいメールアドレスや記入専用GitHub Appの作成は必須としない。
- 今回の実行: 既存の依頼に基づき、独立文書レビュー合格後に`sns-marketing-manager`のREADMEを接続済み管理者アカウントで更新する。
- 維持する条件: 無料運用、秘密情報・`sources/`の非公開、利用者が指示した対象範囲、実装担当とレビュー担当の分離、製品変更の必須テストと実ブラウザE2E、テスト不合格で次工程へ進まないこと。
- 承認の扱い: 同じアカウントを利用しても、人間が行う最終承認をエージェントが本人に代わって付与したことにはしない。アカウントIDだけで人間とエージェントの行為を区別する保証は失われるため、承認の実行主体と証跡の確認方法を改訂する。
- 残作業: Gatekeeper App・Environmentなどの既存設計と`verify-repository-gates.mjs`は旧分離モデルを含む。新方針に整合させて独立再監査するまで製品実装用ゲートを`PASS`としない。旧モデルの未達をREADME記入の停止理由にはしない。
- 優先順位: 本決定に矛盾する旧手順・監査記録・検証条件は、現在の管理者利用を禁止する根拠として適用しない。

### DEC-010 文書・ハーネス整備の着手

- 状態: APPROVED
- 承認者: 取締役会代表（利用者本人）
- 承認記録日: 2026-09-16
- 根拠: 「文書・ハーネス整備を開始してよい」という明示指示。
- 決定: TASK-0001の範囲で文書、Skill、検証処理を現行方針へ整合し、独立レビューする。公開可能な文書をGitHubへ、進捗要約をSNS側Notionへ反映してよい。
- 維持する境界: 製品実装、課金、実GitHub保護設定の変更、Environment自己承認防止の解除、本番公開、Driveフォルダ作成、MATLySおよび共有Notion構造の変更は含まない。
- 最終構想: 長編動画・録音・写真・文章から、専門担当が連携してSNS・note・LPの統合マーケティング成果物を作る要求を計画へ記録する。全機能のMVP前倒しやAPI契約の承認とはしない。
- 契約前提: Google Workspaceは未契約、Google AI Proは契約済み。利用可能なAPI特典・容量・残量・無人処理能力は未確認。

## 未決

### DEC-011 原本保存先と制作実行基盤

- 状態: BOARD_DECISION
- 提案: 非公開Driveを原本・完成物の保存先、Mac miniを重い制作処理の実行先とする。R2は費用条件を検証するまで実接続しない。
- 未決: R2中心の既存案からどこまで変更するか、Mac miniの稼働時間、代表素材の長さ・容量、追加費用なしで利用可能な処理手段。
- 現在の許可: 必要なら専用Driveフォルダを使用する構想は利用者から提示済み。ただし今回の着手範囲では作成・接続しない。

### DEC-012 同一管理者IDでの実承認経路

- 状態: BOARD_DECISION
- 問題: Environmentの自己承認防止とworkflow実行actorが同一のとき、唯一の本人reviewerが承認できない可能性がある。
- 維持: 自己承認防止、本人の最終確認、専用App発行元検査を無断で解除しない。
- 次の判断材料: 実run actorと本人承認の正の試験。衝突する場合は別実行主体または明示的な承認方式改訂を比較する。別machine accountを暗黙に必須化しない。
- 合格の意味: 同一IDでは本人操作とエージェント操作の区別は運用上の制約であり、ID照合だけを本人性の証明としない。

### DEC-005 動画字幕の自動生成

- 状態: BOARD_DECISION
- 決めること: MVPで音声から字幕を自動生成するか、文章貼り付け + 時刻調整までにするか。
- CEO推奨案: MVPは文章貼り付け + 時刻調整。端末内音声認識は次段階。

## 品質ゲート例外テンプレート

例外は取締役会代表の明示承認がある場合だけ追加する。

- 決定ID:
- 状態: BOARD_DECISION | APPROVED | REJECTED | EXPIRED
- 対象:
- 理由:
- 承認者:
- 承認日時:
- 失効日時:
- 再審査条件:
- 代替安全策:
