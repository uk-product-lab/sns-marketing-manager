# 鍵なし本人承認 probe — LOCAL 設計と将来の限定実証手順

TASK-0006 / DEC-022。採用済みなのは専用 probe のローカル実装・別 session/worktree/lease による独立監査だけ。基準は actual main `5ae04298ef2f3bbdb1da89c620adfdaf9ad221b7`。既存90ファイル、製品、既存 independent-review、7 status、検証器、Skill、回帰台帳は変更しない。MVP/PoC 全 scope を維持する。

この文書と LOCAL mock の成功は、実 Linux、bot actor、本人操作、自己承認拒否、GitHub 費用、Environment 鍵隔離、Repository Gate、製品 PASS、公開、merge の証明・許可ではない。probe は本番 attestation/status へ接続しない。

## 実装値と処理

- 固定対象: Public `uk-product-lab/sns-marketing-manager`、`main`、`.github/workflows/board-actor-probe.yml`、`board-review`、本人 reviewer `ukyo-0001`。
- 手動 `workflow_dispatch` のみ。`dispatch` → 一回の組込み token POST → `receive` と、本人直接起動の `direct-negative` は別経路。確認文字列 `SYNTHETIC_PROBE_ONLY` は安全確認であり、外部実行の承認ではない。
- 既定権限 `{}`。dispatcher のみ Contents read / Actions write、他 job は read のみ。Actions write は dispatch 専用の権限ではないため、固定 workflow と監査を維持する。
- checkout 前の pinned Action が actual repo/ref/workflow SHA/current main/attempt/mode を拒否検査。checkout は当該 `github.sha`、credentials 永続化なし、harness scripts のみ。製品依存 install、PR コード、cache、Secrets/Variables API、Gatekeeper App/鍵、設定更新、承認 API、status 発行はない。
- API version `2026-03-10`。POST は一回だけ、200 の `workflow_run_id` / `run_url` / `html_url` を厳密検査。旧204、未知キー、不明応答、例外では停止し、再 POST、rerun、cancel、rollback をしない。
- producer と receiver の実 run を GET。workflow ID/厳密 path/main/head repository/current SHA/attempt1/phase title/actor ID/triggering actor/時刻を照合。nonce、bot login、元 run ID だけで許可しない。GitHub の JSON 入力キー順は信用せず正規化する。
- producer は API 応答の receiver ID と、GET した receiver 全観測を `dispatch-receipt.json` に結合する。pinned upload-artifact v4 が専用元 run の単一不変 artifact を発行し、producer 全体の `completed/success` 後だけ消費する。重複 UUID/同phase、重複 artifact、再帰、attempt2、他ref、stale SHA、fork、偽 receipt を拒否する。重複検査は同workflowの最大1000 runをページ取得し、上限超過/件数不整合/一覧取得競合はBLOCKEDとする。別SHAの同UUIDも再利用しない。
- receiver が先行した場合だけ最大120秒/3秒間隔の READ 待機。毎回 current main/Environment/run を再確認し、producer 終端失敗や不正 metadata では即停止。期限内 receipt が来なければ BLOCKED。完了 producer の欠落 receipt は待たず BLOCKED。HTTP/API 不明応答をこの待機で隠さない。
- receipt 寿命1時間、JSON 最大16KiB、原 ZIP 最大64KiB。metadata 所属/時刻/保持/サイズ/`sha256:` digest と取得した原 ZIP bytes の SHA256 を照合。警告で継続しない。ZIP は保存/deflate/data descriptor に対応し、単一固定名、CRC、local/central consistency、有限 inflation を検査してメモリ内で読む。抽出、ZIP64、複数disk、余分file、directory、traversal、symlink、暗号化、改変、曖昧/非canonical JSON を受け付けない。
- ZIP REST の302は固定 GitHub API にだけ token を渡す。signed storage URL は HTTPS の許可済み Azure blob/GitHubusercontent host、userinfo/任意port禁止。移動先へ Authorization を転送せず、再 redirect、過大応答、不明 provider は BLOCKED。signed URL/token/header は保存・表示しない。URL の有効期間やホスト変更を成功想定で埋めない。
- preflight は既存 `board-review` を GET して ID、本人一名、prevent self-review=true、admin bypass=false、厳密 main branch 一件を確認する。Secret/Variables 一覧は読まない。未存在/403/404/欠落値を見つけたら Environment job をスケジュールしない。
- 正の受信は actual `github-actions[bot]` / Bot / reviewer と異なる ID を receipt と共に要求する。そうならない場合は `RECEIVER_ACTOR_UNPROVEN` / BLOCKED。bot になることを保証しない。
- 承認後の別 runner は同じ provenance/receipt/Environment と READ review history を再確認し、本人 ID の当該 Environment 承認一件だけで合成 marker を作る。marker 自体も `humanOperationProven=false` / `repositoryGatePass=false` / `productPass=false`。ID/履歴だけでは人間本人が操作したことを証明しない。
- `direct-negative` は本人自身が起動し、同じ本人 reviewer の自己承認拒否を将来実検証する。もし保護 job が実行されたら必ず `SELF_REVIEW_NEGATIVE_UNEXPECTED_EXECUTION` で失敗し、正 marker/receipt は出さない。

## Artifact と原物の境界

保持は1日、overwrite=false、empty upload拒否。全5 upload site に各4MiB/100fileを割り当てるため、互いに排他的な経路を考慮しなくても合算20MiB/500fileを超えない。各 site は実 upload 対象を stat し、空file/symlinkを拒否する。receipt はさらに16KiB/64KiBの上限を持つ。これはアカウント全体の無料残量や請求なしの証明ではない。

v4 artifact の不変性・API metadata・元 run の信頼済み main コードは証明の前提。管理者は artifact/run を削除でき、その場合は欠落として拒否する。retention 後も原物があるとは主張しない。ローカル fixture の ZIP は実 GitHub 原物ではない。将来の実証では原 ZIP/hash/関連 API 観測を秘密/署名 URLを含めず別の承認済み証跡へ保存する。生の失敗は成功ログで上書きしない。

設定 READ と Environment job scheduling は原子的ではない。shared-admin がその間に Environment を削除/弱体化すると、GitHub の自動作成に到達し得る競合は残る。実行前 READ と承認後再 READ は通常の未設定到達を拒否し、marker の発行を止めるが、管理者からの完全隔離や競合なしを保証しない。実証中は本人が設定を固定して観測する必要がある。この残余を self-review 解除、別 ID/追加鍵、自動 retry で隠さない。

## 将来の実 GitHub 工程（すべて未承認）

1. 新固定 SHA と独立 `HARNESS_LOCAL_PASS` / `BOARD_REVIEW_CANDIDATE`、差分、通常ゲート・既存90file不変を提示する。
2. public push/PR/初回 CI、固定 SHA の採用、専用 workflow の trusted main 導入について具体対象・期限・無料条件・失敗時権限を本人と決める。今の main にはこの workflow がない。branch 上の candidate を実行して trusted main の証明にしない。未成立の本統制が初回導入を妨げる場合の狭い bootstrap 手順は未決であり、既存品質/保護条件を暗黙に免除・成功扱いしない。
3. 鍵なし `board-review` の保護設定と READ 実証、run/deployment 管理メタデータが残ること、実 probe の限定起動を別承認する。未保護 Environment を実行から自動作成しない。今回鍵/App/Secretの登録はしない。
4. trusted main/current SHA から新 UUID v4 で `dispatch` を一回起動。元/子 run URL、actor/actor_id/triggering_actor/attempt/workflow/ref/head SHA、receipt 原物/metadata、未承認時停止を確認する。本人操作をエージェントが代行しない。
5. 正の試験は本人が原物と固定値を確認して手動承認し、review metadata と合成 marker を照合。却下試験は別の新 UUID の別試験として本人が却下し、保護 job が marker に達しないことを確認する。同一失敗 run を自動再実行しない。
6. 本人が `direct-negative` を直接起動し、自己承認が GitHub で拒否されることを実確認する。LOCAL helper が拒否したことや保護jobがskipしたことを、この GitHub 実拒否の証拠にしない。unexpected execution は不合格。
7. 任意ref/stale SHA/偽receipt/別run/重複/再帰/attempt変化の負試験は個々の新入力・期限・必要操作を本人と決める。故意の攻撃 fixture を main 設定・既存 gate の変更に転用しない。

失敗/HTTP不明/actor衝突/費用不明なら、原物を保持して停止し、本人へ戻す。再 dispatch/rerun/cancel/設定変更/rollback/追加 App・鍵/別アカウント/保護弱体化の権限は推定しない。

## LOCAL 検証と引継ぎ

`node --test harness/tests/board-actor-probe.test.mjs` は実処理に injected synthetic API/clock を通す。単独 validator の正常値だけではなく、dispatcher/receiver/protected/negative の runtime entrypoint、実 ZIP writer の stored/deflate/stream descriptor、HTTP不明応答、偽 provenance、Environment変更、公開境界を検証する。workflow の embedded JS も構文解析・境界 entrypoint の mock 実行を行う。実 Linux/実 actor/本人操作の試験は今回未実施。

自己検証と独立監査は同一の固定 candidate SHA を対象とし、gate/session/worktree/lease と検証 scope を分離する。旧 SHA の自己検証・監査結果を新 SHA に代用しない。TASK-0006 は unchanged `harness-local-v1` の12 IDをすべて要求し、全既存 `harness/tests/*.test.mjs` の成功・skip0を含む。旧 QA/lease/PR例外を流用しない。必須検証失敗時は原物を保存し、新 SHA で通常の全必須検証から差戻す。CEOだけが正規 validator と clean固定 SHAを確認してleaseを解放する。

| 受入 | 主な LOCAL 根拠 |
|---|---|
| PROBE-001 / PROBE-002 | workflow YAML/embedded JS、Action pins、boundary runtime、権限/checkout/固定API/未知入力 fixture |
| PROBE-003 / PROBE-004 | 一回POST/不明応答、実受信ID照合、元/子run/時刻/SHA/所属、READ準備待ち/重複/再帰/attempt fixture |
| PROBE-005 / PROBE-006 | 保護前と保護後 Environment/履歴 fixture、本人直接negativeの別結線/必ず失敗 |
| PROBE-007 / PROBE-008 | marker境界/公開・秘密検査、digest/ZIP/CRC/descriptor/過大/余分file/取得/合算budget fixture |
| PROBE-009 | 固定SHA/tree/base/差分hash、既存90file不変、全必須12check/既存test/skip0、別lease/session監査 |

ローカル証跡の実値・開始/終了時刻・ログ・件数は worktree 外の共有 stateRoot に保存し、この手順に未実行結果を記入しない。製品回帰の REQUIRED 昇格はない。TASK-MVP-01 は Repository Gate/採用設計/READY/新leaseまで解放しない。

## 公式仕様の根拠

[dispatch200/runID](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[run/review履歴](https://docs.github.com/en/rest/actions/workflow-runs)、[artifact metadata/302](https://docs.github.com/en/rest/actions/artifacts)、[artifact digest mismatchはwarning](https://docs.github.com/en/actions/tutorials/store-and-share-data#validating-artifacts)、[v4不変artifact](https://github.com/actions/upload-artifact)、[Environment保護](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)。これらは設計仕様の根拠であり、実環境の成功証拠ではない。
