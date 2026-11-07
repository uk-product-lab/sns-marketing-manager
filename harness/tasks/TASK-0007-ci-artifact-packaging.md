# TASK-0007 CI証跡包装と限定hiddenメタデータ（LOCAL）

- Status: READY（2026-10-13T13:30:36Z。別READの安全境界指摘を下記へ固定し、CEOが既存LOCAL権限で開始契約を確定。新本人承認/外部導入/合格ではない）。
- 根拠: DEC-010/014/016の通常LOCAL依存整備、DDR-0006/0009。DEC-025の本人APPROVEDや消費済みDEC-024の転用ではない。
- 基準: actual main `5ae04298ef2f3bbdb1da89c620adfdaf9ad221b7`、既存90file。PR #5 fixedfbと5新規probeを取り込まない。
- Owner: 別実装agent/session `ci-packaging-implementation-20261013`、branch `codex/issue-0007-ci-artifact-packaging`。Reviewerは別agent/session/detached worktreeをSELF_TESTED後に割当。新lease/固定SHA/SELF/QAは取得後にprivate operator記録へ固定し、取得前に存在すると書かない。
- 依存: main5aeの採用済みCIコード、初回欠落のREAD証跡。Repository Gateを待つ製品工程ではなく、当該gateのLOCAL依存修復。
- 要件: Planの無料・秘密・品質・継続性制約。全MVP/AUTH/MOBILE/MEDIA/将来要件は不変。REG昇格なし、製品E2Eの合格を発行しない。

## 目的・許可4パス

初回CIが保存しなかった2hidden原物を将来の実保存で欠落させず、無関係なhidden/秘密を新しく公開対象にしないLOCAL候補を作る。

1. `.github/workflows/quality-gates.yml`: 既存budget step内に保存前fail-closed inline Node検査、uploadのhidden入力。既存出力3根/step ID/upload条件/runner/権限/events/cache/上限/1日保持/完全SHAは不変。
2. `harness/tests/ci-artifact-packaging.test.mjs`: 新正常・異常系。実workflowからinline検査を抽出・実行し、包装モデルを固定Action規則へ対応づける。
3. `harness/ci-artifact-packaging.md`: 保存対象/メタデータ/秘密境界/LOCALと実保存の区別・受入対応。
4. 本タスク契約。

既存90の変更はworkflowだけ。既存validator/profile/ci-quality/ci-contract/ci-upload-budget/Skill/製品/sourcesと旧証跡は変更しない。新依存/package/serviceを追加しない。

## 受入・必須ケース

- PACK-001: matrix5 gateの正確な3出力先のみ。workspace/親root/他gate/追加rootを受理しない。CWDからの祖先artifacts/ci、各root、内部entryをlstatし、symlink/special fileを拒否。3段階のない場合も既存budgetの非空全量上限に従い、存在する原物を無断除外しない。
- PACK-002: 全unknown dotfile/hidden directory/symlinkを拒否。唯一の許可候補はE2E gate rootの直下 `test-results/.last-run.json`。install/browsers/unit/誤配置に同名があっても拒否。
- PACK-003: 許可メタデータはstrict UTF-8 JSON object、keysはstatus/failedTestsのみ、statusはpassed/failed/timedout/interrupted、failedTestsは20lowerhex-20lowerhexの一意ID配列（最大500）。非空・64KiB以下。原物bytesが `JSON.stringify({status,failedTests},undefined,2)`（末尾改行なし）と完全一致することを確認し、重複key/未知key/URL/文章/不正ID/不正JSON/malformed UTF-8/余剰bytes/oversizeを拒否。原物を正規化/書換えして通さない。passed/failed等を品質PASSへ読み替えない。ローカルlocked Playwright1.63.0のLastRunReporter/bindFileSuiteToProjectをREAD根拠とする。
- PACK-004: 拒否はbudget outcome failureとして既存upload条件で保存を止める。失敗をcatch/maskして成功にしない。拒否ログは任意のファイル名/内容/秘密値をechoしない固定メッセージ。削除・原物除外・manifest改変・上限増額・継続成功化なし。
- PACK-005: 実workflow3根/inlineソース/hidden入力/固定ea165f8Action規則とテストを接続。旧入力falseはdotfile欠落を検出する反例になる。新設定trueだけ＋無検査の危険も負ケースにする。
- PACK-006: 正常fixtureでmanifestとローカル包装モデル/archiveの全path/byte/hash一致。欠落/余分/改ざんを拒否。対象root外の.env/原稿は包装しない。raw guard/preflight結果と各ケースの期待/実結果を新原物へ保存する。
- PACK-007: 全原物の圧縮前20MiB/500files、5job合算100MiB、保持1日、標準Ubuntu/cache無効、完全SHA pinを維持。既存上限検査を本物の合成正常/500境界/超過/hidden/symlinkケースに適用する。証跡を切り詰めて通さない。
- PACK-008: 4pathだけ/既存89file byte-mode不変、既存試験の削除・skip・期待値緩和なし。全 `harness-local-v1` 12 ID、全baseline harness＋新全ケースをfresh自己/独立検証、skip/cancel/todo/retry0。総数は実装前のbaseline宣言と新test登録集合から導出し、rawと照合する。

最低必須ケース: 正常passed/failedメタデータ、正しい2E2E/誤gate/誤path、対象root外.env、対象root内.env、hidden directory、未知hidden、root/祖先/内部symlink・特殊file、不正JSON/未知key/不正ID/重複key/重複ID/malformed UTF-8/余剰bytes/oversize/500超ID、旧false欠落、trueだけ無検査の危険、正常archive往復、missing/extra/tamper、既存件数・容量上限、E2E開始前の失敗でメタデータ未生成。ケースを統合する場合もすべての入力/期待結果を別記録する。

## 正式検証・開始/停止

READY契約→正規実装lease（4h/既存最大24h）→専用branch/worktreeの4path実装→新SHA/clean凍結→全構文/YAML/embedded JS/Action pins/両Skill形式/正常負fixture/public-secret-source境界を全12 checkでfresh自己検証→CEO原物/clean照合・SELF_TESTED解放→別session/worktree/期限内新review leaseで同全12/全fixture＋独自反例→CEO正式validator/原物全hash照合・正規解放。

実装前には実行driverの検査集合・必須包装fields・source/基準SHA・lease/session/gate対応を確認する。未知/不足を実行中に免除しない。最初の正式FAIL/実行不能/証跡不足で停止して原物・failure-recordを保存。同SHAのretryだけで成功化しない。修正後は新SHA/新自己/独立全件へ戻す。HARNESS_LOCAL_PASS/BOARD_REVIEW_CANDIDATEのみで、通常ゲートを免除しない。

## 対象外・残判断

公開/push/PR/label/実CI/rerun/close-reopen/merge/probe/設定/App/鍵/Secrets/Environment/保護/課金/製品READY、実利用者データ・他サービス・SNS/メール作用なし。LOCALモデルは実upload/downloadや実Linux/端末、全秘密検出、guard後からAction読取までの競合完全排除の証明ではない。新候補の外部導入と、修復採用後のprobe新head/base資格は別本人判断。

旧PR #5/初回CI failure/欠落2件と永久archiveは不変、過去の原物を推測補完しない。新実行結果が出ても元不足を復元したと書かない。
