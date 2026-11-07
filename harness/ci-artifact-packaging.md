# CI証跡包装の限定hidden対応

この文書とTASK-0007はLOCAL候補の仕様である。公開、採用、実GitHub upload/download、本人承認、Repository Gate、製品PASS、MVP完成を宣言しない。旧PRの失敗と保存されなかった原物は変更せず、推測で補完しない。

## 欠落と保存境界

品質実行は`manifest.json`へ隠しファイルも含めた原物のpath・bytes・SHA-256を記録する。一方、固定した[upload-artifactの入力定義](https://github.com/actions/upload-artifact/blob/ea165f8d65b6e75b540449e92b4886f43607fa02/action.yml)では隠しファイルの入力既定値がfalseである。この違いにより、E2Eの`test-results/.last-run.json`がmanifestにはあるのに保存から落ちる可能性がある。

trueだけを指定すると出力内の`.env`なども公開対象を拡大する。修復は、実workflowの既存`budget` step内で対象を事前検査し、合格した場合だけ従来の全量上限検査とuploadへ進む構成とする。拒否原物を削除、除外、正規化、書換えして通さない。

## 正確な保存対象

5つの既存matrix gate（static、unit、e2e-chromium、e2e-webkit-mobile、accessibility）それぞれについて、対象は次の3根だけである。

```text
artifacts/ci/install-<gate>/
artifacts/ci/browsers-<gate>/
artifacts/ci/<gate>/
```

workspace、親フォルダ、別gate、追加根は受理しない。CWDからの`artifacts`、`artifacts/ci`、各根、内部entryをlstatし、symlinkと特殊fileを拒否する。根が生成前なら無断で原物を作らず、存在する根だけを検査する。保存原物が0件や空ファイルなら従来の非空上限検査が拒否する。

隠しフォルダと未知dotfileは常に拒否する。唯一の許可候補は、e2e-chromiumまたはe2e-webkit-mobileの品質gate根内にある、ちょうど`test-results/.last-run.json`の通常ファイルである。install、browsers、他gate、根直下、より深い配置、同名フォルダやリンクは拒否する。

## 限定メタデータ

package-lockのPlaywright 1.63.0を基準とする。インストールされた同版の`playwright/lib/runner/index.js`の`LastRunReporter.onEnd`と`playwright/lib/common/index.js`の`bindFileSuiteToProject`をREADし、次のserializerとID構造へ対応づける。

- 非空、64 KiB以下、strict UTF-8、JSON object。
- keyはこの順序の`status`と`failedTests`だけ。
- statusは`passed`、`failed`、`timedout`、`interrupted`。
- failedTestsは最大500件、重複なし。各IDは小文字16進20文字、ハイフン、小文字16進20文字。
- 原物bytesが`JSON.stringify({status, failedTests}, undefined, 2)`と完全一致すること。末尾改行なし。

不正JSON、未知key、重複key、順序違い、malformed UTF-8、BOM、文章やURL、型違い、重複ID、件数超過、余剰bytesは拒否する。JSON.parse後の構造検査だけでは消えた重複keyに原文を残せるため、元bytesをcanonical serializerと照合する。正規化したものを原物として保存し直さない。

このstatusは保存可能な構造かどうかの検査にのみ使用する。passedは品質PASS、failed等は保存不許可、という意味ではない。E2E開始前の失敗でメタデータがない場合は、存在する失敗原物を保存可能な対象と区別し、合格や完全証跡を捏造しない。

## 保存前の失敗と上限

inline検査の拒否・実行不能は固定の一般メッセージとexit1になる。任意のファイル名、内容、秘密候補を拒否ログへechoしない。既存stepの失敗をcatchして成功化せず、uploadの`always() && steps.budget.outcome == 'success'`という条件を維持する。

従来の`ci-upload-budget.mjs`は変更しない。3段階の全保存原物を圧縮前で20 MiB/500ファイル以内に制限し、超過時は切り詰めず拒否する。5品質jobの最大合計は100 MiB、保持は1日、標準Ubuntu runner、cache無効、権限・events・Actionの完全SHA固定も変更しない。アカウント全体の使用量や将来の無料運用をこの上限だけでは証明できない。

## 受入とLOCAL検証

`harness/tests/ci-artifact-packaging.test.mjs`は実workflowからNode heredoc、budget shell、uploadの3根・条件・hidden入力を抽出する。別の模擬validatorを正として実workflowを検査したつもりにしない。

| 受入 | 新しい検証 |
|---|---|
| PACK-001 | 全5gateの正確な3根、未知/絶対/親/workspace/別gate/追加/不足/順序違い、祖先・根・内部symlink、FIFO/socket |
| PACK-002 | 内部.env、未知hidden、hidden directory、誤gate/誤pathのlast-run、同名フォルダ |
| PACK-003 | 2E2E×4status、500 ID境界、不正JSON/key/型/ID/重複/UTF-8/bytes/容量の別登録反例 |
| PACK-004 | 実budget shellの拒否exit、上限検査未到達・upload条件false、原物不変、メタデータ生成前の失敗 |
| PACK-005 | 固定Action入力と実workflow結線、旧falseの欠落反例、trueだけの.env公開拡大反例 |
| PACK-006 | 実manifestと包装モデルの全path/byte/hash、合成tar往復、missing/extra/tamperedの拒否、対象外.env/原稿非選択 |
| PACK-007 | 本物の既存budgetで500/501、20 MiB/1 byte超過、3根合計超過、空/不存在、hidden/symlink拒否 |
| PACK-008 | 4path限定、既存89file byte/mode不変、全baselineと新case、全12checkのfresh SELFと別session/worktree/lease独立検証 |

各caseは一意IDで登録し、期待結果・実exit・一般エラー・guard source hashをraw診断へ残す。包装モデルは固定[Actionの隠しfile・共通祖先規則](https://github.com/actions/upload-artifact/blob/ea165f8d65b6e75b540449e92b4886f43607fa02/README.md#uploading-hidden-files)に対応づける。旧falseモデルでlast-runが落ちればmanifest照合が必ず拒否し、新trueモデルはguard合格後の全原物を合成archiveへ含める。

モデルとtar往復はGitHubのZIP生成、Linux、実ブラウザ、実端末、旧欠損原物の復元を証明しない。保存前guard後からActionが読むまでの変更競合を完全には排除できない。通常ファイルの任意内容も含めた全秘密検出をこのhidden検査だけで保証しない。外部導入・実保存・固定新SHAの本人承認・旧probeの新base/head再資格は別工程である。

## 変更・復旧

製品、既存validator/profile/ci-quality/ci-contract/ci-upload-budget/Skills/sourcesは変更しない。旧証跡と失敗記録を保存し、新SHA・clean作業域で全自己検証の後、別session/worktree/leaseで全独立検証を行う。最初の正式FAIL、実行不能、必須証跡不足は停止し、同SHA再実行だけの成功化を行わない。必要な修正は新SHAと全件検証へ戻す。

LOCAL上限はHARNESS_LOCAL_PASS/BOARD_REVIEW_CANDIDATE。採用やrollback等の外部変更は独断で実行しない。MVP全要件・予定と将来機能を減らす変更ではない。
