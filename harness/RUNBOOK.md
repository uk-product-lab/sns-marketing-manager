# 自律開発ランブック

更新日: 2026-09-18

## 現行方針と再開地点

DEC-009により管理者 `ukyo-0001` を自動化へ接続してよい。別machine accountや管理者の全面切断を要求しない。DEC-010で文書・ハーネス整備が承認済み。製品ゲートや本人承認を省略する許可ではない。

再開時は AGENTS.md → Harness.md → Plan.md → board_decisions.md → current_status.md → regression_manifest.md → 担当タスクを読む。矛盾時は最新の利用者指示・承認済み決定を優先し、状態を修正してから実行する。古い監査のPASSを現在の合格に置き換えない。

## 文書・ハーネス専用タスク

TASK-0001はgovernance整備であり、製品コードや実GitHub保護設定を変更しない。

- docs/検証器/Skillの変更範囲と受け入れ条件を先に記録する。
- 既存のdirty worktreeを保存し、コード担当は独立作業域でleaseを取得する。sources/や秘密情報をスナップショットへ含めない。
- 合成データで構文・検証器正常/異常系・workflow解析・Action固定・Skill形式を検査する。
- 独立担当へ固定SHAと生の結果を渡し、文書/ローカルハーネス限定の判定を得る。製品のreview-verdictや実ブラウザPASSを捏造しない。
- 製品なしの専用タスクに製品E2Eを適用しないことは、製品タスクの必須テストをskipしてよいという意味ではない。
- 公開可能な文書・検証器を既存GitHub mainから分岐したdraft PRへ記載する。ローカル独立履歴でremote mainを置き換えない。workflow稼働・merge・保護設定変更は別途扱う。
- SNS側Notionに進捗要約と正本リンクを置き、MATLyS/共有DB構造を変更しない。
- 外部反映は読み戻して確認する。反映前は「ローカルのみ」と報告する。

文書・ハーネス専用タスクも実装leaseを`SELF_TESTED`で解放し、別session・別worktreeが同じ固定SHAでreviewer leaseを取得する。レビュー担当は`harness/templates/governance_review_report.md`、`summary.md`、`checks.json`、`commands.log`を`<stateRoot>/reviews/<gate-id>/`へ置く。`DOCS_PASS`または`HARNESS_LOCAL_PASS`の場合だけ専用JSON verdictと`checkProfile`を必須とし、`DOCS_PASS`は`docs-v1`、`HARNESS_LOCAL_PASS`は`harness-local-v1`だけを使用する。各プロファイルの固定check IDは`Harness.md`を正とする。`requiredChecks`、`executedChecks`、`checks.json`を同じ任意集合へ狭めても合格せず、validator内の信頼済みプロファイルと完全一致しなければならない。CEOは成功判定を次の専用経路で解放する。

```text
node harness/scripts/release-lease.mjs \
  --task TASK-0001 \
  --role reviewer \
  --lease-id <lease ID> \
  --outcome HARNESS_LOCAL_PASS \
  --verdict-file <stateRoot>/reviews/<gate-id>/governance-verdict.json \
  --worktree <レビュー専用worktreeの絶対パス> \
  --actor ceo
```

`DOCS_PASS`は文書だけ、`HARNESS_LOCAL_PASS`は文書とローカルハーネス検証に使う。未知profile、outcomeとの不一致、必須IDの欠落・追加は専用validatorが拒否し、`release-lease.mjs`経由でも解放しない。専用validator、clean worktree、固定SHA、SELF_TESTED実装leaseとの対応が揃わなければ解放しない。GitHub PR headや製品E2E証跡はこの経路では要求しないが、製品`PASS`、実GitHub準備完了、マージ承認へ読み替えない。

`FAIL`または`BLOCKED`は成功用JSON verdictを作らない。代わりに`harness/templates/review_failure_record.example.json`を基に`failure-record.json`を作り、非空の`summary.md`、`checks.json`、`commands.log`と一緒に保存する。`FAIL`では`failedChecks`を`checks.json`のFAIL項目と一致させ、`BLOCKED`では`blockedChecks`と`blockedReasons`を必須にする。次の専用経路で検証できた失敗記録だけを解放し、成功判定へ流用しない。

```text
node harness/scripts/release-lease.mjs \
  --task TASK-0001 \
  --role reviewer \
  --lease-id <lease ID> \
  --outcome FAIL \
  --failure-record <stateRoot>/reviews/<gate-id>/failure-record.json \
  --worktree <レビュー専用worktreeの絶対パス> \
  --actor ceo
```

`BLOCKED`は対応するoutcome・recommendation・blocked項目へ置き換える。`validate-review-failure-record.mjs`は固定SHA、clean worktree、実装/reviewer lease、別session、レビュー時間、証跡path、check結果、阻害理由を照合する。同じ証跡に成功用`governance-verdict.json`または`review-verdict.json`があれば拒否する。

## 0. 実GitHubリポジトリ準備ゲート

現在は実証未完了。TASK-0001のローカル合格だけで機能タスクをREADYにしない。

### 初回導入の順序

1. 既存remote mainから文書・ローカル検証器だけのdraft PRを作る。現在のstarterで未定義の品質scriptを自動実行しないよう、実行workflowはこの初回draftへ含めない。
2. 固定SHAの`HARNESS_LOCAL_PASS`と取締役会代表の内容確認を得る。mergeは今回の着手許可に含めず、別途明示承認を得る。merge後も`REPOSITORY_GATE_PASS`ではない。
3. 別の製品基盤タスクで、starterへ実体のあるtypecheck、lint、unit、migration、Chromium、WebKit mobile、accessibility、smokeを追加し、空scriptや常時成功scriptで代用しない。これは今回の文書整備には含めない。
4. 品質scriptが実行可能になった後、別governance PRでworkflowを導入・実CI検証する。
5. その後にbranch protection、Environment、Gatekeeper App、証跡rulesetを設定し、正の承認試験と偽status等の負の試験を行う。

各段階を別の固定SHA・判定として記録する。workflow未導入、品質script未実装、live設定未検証のいずれかが残る間は実GitHub準備ゲートを`BLOCKED`とする。

1. Organization所有・Public・対象 `uk-product-lab/sns-marketing-manager`・既定branch `main` を実確認する。
2. `shared-admin` を指定し、board/automationとも `ukyo-0001` とする。アカウント権限と使用中credentialを区別し、最小権限を使う。Secrets/Variablesへの既存の拒否検査を維持する。広いコネクタによる文書記入はこの検証成功の代わりにならない。
3. main完全一致の保護rule、管理者適用・bypass禁止、7 required statusと専用Gatekeeper App発行元、conversation解消を設定・確認する。
4. App鍵を `board-review` Environmentだけに置き、秘密なし品質jobとstatus発行jobを分離する。
5. Environmentは本人1名・main限定・bypass禁止・自己承認防止を維持する。実行actorが本人と同じならDEC-012で判断し、無断解除しない。
6. `review-evidence/**` の作成後update/deletion/non_fast_forward禁止を確認する。
7. 全外部Actionの完全SHA固定と、そのSHAの実CI実行を確認する。
8. 次の検証器を実際の最小権限credentialで実行する。成功は設定検査限定。
9. 正当な固定SHAと独立証跡、本人承認が最後のstatus発行まで進める正の試験を行い、実行actor・承認者・run URLを記録する。
10. 未承認、拒否、stale SHA、証跡改変、別PR流用、PATと別branch Actionsからの偽同名statusの負の試験を行う。追加merge blockerによる誤合格を避け、head/base/actorを確認する。
11. lease競合・異常終了、merge後smokeも確認し、別担当が `REPOSITORY_GATE_PASS` を記録する。

```text
node harness/scripts/verify-repository-gates.mjs \
  --identity-model shared-admin \
  --organization uk-product-lab \
  --repo uk-product-lab/sns-marketing-manager \
  --branch main \
  --gatekeeper-app-id <専用App ID> \
  --board-reviewer-login ukyo-0001 \
  --automation-login ukyo-0001 \
  --evidence-output <stateRoot>/reviews/repository-bootstrap/repository-gates.json
```

自己承認防止と実actorが衝突する場合は製品開始を止める。新しい本人用アカウントの作成を当然の解決策にしない。`CONFIGURATION_VERIFIED_ONLY` を `REPOSITORY_GATE_PASS` と読み替えない。

## 1. 製品タスクをREADYにする

CEOはIssueテンプレートの全項目を埋める。取締役会判断が残る場合は`BOARD_DECISION`で止める。受け入れ条件、対象外、必須テスト、変更領域、昇格する回帰IDが確定した場合だけ`READY`にする。

## 2. 製品実装担当を割り当てる

CEOは専用branchとworktreeを作り、他タスクと同じworktreeでないことを確認する。その後、次の形式で排他的leaseを取得する。

```text
node harness/scripts/acquire-lease.mjs \
  --task TASK-1234 \
  --role implementer \
  --agent codex \
  --agent-session <一意のセッションID> \
  --branch codex/issue-1234-app-shell \
  --worktree <専用worktreeの絶対パス>
```

lease取得失敗時は編集を始めない。実装担当は`skills/implement-sns-change/SKILL.md`に従う。

## 3. 製品変更をSELF_TESTEDで引き渡す

実装担当はPRテンプレートと`harness/templates/implementation_handoff.md`を埋め、固定40桁SHAと生のテスト結果を渡す。CEOだけが実装leaseを次の形式で解放する。

```text
node harness/scripts/release-lease.mjs \
  --task TASK-1234 \
  --role implementer \
  --lease-id <lease ID> \
  --outcome SELF_TESTED \
  --fixed-sha <40桁SHA> \
  --worktree <実装専用worktreeの絶対パス> \
  --actor ceo
```

自己テスト不合格なら`SELF_TESTED`にしない。

## 4. 製品の独立レビューを割り当てる

CEOは実装とは別セッション・別worktreeを割り当て、レビューleaseを取得する。

```text
node harness/scripts/acquire-lease.mjs \
  --task TASK-1234 \
  --role reviewer \
  --agent claude \
  --agent-session <実装と異なる一意のセッションID> \
  --branch codex/issue-1234-app-shell \
  --worktree <レビュー専用worktreeの絶対パス> \
  --fixed-sha <40桁SHA>
```

レビュー担当は製品コードを修正せず、`skills/review-sns-change/SKILL.md`に従って静的検査、自動E2E、実ブラウザ操作、アクセシビリティ、証跡保存を行う。証跡はレビューworktree内ではなく、lease出力の`stateRoot`配下にある`reviews/<gate-id>/`へ保存する。

## 5. 判定とマージ

レビュー担当は`PASS`時だけ`review-verdict.json`を作る。CEOは次を成功させる。

```text
node harness/scripts/validate-review-verdict.mjs \
  <stateRoot>/reviews/<gate-id>/review-verdict.json \
  --project-root <レビュー専用worktreeの絶対パス> \
  --state-root <lease出力のstateRoot>
```

- `PASS`: CEOが証跡を確認し、マージ候補にする。
- `FAIL`: 成功用verdictを作らず、`failure-record.json`と証跡を検証してレビューleaseを`FAIL`で解放し、実装へ戻す。修正後は新SHAで全必須テストをやり直す。
- `BLOCKED`: 成功用verdictを作らず、`failure-record.json`へ阻害項目と理由を記録・検証し、原因解消まで止める。

`PASS`のlease解放には、検証済み判定ファイルを必須入力にする。

```text
node harness/scripts/release-lease.mjs \
  --task TASK-1234 \
  --role reviewer \
  --lease-id <lease ID> \
  --outcome PASS \
  --verdict-file <stateRoot>/reviews/<gate-id>/review-verdict.json \
  --worktree <レビュー専用worktreeの絶対パス> \
  --actor ceo
```

`FAIL`または`BLOCKED`は同じコマンドで対応するoutcome、`--failure-record`、`--worktree`を指定する。失敗記録のvalidator、clean worktree、worktree HEAD、固定SHA、lease対応のいずれかが不一致なら解放できない。`PASS`は加えてGitHub PR head一致と製品用verdictを必須とする。

レビュー担当はマージしない。CEOも検証スクリプト不合格や証跡不足を上書きしない。

PASS lease解放後、CEOは固定SHAのattestationをPRへ提出する。提出時に実行中`gh` identityを指定automation login（shared-adminでは`ukyo-0001`）と照合し、PRのbaseがAPI上の現在の既定ブランチ、base SHAがその最新commit、headがbaseを含み固定SHAと一致することも検査する。共有証跡はGitHub APIで20 MiB・500ファイル以内の専用Git commitへ保存され、`review-evidence/<gate-id>`が新規作成される。公開リポジトリへ残るため、合成テストデータだけを使い、秘密情報や実アカウント情報を含めない。

```text
node harness/scripts/submit-independent-review.mjs \
  --verdict-file <stateRoot>/reviews/<gate-id>/review-verdict.json \
  --project-root <レビュー専用worktreeの絶対パス> \
  --state-root <lease出力のstateRoot> \
  --repo <owner/repository> \
  --automation-login <automation ID>
```

定期workflowがattestationを選ぶと、対象PRが現在の既定ブランチをbaseにし、headがその最新commitを含むことを再検査してから、GitHub上の証跡commitの全ファイルを取得してdigestを再計算する。続いて秘密情報のない別jobが同じbase結合を再検査し、信頼済み既定ブランチHarnessから品質ゲートを再実行する。ここまで合格した場合だけ`board-review` Environmentで取締役会承認待ちになる。最大15分程度の待ち時間を見込む。取締役会代表本人が固定SHA、証跡commit、再計算済みdigest、再実行結果、スクリーンショット、ログを確認し、手動承認する。承認後の新しいrunnerはPRコードを実行せず、status発行直前にbase結合をもう一度確認し、Environment秘密鍵から作ったGatekeeper App tokenで7 statusを発行する。expected sourceがGatekeeper Appに固定された7チェックが同じPR head SHAへ成功した場合だけマージする。

承認待ち中にPR headまたは証跡branchが変わると、次の定期実行が`review:board-pending`を外して`review:stale`にする。新しい固定SHA・新しいgate IDで全必須テストからやり直す。取締役会がEnvironmentを却下した場合は`review:board-pending`を手動解除して理由をPRへ残し、修正後に新しいgate IDで再提出する。

## 6. マージ後

マージ後に`quality/post-merge-smoke`を確認する。成功するまで`POST_MERGE_PASS`、`DONE`、依存する次タスク解放へ進めない。

## leaseの期限切れ・異常終了

- leaseの標準期限は4時間、最大24時間。
- 期限切れleaseは自動で奪わず、`SELF_TESTED`または`PASS`も拒否する。CEOが担当セッションの停止を確認し、`ABANDONED`または`BLOCKED`で解放する。
- 引き継ぎでは旧leaseを解放し、新しいセッションが新規leaseを取得する。
- leaseファイルを手編集・削除してロックを回避しない。
