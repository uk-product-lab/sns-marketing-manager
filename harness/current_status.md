# 現在の運営状態

更新日: 2026-09-18

## 確定した範囲

- フェーズ: TASK-0001 文書・ハーネス整備。着手承認済み（DEC-010）。
- 管理者 `ukyo-0001` の自動化利用: 許可済み（DEC-009）。
- 別machine account作成・管理者切断: 必須ではない。
- 独立レビュー、固定SHA、製品実ブラウザE2E、本人の最終承認: 維持。
- 製品機能実装・本番公開・実GitHub設定変更: 今回の作業対象外。
- MATLyS、共有Notion DB構造・既存ビュー、sources/: 変更禁止。

## 現在確認できた状態

- GitHub記載先: Public `uk-product-lab/sns-marketing-manager`、main。
- 2026-09-16に取得したREADME/package.jsonにはViteスターターが存在する。「空リポジトリ」は過去の記録。
- ローカルoriginは上記repoへ設定済み。ただしローカルとGitHubの履歴を同一とは扱わず、上書きpushしない。
- GitHub READMEはスターター用のまま。文書・ハーネスのローカル独立レビューは完了し、外部反映は未実施。
- SNS側Notionページは既存All Prjの項目。既存の親relationを維持し、本文とSNS専用の構成だけを対象にする。
- 製品の必須回帰は現時点ですべてPLANNED。製品E2E合格の証跡はない。
- 2026-09-16のGitHub再取得ではmain HEADは`cf2202c43c1c3c2d3da3a0b30ca14a06271323f6`、branch protectionは無効。Environment、Gatekeeper App、実承認、偽status負試験の完了証拠はない。古いApp installation数・CLI認証結果を現在の事実として流用しない。

## 判定

| 対象 | 状態 |
|---|---|
| 旧ハーネス設計 | 過去監査 HARNESS_PASS / ORG_HARNESS_PASS。旧モデルの履歴 |
| 現行文書・ハーネス | `52cca6f964c2fe3daa42282279240b8c98deff4e` の初回監査は `HARNESS_LOCAL_PASS`。`bccb97efe92de88b7cd1ff8086bb577f12aa03d5` は自己宣言check集合、`0b0996b17ed48fb231ad8d658049c65d60fad386` は失敗契約と解放負試験、`66e57cc81910c75b25ce63cf59a84bb87e1d7e89` は失敗証跡を要求しないlease解放のため、それぞれ `FAIL`。失敗証跡強制後の自己検証186/186は合格し、新固定SHAの最終独立再監査待ち |
| 実GitHub準備ゲート | BLOCKED（実証未完了） |
| SNS製品実装 | 未着手 |
| 製品実ブラウザE2E | 未実施 |

旧7回の監査と対応経緯は `harness/audits/harness_audit_2026-07-24.md`、旧Organization準備は `harness/audits/repository_bootstrap_2026-07-28.md` を参照する。過去の結果を書き換えず、改訂版の対象SHA・範囲・結果を新しい監査へ記録する。

## 未決事項

- DEC-005: 音声からの自動字幕生成。MVPのテキスト/時刻編集、SRT/WebVTT取得は維持。
- DEC-011: 既存Google AI Pro内Driveの原本庫利用、R2との役割、Mac miniの制作実行基盤。
- DEC-012: 同一管理者IDでの本人承認とworkflow actorの整合。自己承認防止の解除は未承認。

## 次の1手と解放条件

1. 3回の差し戻しを反映した固定スナップショットを、別担当が最終再レビューする。信頼済み`harness-local-v1`の12チェックすべてが合格するまで外部反映しない。
2. 公開可能な文書・検証器を、実行workflowを含めないGitHub draft PRへ反映する。進捗要約をSNS側Notionへ反映し、両方を再取得で確認する。workflow導入・merge・live設定は分ける。
3. 実GitHub設定作業の範囲とDEC-012の扱いを確認し、設定・実承認・正負試験を実施する。
4. REPOSITORY_GATE_PASS後に最初の製品タスクをREADYにする。製品PASSとmerge後smoke合格なしに次の依存タスクへ進まない。

外部公開・課金・秘密情報・MATLySへの変更は、作業継続のために推定で許可しない。
