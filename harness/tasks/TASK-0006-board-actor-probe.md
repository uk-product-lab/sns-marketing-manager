# TASK-0006 鍵なし本人承認probe（LOCAL実装・独立監査）

- 状態: READY（ローカルだけ。公開/実GitHub試験/mergeは未承認）
- 決定: DEC-022、DDR-0005第一候補、repository-settings-next-decision.md第一段階を採用。
- 目的: 同じ管理者IDを維持したまま起動tokenと本人承認を分ける経路を、秘密鍵なしの専用probeとして実装し、独立監査可能な固定候補を作る。実actor/本人承認の成功をローカル結果で証明しない。
- 要件: Plan REQ-AUTH-01/REQ-MVP-01〜05の開発統制前提。MVP全scope・将来機能は維持。製品機能の実装/削減ではない。
- 基準: actual main c48c9956965d4ae2a4204728ede2629bce3fb53d。開始前READ一致済み。PR #6採用と初回post-merge-smoke成功に依存し、Repository Gate自体へ循環依存させない。
- 担当: 実装/独立レビューは別session・別worktree、共有Git common dirの新lease。lease/SHAは取得後のprivate運営記録へ実値を保存、未取得を記載済みとしない。
- 変更可能: 下記5新規fileのみ。baseの既存93fileを変更しない。
  - .github/workflows/board-actor-probe.yml
  - harness/scripts/board-actor-probe.mjs
  - harness/tests/board-actor-probe.test.mjs
  - harness/tasks/TASK-0006-board-actor-probe.md
  - harness/board-actor-probe.md
- 対象外: 既存workflow/guard/validator/Skill/製品/package/DB/回帰manifest変更、旧QA/leaseの流用、実データ/原稿/素材、sources、GitHub push/PR/ラベル/attestation/status/実CI/設定/Environment/鍵/App/Secret/merge、課金、Cloudflare/Google/Drive/SNS/メール/Notion/MATLyS。
- REQUIRED昇格: なし（製品フローを追加しないgovernance専用）。既存REQUIREDは変更しない。

## 受入条件（すべて必須）

- PROBE-001: 専用workflowは手動workflow_dispatchだけで起動し、schedule/push/PR/webhookによる自動起動や本番独立レビューへの接続を追加しない。top-level permissions={}、標準Ubuntu/cacheなし、外部Action40桁SHA、job単位最小権限。秘密鍵/PR製品コード/本番statusを使わない。
- PROBE-002: owner/repo/main/workflowを固定し、actual ref/SHA/currentmain/attempt/actor/triggering_actorとAPI応答を再取得・型検査。GitHub API version2026-03-10を明示。dispatcherだけ必要Actions writeを持ち、受信側・protectedjobはREADだけ。token/header/署名URLをログへ出さず、任意URL/ref/入力キーを拒否する。
- PROBE-003: 一回dispatchの200/runID/URL応答を検証し、その真正IDをimmutable合成receiptへ結合する。元runは固定trustedmainの専用workflow・当該attemptで、受信runの実ID/SHA/ref/actor/phaseとreceipt全体が一致する場合だけ受信を認める。元runID/botlogin/公開nonceの自己申告だけでは通さない。欠落/偽receipt/別run/別repo/別SHA/未完了producer/期限外をfail-closedにする。受信の先行起動によるreceipt準備待ちだけは最大120秒・3秒間隔のREADに限定し、producer終端失敗・不正metadataで即停止、上限後はBLOCKEDとする。APIPOSTの自動retry・新dispatch・同一試験rerunは行わない。
- PROBE-004: 重複/再帰/未知mode/任意ref・stale SHA・attempt変化を拒否。実GitHubの同時実行/失敗時は証跡を残して停止し、同一入力を勝手に再dispatchしない。rerunは新runの本人判断/証跡なしに正のmarkerへ進めない。
- PROBE-005: Environment jobに到達する前に既存board-reviewをGETし、required reviewer ukyo-0001一名/main限定/self-review防止/admin bypass禁止を検証。未存在・不完全・changedmainは拒否し、自動作成や保護解除をしない。設定取得はSecret/Variables一覧APIではなく保護metadataだけ。
- PROBE-006: bot受信の正の経路・本人却下経路に加え、本人が直接起動するself-review負試験を明確に分ける。direct-negativeはGitHub自己承認防止の実検証用で、positive receiptやmarkerの成功扱いを絶対にしない。protectedjobも再確認し、本人承認をAPIで代行しない。
- PROBE-007: 合成marker、actualrun/deployment/reviewmetadataとローカルmock結果を区別。実Linux/実botactor/本人承認/self-review拒否/キー隔離/7status/Repository Gate/MVPの成功を今回発行しない。今後の実証手順と失敗/停止/権限別判断を文書化する。
- PROBE-008: 合成artifactは実upload合算20MiB/500file以内・保持1日、さらにreceiptは固定小容量/単一schemaで検査。空artifact・archive過大/余分file/パストラバーサル/改変・時刻/SHA/所属を拒否。信頼したAPIのdigestと原ZIPのSHA256を一致検査し、警告だけで継続しない。artifact原物の証明可能範囲を明記し、秘密やsignedURLを保存しない。
- PROBE-009: 既存93file/保護条件/固定profile/skip0を維持。new helperの正常・異常・runtime wiringを実fixtureで検証し、独立担当は同じ固定SHAのコードと別に作った負fixtureから判定する。失敗は原物保持、修正は新SHA・通常全必須検証で差戻し。同一SHAの失敗を消して再成功化しない。外部試験のretry/cancel/rollbackは別判断。

## 必須LOCAL検証と証跡

12 IDのharness-local-v1を厳密適用: scope-diff、docs-consistency、node-syntax、harness-tests、workflow-yaml、workflow-embedded-js、action-pins、skill-validation、governance-diff-policy、public-boundary、secret-patterns、source-immutability。

harness-testsは新probeのmock/負fixture/dispatcher・receiver/Environmentjob結線を含む全既存harness/tests/*.test.mjs。未実行やskipをPASSにしない。新probeの受入IDを12checkの根拠へ対応づけ、実actor試験はLOCAL対象外の未実施として別欄へ残す。governance-diff-policyはapproved governance入力を合成fixtureで検査し、人間のGitHub label付与済みとはしない。

raw command/start/end/exit、環境、固定SHA/tree/base、件数/skip、差分全hash、受入対応、失敗logを共有stateRoot（worktree外）へ保存。自己検証はSELF-20261107-PROBE-CURRENT-MAIN、独立はQA-20261107-PROBE-CURRENT-MAINの新gateを使う。gate IDを使い回して原物を上書きしない。

実装SELF_TESTED解放はCEOだけ。独立開始/終了clean、別worktree/session、期限内leaseを確認。成功時だけgovernance-verdict.json/checkProfileと非空summary/checks/commandsを用い、必須12 IDの完全一致とtaskIdを事前確認し、既存validatorを実行。FAIL/BLOCKEDは専用failure-recordと根拠を検証してCEO解放。validator/期待値/基準の変更はしない。

## 解放境界

HARNESS_LOCAL_PASSでもBOARD_REVIEW_CANDIDATEだけ。公開/PR/実CI/固定SHA採用/Environment設定/実probeは新固定SHA・具体scope・期限・無料条件を示す別本人判断。本人承認の実証、App/本保護、全正負試験、Repository Gateを省略せず、TASK-MVP-01をREADYにしない。

## 候補の結線と実行状態

実装値/将来手順/受入対応は `harness/board-actor-probe.md`、LOCAL fixture は `harness/tests/board-actor-probe.test.mjs`。全12check/SELF/独立QAの実結果は worktree 外の共有stateRootを正本にする。本契約のREADYは開始条件であり、候補作成やLOCAL自己テストを独立PASS・実GitHub成功とする記載ではない。固定SHA後の失敗をこの契約だけの書換えで成功化しない。
