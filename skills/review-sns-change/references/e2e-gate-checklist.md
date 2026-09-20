# E2Eゲートチェックリスト

## 固定

- [ ] 実装担当と別セッション
- [ ] PRと固定コミットSHAあり
- [ ] PRのbaseが現在の既定ブランチで、headが最新base commitを含む
- [ ] テスト中にSHA変更なし
- [ ] 製品コードを修正していない
- [ ] レビューlease取得済み
- [ ] 実装とレビューのセッションIDが異なる
- [ ] leaseが期限内
- [ ] 開始時と終了時にworktreeがclean
- [ ] 終了時のworktree HEAD・PR head・固定SHAが一致

## 静的

- [ ] `sources/`変更なし
- [ ] 秘密情報なし
- [ ] 有料API・SNS投稿API・実メール送信なし
- [ ] 型、Lint、単体・結合、build成功
- [ ] D1初期・更新移行成功
- [ ] スキップ・弱体化なし

## ブラウザ

- [ ] Browserで主要フローを操作
- [ ] 1440×900
- [ ] 1512×982
- [ ] 390×844
- [ ] 393×852
- [ ] 横スクロールなし
- [ ] 重要操作が隠れない
- [ ] 予期しないconsole error、4xx、5xxなし
- [ ] 外部SNS API通信なし
- [ ] 既存`REQUIRED`全件
- [ ] 当該PRで`REQUIRED`へ昇格する全件

## アクセシビリティ

- [ ] axe critical・serious 0件
- [ ] キーボード完遂
- [ ] フォーカス表示・順序・戻り先
- [ ] 識別可能な名前
- [ ] 200%拡大
- [ ] タッチ対象44×44px以上

## 証跡

- [ ] summary
- [ ] test results
- [ ] screenshots
- [ ] traces
- [ ] console
- [ ] network
- [ ] accessibility
- [ ] environment
- [ ] PASSの場合だけ`review-verdict.json`
- [ ] FAIL/BLOCKEDの場合だけ`failure-record.json`、`summary.md`、`checks.json`、`commands.log`
- [ ] implementation lease ID・review lease ID
- [ ] REQUIRED回帰IDがmanifestと一致
- [ ] 秘密情報・実ブランド情報なし、合成テストデータのみ

## 判定

- [ ] PASS、FAIL、BLOCKEDのいずれか1つ
- [ ] PASSなら必須テスト100%、スキップ0、証跡完備
- [ ] 判定と勧告の組み合わせが規定どおり
- [ ] PASSなら`validate-review-verdict`成功、FAIL/BLOCKEDなら`validate-review-failure-record`成功
- [ ] GitHub側で証跡commitのdigest再計算成功
- [ ] 専用Gatekeeper App発行のGitHub `review/independent`が同じ固定SHAで成功
- [ ] レビュー担当はマージしていない
