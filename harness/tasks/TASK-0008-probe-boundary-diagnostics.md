# TASK-0008 probe boundary診断候補（LOCAL）

- 状態: READY（DEC-035のLOCAL新候補一つ・SELF/独立資格一系列のみ）。
- 基準: main `8641e60728b12b8b471ae3310cf0b2cc0ad2ff3e` / tree `f4f6c1391ed518cefa49b05c109a841930bb322d`。TASK-0006の採用と初回smoke成功に依存するgovernanceタスク。製品Repository Gateを待つタスクではない。
- 目的: 初回実probeのcheckout前拒否を、秘密を出さない個別理由で観測できる新候補にする。旧run42446097435はPROBE_CONTEXT_REJECTED、受信run/receipt/承認履歴0。実event payloadは欠測、個別原因は未確定。空input省略説は証明していない。
- 要件: Planの無料/秘密/独立レビュー制約、REQ-AUTH-01・全MVPの開発統制前提。製品や将来機能のscopeは変更しない。REG昇格なし。
- 期限: DEC-035の2026-11-20T23:59:59Z以内。通常4h/最大24hの新lease、実装/レビュー別session・別worktree。取得後のlease/SHA/session実値はworktree外のprivate運営記録へ残す。

## 変更可能領域

- `.github/workflows/board-actor-probe.yml`（boundaryの局所診断だけ。他job/権限/events/pins/API/timeout/upload/保護結線は維持）
- `harness/scripts/board-actor-probe.mjs`（診断へ必要な場合だけ。既存actor/receipt/入力/保護検査は緩めない）
- `harness/tests/board-actor-probe.test.mjs`（既存試験を保持し新負fixtureを追加）
- `harness/board-actor-probe.md`
- 本タスクと`harness/decisions/DDR-0016-probe-boundary-diagnostics.md`の新規2文書

baselineの他ファイルはblob/mode不変。既存TASK-0006/0007、validator/profile/Skills/品質workflow/製品/package/DB/回帰manifest/sources/MATLySと旧原物は変更しない。新依存や外部サービスを追加しない。

## 受入（すべて必須）

- DIAG-001: checkout前の元境界で拒否する条件と安全側停止を維持する。許可されるevent/repo/ref/workflow/attempt/SHA/mode/input key集合を拡張しない。元の総合拒否`PROBE_CONTEXT_REJECTED`も既存の観測として保持できる。未知キー/誤型/欠落を通すためのdefault化はしない。
- DIAG-002: 各拒否predicateを静的な理由コードで識別する。複数違反も明確にし、診断が拒否やmain実READより後の危険処理に到達する条件にならない。正常時も実main GETは維持。
- DIAG-003: 診断は既知入力キーの存在・静的な型、未知キーの件数、一致/不一致、静的理由コードなどに限定する。未知キー名・入力値・event全体・token/header/署名URL・実データ・任意の例外値をechoしない。診断生成の例外を成功へ変換せず、変な入力でもcheckout/POSTせず固定エラーで停止する。
- DIAG-004: 通常6入力、空任意入力の省略、未知キー、非object/null/array、必須の欠落・誤型、未知mode、receiveのsource欠落、誤event/repo/ref/workflow/attempt/SHAを区別する。sourceの厳密検査は後続既存parseInputsに保持。workflow実embedded JSを抽出・mock実行し、実結線の診断/拒否/API未到達も検証する。fixtureは実GitHub payloadの証明ではない。
- DIAG-005: 攻撃的な未知キー名・入力値・ref/SHA等へ合成秘密を入れ、診断へ漏れないことを負fixtureで確認。入力全体のdumpや任意テキストの出力を禁止する。既存試験の削除/skip/期待緩和なし。
- DIAG-006: 既存actor/receipt/Environment/一回POST/ZIP/各上限と正負runtimeを維持する。根因が未特定なら候補の位置付けは診断追加だけ。特定・修復済み/実actor成功/本人性/実GitHub成功を発行しない。
- DIAG-007: 全変更path/hash・baseline他blob/mode不変、全harness test登録と新規登録を導出し、全件成功/skip/cancel/todo/retry0。全12checkを新固定SHAでfresh実行、別担当は独自負fixtureも作る。初回正式FAIL/実行不能/不足は原物保存して停止、同SHA追加retryなし。
- DIAG-008: 生command/start/end/exit、method/source/inventoryの初版hash・schema/profile/lease/session/Gate対応を正式前にREAD/GO。初回正式validator、CEO全原物照合・正規lease解放が揃ってHARNESS_LOCAL_PASS/BOARD_REVIEW_CANDIDATEのみ。旧資格のコピーや製品/Repository Gate PASSへ転用しない。

## 必須LOCAL検査

固定`harness-local-v1`の12 ID: scope-diff / docs-consistency / node-syntax / harness-tests / workflow-yaml / workflow-embedded-js / action-pins / skill-validation / governance-diff-policy / public-boundary / secret-patterns / source-immutability。

全`harness/tests/*.test.mjs`と新登録・独自反例を対象とする。総数はsource登録集合から導出し、旧591件に固定しない。YAML/embedded JS構文と実mock、Action pins、両Skill形式、governance diff policyの正常負fixture、公開/秘密/source境界を含む。製品E2Eは対象外で未実施。

実装は候補を新SHAへcommit・clean凍結し、CEOのmethod/schema/source/inventory READ/GO後に正式SELFを一度だけ実行する。全件成功・原物照合後にCEOがSELF_TESTED解放し、別agent/session/worktreeの新review leaseで同一SHAを独立検証する。成功用とFAIL/BLOCKED用の証跡/validatorを分離し、必須検査失敗を成功JSONで解放しない。

## 対象外と返却

実GitHubのpush/PR/CI/採用/診断run/再dispatch/却下/直接negative/取消/rollback/設定変更、本人承認代行、App/鍵/Secret/課金、他サービス/実SNS/email/Notion/MATLyS/実データ、製品READYは行わない。

新候補のLOCAL原物と固定SHAを返し、外部で何を一度観測するかは別の本人判断へ渡す。旧run42446097435・使用済みUUID・ログ原ZIP/旧正式FAIL・成功資格を不変保存する。
