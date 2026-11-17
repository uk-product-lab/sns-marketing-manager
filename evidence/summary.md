# 製品変更の独立レビュー報告

- Gate: `QA-20261118-GATE-POSITIVE-TRIAL`
- Task: `TASK-0014`（承認ゲートの正の通し試験用の試験PR）
- 対象PR: #12（`claude/issue-0014-gate-positive-trial` → `main`）
- Fixed Commit SHA: `2f71d8d1a0341abd46fc540097af8f4ca9baa31b`（親 = main先端 `6df69fe7d3b81cb5f4c7631add25a29d602d291d`）
- 対象機能: `README.md` の「現在の状態」節へ、mainへのマージ条件を説明する1行を追加（製品コードの変更なし）
- Implementer Agent: Claude Code（別セッション）
- Implementer Session: `claude-impl-0014-20261118-273d`
- Implementation Lease ID: `35b4891e-d9e1-46e1-b53e-fa8bf094ec95`
- Reviewer Agent: Claude Code（独立レビュー専用セッション。実装・主担当とは別）
- Reviewer Session: `claude-review-0014-20261118-6ead`
- Review Lease ID: `4a965164-0f4e-40d0-bb37-add727ff1f88`
- Review Lease Start: 2026-11-17T18:12:20.492Z
- Review Lease Expires: 2026-11-18T02:12:20.492Z
- Test Started: 2026-11-17T18:19:38.000Z
- Test Completed: 2026-11-17T18:29:26.000Z
- 判定: PASS

## 必須テスト

- 合格数: 18
- 総数: 18
- スキップ数: 0

| 種別 | 件数 | 結果 | 証跡 |
| --- | --- | --- | --- |
| 単体テスト（vitest、retry 0） | 10 | 10 合格、skip 0 | `unit-tests.log` |
| E2E（Playwright、4プロジェクト × 2テスト、retry 0） | 8 | 8 合格、skip 0 | `test-results.xml`、`playwright-report/` |

E2Eの8件は2回実行した（A: CIと同じコマンド・trace on、B: 製品の `playwright.config.ts`）。2回とも8件すべて合格で、再試行はない。単体テストも2回実行し、2回とも10件合格。件数には同じテストの2回目を重ねて数えていない。`test-results.xml` に入っているのはE2Eの8件（実行B）で、単体の10件は `unit-tests.log` にある。

## 回帰シナリオ

- manifest上の`REQUIRED` ID: なし（固定SHAの `harness/regression_manifest.md` は11件すべて `PLANNED`）
- 実行した`REQUIRED` ID: なし
- このPRで`REQUIRED`へ昇格したID: なし

## 静的レビュー

すべて合格。個別の結果は `checks.json`、実行したコマンドは `commands.log`。

- 固定SHAとPR（GitHubの読取のみ）: PR #12 は open、head = 固定SHA、base = `main` = `6df69fe7…`、既定ブランチは `main`、compare は `ahead`（1コミット先行、遅れ0）。テスト開始前とテスト終了後の2回読み、変化なし。
- 差分: `README.md` の1ファイル、+1/-0。追加行は契約（`harness/tasks/TASK-0014-gate-positive-trial.md` の21行目）とバイト単位で一致（両方の SHA-256 = `786e1abb9654798ebdfc4f4266825195fdf5a69cc89dc174c577ba07e67ae046`）。位置は「GitHubリポジトリ準備ゲート」行の直後。
- 範囲: 対象外のパス（`src/`、`e2e/`、`tests/`、`scripts/`、`migrations/`、`package.json`、lockfile、`.github/`、`harness/`、`skills/`、`sources/` ほか）に変更なし。
- 追加した相対リンク先 `harness/github_enforcement.md` は固定SHAのtreeに存在する。
- `node harness/scripts/assert-harness-diff.mjs <base> <fixed>`（governanceフラグなし）: 終了コード0、`Diff policy passed for 1 changed files (product)`。
- 秘密情報・有料API・SNS投稿API・実メール送信: 追加行に該当なし。`npm run test:boundaries` 合格。
- `npm run typecheck`、`npm run lint`、`npm run test:unit`（10/10）、`npm run test:migration`（ローカルD1）、`npm run build`: すべて終了コード0。追加で `npm run test:smoke` も合格。
- テストの削除・skip・期待値の弱体化: なし（差分はテストに触れていない。`.skip` / `.only` / `.fixme` / `.todo` の記述もない）。
- 依存の導入は `npm ci --offline` のみ（283パッケージ、通信なし）。ブラウザは導入済みのものを使い、ダウンロードしていない。
- レビュー用worktreeは開始時・各ゲート後・終了時とも `git status --porcelain=v1 --untracked-files=all` が空で、HEADは固定SHAのまま。

## ブラウザE2E

- Browser: Playwright 1.63.0 の Chromium 153.0.8010.12 と WebKit 26.6（ともにheadless）。加えて、デスクトップアプリ内蔵のブラウザ（Chromium 156系、画面あり）をレビュー担当が直接操作した。
- Mac相当: 1440×900（Chromium）合格
- MacBook相当: 1512×982（Chromium）合格
- iPhone相当: 390×844 と 393×852（WebKit、deviceScaleFactor 2・タッチ・モバイルのエミュレーション）ともに合格

| 実行 | 内容 | 1440×900 | 1512×982 | 390×844 | 393×852 |
| --- | --- | --- | --- | --- | --- |
| A | 既存E2E、CIと同じコマンド（`ci-playwright.config.mjs`、trace on） | 2/2 | 2/2 | 2/2 | 2/2 |
| B | 既存E2E、製品の `playwright.config.ts`（公開した `test-results.xml` と `playwright-report/`） | 2/2 | 2/2 | 2/2 | 2/2 |
| レビュー担当のprobe（3回目） | 主要フローの追加確認、31項目 | 31/31 | 31/31 | 31/31 | 31/31 |
| 内蔵ブラウザの手動操作 | 読込、Tab、Enter、クリック、横スクロール、コンソール、通信 | 合格 | 合格 | 合格 | 合格 |

probeで確認した主要フロー（アプリシェル。結果は `browser-checks.json`）: HTTP 200での表示、タイトルとh1、`role=status` の文言、Tabで最初に開閉ボタンへフォーカス、フォーカス表示（outline solid 4px）、Enterで開く（`aria-expanded=true`、`aria-controls` の先が存在、確認項目3件）、Enterで閉じる、Spaceでも開閉、開閉後もフォーカスがボタンに残る、クリック（Mac）とタップ（iPhone相当）で開く、開閉どちらの状態でも横スクロールなし、操作部品が画面幅に収まる。

画面は `screenshots/mac/`（8枚）と `screenshots/iphone/`（8枚）、トレースは `traces/`（画面サイズごとに1本）。

アプリシェルはDB・時刻・アカウント・外部サービスを使わないため、テスト用DBと固定時計を要する操作はない（D1の移行は `test:migration` でローカル検証）。

## アクセシビリティ

- axe-core 4.13.0: 4画面 × 2状態（開いた状態・閉じた状態）で違反0件（critical・serious 0件、その他も0件）。CIと同じ `ci-axe-probe.mjs` でも4画面とも違反0件。結果は `accessibility.json`。
- キーボード完遂: Tab・Enter・Spaceだけで開閉できる。フォーカス表示あり、順序は開閉ボタンが最初、開閉後の戻り先はボタン自身。
- 識別可能な名前: 操作部品（ボタン1個）に名前あり。
- タッチ対象: ボタンは幅295〜307px・高さ48px（44×44px以上）。
- 320 CSS px（WCAG 2.2 達成基準1.4.10の基準幅、製品CSSの `min-width`）: 4画面とも横スクロールなし。
- 200%拡大:
  - Mac相当（ページ拡大200% = CSS幅720・756px）: 横スクロールなし、文字の切れなし、開閉できる。
  - iPhone相当（文字だけ200%）: 文字が2倍になり、横スクロールなし、文字の切れなし。
  - iPhone相当（ページ拡大200% = CSS幅195・196px）: ページ幅は320pxのまま下がらないため、横スクロールが必要になる。内容と機能は失われない（全要素へスクロールで届く、文字の切れなし、キーボードで開閉できる）。下の「未解決不具合」の観察1を参照。

## コンソール・ネットワーク

- コンソール: 4画面ともメッセージ0件（error 0、warning 0）、未捕捉の例外0件。`console.log`。
- ネットワーク: 4画面とも応答3件（HTML、CSS、JS）すべて200。4xx・5xx 0件、失敗したリクエスト0件、`127.0.0.1` 以外への通信の試み0件。`network.log`。
- 内蔵ブラウザでの手動操作でも、コンソール出力なし、通信は `127.0.0.1` への200・304だけ。
- SNS・有料API・メールへの通信なし。

## 未解決不具合

重大な不具合は0件。判定を止めないと判断した観察を記録する。主担当が別の基準を採る場合は、提出前に差し戻してほしい。

1. **iPhone相当の幅でページ拡大200%にすると横スクロールが必要になる。** 製品CSSが `html` と `body` に `min-width: 320px` を置いているため、CSS幅195pxではページが320pxのまま残る。不合格としなかった理由: WCAG 2.2 の1.4.4（文字を200%まで拡大しても内容・機能を失わない）は横スクロールを禁じておらず、1.4.10（リフロー）が求める基準幅は320 CSS pxで、製品はその幅で横スクロールなしに表示できる。4つの画面サイズそのもの（100%）では横スクロールはない。この挙動はmain（`6df69fe7…`）と同じで、今回の差分（README 1行）によるものではない。
2. **見出しと本文の文字サイズが `clamp()` と `vw` で決まるため、Mac相当の幅では拡大率どおりに大きくならない。** ルートの文字サイズを2倍にしたとき、本文は1.6倍、h1は1.1〜1.15倍だった（`accessibility.json` の `zoom200`）。CSS上の上限と下限の比は最大2.09倍（h1）で、拡大率を上げれば200%に届く範囲にある（この点は固定SHAの `src/styles.css` の値からの計算で、ブラウザでの実測ではない）。内容・機能の欠落はなく、不合格としなかった。これもmainと同じ挙動。
3. **probeの合否基準を2回見直した。** 1回目は「拡大時に横スクロールが一切ないこと」をiPhone相当にも課して不合格2件（観察1の挙動）、2回目は「文字だけ拡大で必ず2倍になること」をMac相当に課して不合格2件（観察2の挙動）。どちらもレビュー担当が自分で置いた基準が要件より厳しかったもので、上記の理由で基準を改め、3回目を公開用の結果とした。製品側の挙動は3回とも同じ。1回目・2回目の結果は `probe-history/` にそのまま残した。

## 証跡

このフォルダ（`reviews/QA-20261118-GATE-POSITIVE-TRIAL/`）の内容。

| ファイル | 内容 |
| --- | --- |
| `summary.md` | この報告 |
| `review-verdict.json` | 判定（ローカル版。`evidencePath` は提出scriptが公開時に取り除く） |
| `test-results.xml` | E2E 8件のJUnit（実行B） |
| `playwright-report/index.html` | E2EのHTMLレポート（実行B） |
| `unit-tests.log` | 単体テスト10件の出力（2回目の実行。worktreeの絶対パスは出力時に `<worktree>` へ置換） |
| `browser-checks.json` | probe 3回目の全項目と観測値 |
| `accessibility.json` | axeの全結果（4画面 × 2状態）と拡大時の計測値 |
| `console.log`、`network.log` | probe 3回目のコンソールと通信の記録 |
| `screenshots/mac/`、`screenshots/iphone/` | 初期表示・開いた状態・ページ拡大200%・文字拡大200%（各画面サイズ4枚、計16枚） |
| `traces/` | probe 3回目のPlaywrightトレース（4本） |
| `environment.json` | 固定SHA、テスト区間、OS、Node、npm、ブラウザ、画面サイズ、制約 |
| `checks.json` | 26項目の個別結果 |
| `commands.log` | 実行したコマンド、時刻、終了コード、非公開の生ログのSHA-256 |
| `probe-history/` | probe 1回目・2回目の結果 |
| `tools/` | レビュー担当が使ったprobe、実行Aの照合script、公開前点検script |

公開していないもの: 実行A（CIと同じコマンド）の生成物と各コマンドの生ログ。Playwrightのテスト実行が作るトレースと実行Aのレポートにはこのマシンの絶対パスが入るため、証跡フォルダには入れていない。主担当が照合できるよう、作業ルートの `artifacts/continuity/2026-11-18/gate-positive-trial/review-private-raw/` に置いた（公開対象外）。公開したトレースはレビュー担当のprobeのもので、パスを含まないよう標準入力から実行した（記録される呼び出し元は `[stdin]`）。

### 公開前の自己点検

`tools/publication-check.py` をこのフォルダ全体に対して実行した（各ファイル、zipの中身、HTMLに埋め込まれたzipを走査）。

- ファイル数: 37（上限500）
- 合計サイズ: 5,535,641 バイト（約 5.28 MiB、上限20 MiB）
- 0バイトのファイル: 0
- symlink・通常ファイル以外: 0
- ASCII以外・記号を含むファイル名: 0
- 秘密情報らしき文字列（GitHub・AWS・Slackのトークン、秘密鍵、JWT、Cookie・Authorizationヘッダ）: 0
- メールアドレス: 0
- ホームディレクトリの絶対パス・一時フォルダのパス: `review-verdict.json` の `evidencePath` の1か所だけ。これは `validate-review-verdict.mjs` が要求するローカル専用の項目で、提出script（`submit-independent-review.mjs`）が公開時に取り除き、workflowは残っていれば拒否する。`evidencePath` を除いた公開時と同じ形でも点検し、0件だった。
- このマシンの識別情報（ホームディレクトリ名、ログイン名、ホスト名、コンピュータ名、gitの氏名・メールアドレス）: 上記の `evidencePath` 以外は0件。
- 画像のメタデータ: 画像44枚（スクリーンショット16枚、トレース内の画面28枚）を構造で検査。WebKit由来の20枚に色空間と縦横ピクセル数だけのEXIFがあり、それ以外の埋め込み情報はない。
- 使ったデータは製品に組み込みの表示文言だけで、利用者データ・実ブランド情報・アカウント情報は扱っていない。
- 点検scriptは、絶対パスを含む実行Aの生成物、合成したトークンとメールアドレス、0バイトファイル、symlink、文字情報入りの画像を不合格にすることを確認してから使った。
- 公開時には提出scriptが `lease-proof.json` を加え、`review-verdict.json` を書き直すため、公開側のファイル数は1つ増え、合計サイズも変わる。

### 確認できていないこと

- 実機のiPhoneと実物のSafari。iPhone相当はPlaywrightのWebKit（モバイルのエミュレーション）で確認した。内蔵ブラウザはChromium系で、画面サイズだけを合わせた。
- `harness/scripts/ci-quality.mjs` による自己検査。このMacのPythonはExpat 2.6.3で、証跡パーサが求める2.7.2以上を満たさないため使っていない。同じ品質コマンドを直接実行し、合否・再試行0・skip 0・トレースの有無・画面サイズはレビュー担当のscript（`tools/check-run-a.mjs`）で照合した。PythonによるJUnit・トレース・HTML・PNGの構造検査は未実行。
- GitHub上の証跡再計算、取締役会の承認、Gatekeeper Appのstatus。これらは提出後の工程で、レビュー担当は行っていない。
- 参考: レビュー時点でPR #12 はdraft。PRのCI（6件のcheck run）は成功しているが、判定には使っていない。

## 差戻し先

なし（PASS）。

## CEOへの勧告

- `MERGE_CANDIDATE`

レビュー担当はマージ・ラベル付与・証跡の提出・leaseの解放を行っていない。主担当の照合待ち。

## GitHub固定SHAゲート

- Evidence SHA-256: 未算出（提出scriptが公開用の内容から算出する）
- `review/independent`: 未発行
