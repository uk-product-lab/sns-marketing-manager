# TASK-0013 本番board gateをbot起動の子runへ移す

- Status: READY（LOCAL実装と独立 `HARNESS_LOCAL_PASS` の範囲。公開・PR・CI・マージ・設定変更は範囲外で別判断）
- Owner: 未割当（実装担当。主担当=CEOはClaude Code）
- Owner Session:
- Reviewer: 未割当（実装と別セッション）
- Reviewer Session:
- Implementation Lease ID:
- Review Lease ID:
- Branch: `claude/issue-0013-board-gate-bot-dispatch`（実装担当の割当時に確定）
- Implementation Worktree:
- Review Worktree:
- Pull Request:
- Fixed Commit SHA:
- Gate ID:
- Dependencies: 基準は `main` `2401ece333ee475840452b8c474edc3b4b70dabb`（TASK-0011採用後）。着手時に最新mainを再読する
- Requirement IDs (Plan.md): 製品要件なし（共通制約「独立レビュー・必須テスト・本人承認を維持する」を実装する統制）
- Decision IDs: DEC-050（DEC-012の解決）、DDR-0019、DEC-031（LOCAL継続）、実証根拠DEC-047/048/049

## 目的と利用者価値

本人が固定SHA・証跡を確認して承認した変更だけが7 statusを得てマージできる、という本番の承認ゲートを実際に動く状態にする。現行の `independent-review.yml` は `board` jobがscheduled run内にあり、actorが `ukyo-0001` になるため、`prevent_self_review` により唯一のreviewerである本人が承認できない。鍵なしprobeで実証した「組込みtokenで起動した子run（bot actor）を本人が承認する」経路を本番へ移す。

## 対象範囲

1. `independent-review.yml`（schedule）は `prepare`（選定・attestation検証・ラベル遷移）と `verify`（秘密なしの信頼済み再検証）までとし、Environmentを使う `board` jobを持たない。`verify` 成功後、組込みtokenで子workflowを**一度だけ** `workflow_dispatch` し、親子を結ぶreceiptを単一の不変artifactとして残す。
2. 新しい子workflow（仮 `.github/workflows/board-gate.yml`、`workflow_dispatch` のみ）: checkout前の境界検査 → preflight（親runとreceiptの照合、`board-review` 設定のREAD）→ `board-review` Environmentの保護job → 承認後の再照合 → Gatekeeper App tokenで7 status発行 → `review:board-pending` から `review:approved` へ遷移。
3. 親子の結合と検査はprobe helper（`harness/scripts/board-actor-probe.mjs`）の検証済み部品を再利用する。共有部品の切り出しは可。probe自体の挙動・workflow・受入（PROBE-001〜009、TTL-001〜004）を変えない。
4. 手順書（`harness/RUNBOOK.md` §5、`harness/github_enforcement.md` の本人承認節）を新経路へ整合する。

## 対象外

GitHubへの公開・PR・CI・マージ、Gatekeeper Appの作成と鍵登録、main保護・ruleset・ラベルの設定、検証器（`verify-repository-gates.mjs`）の拒否検査の変更、`board-review` 設定の変更、実run・実承認、製品コード、回帰manifest、`sources/`。自己承認防止の解除と別machine accountの導入（DEC-050で不採用/保留）。

## 受け入れ条件

- [ ] BGT-001 親（schedule）にEnvironment jobが存在しない。子の起動は `verify` 成功かつ選定済みの場合に限り、POSTは一回、200応答の `workflow_run_id / run_url / html_url` を厳密検査し、不明応答・例外では再POST・rerun・cancelをしない。
- [ ] BGT-002 子は `workflow_dispatch`・対象repo・`refs/heads/main`・現在のmain SHA・attempt 1・既知入力のみを受理する。**actorとtriggering actorが `github-actions[bot]`（Bot、reviewerと異なるID）でない起動は、checkoutとEnvironmentより前に拒否する**（本人や第三者の直接起動を承認待ちへ進めない）。
- [ ] BGT-003 子のpreflightは、親runが同一workflow ID・厳密path・main・現在SHA・attempt 1・`schedule` event・`verify` 成功であること、receiptが親runの単一不変artifactであり、PR番号・固定SHA・base SHA・gate ID・証跡branch/commit/digestが親の選定結果と一致すること、作成から1時間以内であることを照合する。不一致・欠落・重複・期限切れは保護jobをスケジュールせず停止する。
- [ ] BGT-004 保護jobは承認後の別runnerで、PR head・base・最新main包含・証跡branchのcommit・`board-review` 設定（本人1名、自己承認防止、bypass禁止、main限定）・当該runの承認履歴（本人IDの承認一件）を再照合してからApp tokenを作る。App鍵を使うjobはPRコードを実行・checkoutしない。
- [ ] BGT-005 7 statusは固定SHAへ、既存と同じcontext名で、子runのURLをtargetに発行する。発行は全照合の成功後のみで、部分発行の後に成功ラベルを付けない。
- [ ] BGT-006 却下・未承認・期限切れ・親失敗・stale SHA・証跡改変・別PRのreceipt流用・同一gateの重複起動・attempt 2・別ref・fork由来で、statusが一件も発行されず `review:approved` も付かないことを、実helperのローカル実行（注入API・時計）で示す。
- [ ] BGT-007 probeの既存受入と全既存 `harness/tests/*.test.mjs` が成功・skip 0。`harness-local-v1` の12 checkを固定SHAで自己検証し、別担当が独立に照合する。
- [ ] BGT-008 RUNBOOKとGitHub強制契約の該当節が新経路（親で選定・再検証、子で承認・発行、待ち時間、却下・期限切れ時の再提出）と一致する。未実証の実run成功を記載しない。

各条件はテスト名またはレビュー証跡へ対応付ける。

## 必須テスト

- [ ] `node --test harness/tests/*.test.mjs` 全件成功・skip 0（新設 `board-gate` テストを含む）
- [ ] workflow YAMLの構文解析、embedded JSの構文解析と境界entrypointのmock実行、全外部Actionの40桁SHA固定（`assert-action-pins.mjs`）
- [ ] `harness-local-v1` の12 check（scope-diff、docs-consistency、node-syntax、harness-tests、workflow-yaml、workflow-embedded-js、action-pins、skill-validation、governance-diff-policy、public-boundary、secret-patterns、source-immutability）
- [ ] 独立レビュー: 別セッション・別worktree・別lease・同一固定SHA。専用validator経由でのみ `HARNESS_LOCAL_PASS`

## 回帰シナリオ

- 既存`REQUIRED`: なし（manifestは全件PLANNED）
- このタスクで`REQUIRED`へ昇格: なし（governance専用。製品回帰の昇格はしない）

## 変更可能な領域

`.github/workflows/independent-review.yml`、新規 `.github/workflows/board-gate.yml`、`harness/scripts/`（board gate用helperと共有部品。`board-actor-probe.mjs` は挙動を変えない切り出しに限る）、`harness/tests/`（新規テストとfixture。既存テストの削除・skip・期待値弱体化は不可）、`harness/RUNBOOK.md`、`harness/github_enforcement.md`、本契約。それ以外（製品、他workflow、validator、Skill、manifest、決定記録の過去分）は変更しない。

## 無料運用・セキュリティ制約

Public repoの無料Actionsの範囲。既定権限は `{}`、子を起動するjobだけ `actions: write`。App鍵は `board-review` Environmentのjobだけが参照し、ログ・artifact・receiptへ出さない。Secrets/Variables一覧APIを読まない。artifactは保持1日・overwrite無効・空upload拒否・既存の上限内。公開証跡は合成データのみ。

## 未決事項

- 子workflowを別ファイルにするか、既存probeとworkflowを共用するか。**別ファイル**を既定とし、実装担当が不都合を見つけた場合は理由を添えてCEOへ戻す。
- 却下・期限切れ後の `review:board-pending` の扱い（現行は本人が手動解除し新gate IDで再提出）。現行運用を維持し、自動解除は追加しない。
- 実runでのApp token発行と保護有効化後の挙動は、App作成・保護設定の後続工程で実証する。本タスクのLOCAL合格をその証明にしない。

## CEO判断

経路はDEC-050で決定済み。LOCAL実装と独立検証をDEC-031の継続範囲で開始する。公開以降は固定SHAと独立合格を揃えてから、対象・回数・期限・停止条件を本人へ提示する。

## 取締役会判断

- DEC-050承認済み（経路とLOCAL着手）。公開・PR・CI・マージは未承認（別判断）。
