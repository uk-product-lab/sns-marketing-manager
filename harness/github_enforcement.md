# GitHub強制契約

更新日: 2026-09-16
現行モデル: `shared-admin`（DEC-009）。変更作業の範囲: DEC-010 / TASK-0001。

## 身元と権限の扱い

- board reviewerとautomation loginには同じ `ukyo-0001` を指定する。active Organization owner、対象repositoryのadmin権限を確認する。
- 管理者切断、別machine account、role `write` 固定は現行要件ではない。
- `separated-identities` は旧構成を検査する任意の互換モードであり、現在の利用者へ要求しない。
- shared-adminでも自動化credentialからSecrets/Variablesの一覧APIが拒否される検査を維持する。最小権限の資格情報を同じ管理者IDで使う構成を許す。アカウントのadmin権限と、使用中credentialの権限は別々に確認する。応答に含まれる秘密情報やその値を出力・保存しない。
- credentialの拒否試験が成功しても、同一IDの本人操作との完全な分離を証明したとはしない。広いコネクタを文書記入に使えることと、製品ゲートの資格情報が合格することは別である。
- 同じIDのラベル・承認は、人間操作とエージェント操作を技術的には区別できない。本人承認をエージェントが代行しない運用規則と、検証できる技術条件を区別する。
- 専用Gatekeeper Appはstatus発行元の識別に使う。adminが設定を変更できる以上、adminから完全に隔離できたとは表現しない。

## 維持するrequired checks

| Check | 発行元 | 製品がある場合の必須検査 |
|---|---|---|
| governance/protected-files | 専用Gatekeeper App | 信頼済みmain側guard、完全SHA固定 |
| quality/static | 同上 | typecheck、lint、build、test:migrate |
| quality/unit | 同上 | test:unit |
| quality/e2e-chromium | 同上 | test:e2e:chromium |
| quality/e2e-webkit-mobile | 同上 | test:e2e:webkit-mobile |
| quality/accessibility | 同上 | test:a11y |
| review/independent | 同上 | 固定SHAの独立実ブラウザ証跡、再ハッシュ、本人承認 |

mainに上記7件を厳密に設定し、expected sourceを専用App IDに固定する。管理者を含むbypass、force push、branch削除を禁止する。最新mainを含む固定PR headで検証し、未解決conversationを残さない。追加merge blockerで偽status負試験を誤合格させないため、現検証器はmain完全一致の保護rule 1件とstatus/conversation条件を検証する。

## 信頼境界

- 通常製品PRはworkflow、Harness、Skills、検証器、意思決定記録を変更できない。governance専用PRとして独立監査し、本人承認を得る。
- 外部Actionは40文字commit SHA固定。参照実在・実行可能性は実CIで確認し、構文合格で代替しない。
- `pull_request_target` は信頼済みmainの検証器だけを動かし、PRコードを実行しない。
- 品質再検証は秘密なしjob。App鍵を使うstatus発行jobは別runnerでPRコードを実行しない。
- App鍵は `board-review` Environmentだけに置く。チャット、公開repo、ローカル、repository/organization Secretへの重複保存をしない。
- 公開証跡は合成データだけ。固定SHA、base、PR、セッション、lease、テスト、証跡commit、digestを結合し、GitHub上のblobを再ハッシュする。
- `review-evidence/**` は作成後のupdate/deletion/non_fast_forward禁止、bypassなし。creationを塞がない。
- attestationコメントと`review:awaiting-board`ラベルの発行loginを宣言済みautomation loginへ固定する。同一IDモデルでは本人性までは証明しない。

## 本人承認

`board-review` Environmentには `ukyo-0001` 1名だけをrequired reviewerとして設定し、管理者bypass禁止・main限定・自己承認防止を維持する。今回の整備は設定変更を含まない。

同一IDがworkflowの実行actorの場合、自己承認防止により本人も承認できない。scheduleにもactorがあるため、定期起動を別主体とみなさない。実runのactor・trigger・固定SHA・本人承認・status発行をまとめて検証する。衝突時はDEC-012へ判断材料を追加し、設定を無断で解除しない。PR自己承認へ置き換えて解決したともみなさない。

公式仕様:
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#actor-for-scheduled-workflows

## 判定を分ける

1. `DOCS_PASS`: 文書・参照・決定整合のレビュー。製品合格ではない。
2. `HARNESS_LOCAL_PASS`: 固定スナップショットの構文・回帰・独立監査。実GitHub合格ではない。
3. `CONFIGURATION_VERIFIED_ONLY`: 検証器が取得したGitHub設定の検査成功。人間本人の承認、実行actor整合、App鍵隔離、実CIの成功は証明しない。
4. `REPOSITORY_GATE_PASS`: 実設定検査に加え、正当な本人承認の正の試験、未承認/拒否/古いSHA/証跡改変/別PR流用/未許可loginのattestation・待機ラベル/偽statusの負の試験、外部Action実行、独立監査が揃った場合だけ記録する。
5. 製品 `PASS`: その固定SHAの全REQUIRED＋追加受け入れ条件が実ブラウザE2Eを含め合格した場合だけ。
6. `POST_MERGE_PASS`: merge後smoke成功。ここまで次の依存タスクを解放しない。

現在、実リポジトリ準備は未合格。ローカルモックを実GitHubの証拠として提出しない。ハーネス変更を先にGitHubへ記載する場合は、文書・ローカル検証器のdraft PRに限定し、実行workflowを含めない。starterへ実体のある品質scriptを別タスクで追加した後にworkflowを別governance PRで導入し、live設定・正負試験へ進む。各段階の途中は`BLOCKED`を維持する。
