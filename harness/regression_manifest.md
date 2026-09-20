# 回帰シナリオ台帳

更新日: 2026-07-24

## 運用規則

- `PLANNED`: 将来要件。まだ必須テスト集合に入らず、skipにも数えない。
- `REQUIRED`: その固定SHA以降、すべてのレビューで実行する。
- 機能を導入するPRは、対応テストと同じPRで状態を`REQUIRED`へ変更し、`Enabled by`へIssue番号を記録する。
- `REQUIRED`の削除、後退、適用除外は、期限付き取締役会例外がなければ禁止する。
- 各レビューは「既存の`REQUIRED`全件 + 当該PRで`REQUIRED`へ変わる全件 + Issue固有の受け入れテスト」を実行する。

## 台帳

| ID | 状態 | シナリオ | Enabled by | 自動テスト |
|---|---|---|---|---|
| REG-AUTH-001 | PLANNED | 許可済みメールでログイン・ログアウトできる | - | - |
| REG-AUTH-002 | PLANNED | 未認証利用者が保護画面へ入れない | - | - |
| REG-BRAND-001 | PLANNED | ブランドを作成・切り替えできる | - | - |
| REG-COPY-001 | PLANNED | キャプションを全体・本文・ハッシュタグ別にコピーできる | - | - |
| REG-SLIDE-001 | PLANNED | 画像1〜10枚を登録・並べ替えできる | - | - |
| REG-SLIDE-002 | PLANNED | 11枚目の画像を拒否する | - | - |
| REG-VIDEO-001 | PLANNED | 15秒・30秒の9:16動画を登録・確認できる | - | - |
| REG-SUBTITLE-001 | PLANNED | 字幕行を編集し、SRT・WebVTTを取得できる | - | - |
| REG-SCHEDULE-001 | PLANNED | 予定時刻到来時に要手動と表示される | - | - |
| REG-MANUAL-001 | PLANNED | 手動投稿後にURL・実公開日時を保存できる | - | - |
| REG-NETWORK-001 | PLANNED | Instagram、X、TikTok、noteの投稿APIへ通信しない | - | - |

