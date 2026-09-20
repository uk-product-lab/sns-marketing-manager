# TASK-0000 実GitHubリポジトリ準備ゲート

- 状態: `BLOCKED`
- 更新日: 2026-09-16
- 種別: governance / live validation
- リポジトリ: `uk-product-lab/sns-marketing-manager`、Public、main
- 依存: TASK-0001の独立レビュー、実設定作業の範囲確認、DEC-012

## 目的

独立レビューの証跡・必須テスト・本人承認を確認した変更だけを進められることを、実GitHubで正負両方向から検証する。

## 現行方針

DEC-009により管理者 `ukyo-0001` を自動化に使用する。別machine account、管理者切断、role `write` 固定は要求しない。アカウントのadmin権限とは別に、使用するcredentialのSecrets/Variablesアクセス拒否を確認する。本人操作と同じIDのエージェント操作を技術的に区別できるとは主張しない。

## 対象

Runbook「0. 実GitHubリポジトリ準備ゲート」の設定確認、外部Action実CI実行、本人承認正の試験、偽status/証跡改変/古いSHA等の負の試験、独立監査。

## 対象外

製品コード、Cloudflare/Google OAuth/SNS API設定、本番公開、製品E2E、有料プラン、MATLyS・sources/。

## 受け入れ条件

1. 明示した `shared-admin` の実credentialで設定検査が成功する。
2. main保護、7 statusの専用App発行元、証跡ruleset、Environmentが正しい。
3. 実run actorを記録し、固定SHAの品質検査から本人承認、status発行まで正当なフローが完了する。
4. 未承認・拒否・古いSHA・別PR流用・証跡改変・未許可loginのattestation/待機ラベル・PAT/別branch Actionsによる同名status偽装を拒否する。
5. 失敗を別merge blockerで誤合格にしない。外部Actionの固定SHAが実行できる。
6. 独立担当が実証範囲と証拠URLを確認し、REPOSITORY_GATE_PASSを記録する。

設定検査のみの `CONFIGURATION_VERIFIED_ONLY`、ローカルfixtureテスト、文書レビューでは合格にしない。

## 必須の本人対応と未決

- 専用Gatekeeper AppとEnvironment鍵登録は秘密をチャットへ渡さず行う。
- Environment承認は本人が固定SHAと証跡を確認して行う。エージェントは承認しない。
- 自己承認防止と実run actorが衝突する場合、DEC-012を解決する。設定を無断で緩めない。
- 文書・ハーネス整備の着手許可だけでは、この実設定変更・実証作業の完了を意味しない。

## 現在の停止理由

既存GitHubにはスターターがある。2026-09-16の再取得ではmainのbranch protectionは無効であり、専用App、Environment、実承認の正の試験、負の試験の合格証拠もまだ揃っていない。まずTASK-0001を完了する。古いmachine account準備待ちを停止理由として使わない。

## 初回導入順序

1. TASK-0001の文書・ローカル検証器をworkflowなしのdraft PRとして提示し、固定SHAの`HARNESS_LOCAL_PASS`を得る。mergeは別途取締役会代表が判断する。
2. 別タスクでVite starterに実体のある品質scriptと最小テスト基盤を追加する。空script・常時成功scriptを禁止する。
3. 品質scriptが動く固定SHAを確認した後、別governance PRでGitHub Actionsを導入する。
4. workflowがmainで信頼済みになってからbranch protection、Gatekeeper App、Environment、証跡rulesetを設定する。
5. 設定検査、外部Actionの実CI、本人承認の正の試験、偽status等の負の試験を行い、独立担当が最終判定する。

途中段階では7 statusを必須化して初回PRを行き止まりにしない。各導入を別SHA・別証跡で記録し、最後の正負試験まで`BLOCKED`を維持する。
