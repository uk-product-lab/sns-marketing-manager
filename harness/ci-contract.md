# TASK-0004 ローカルCI契約候補

この候補は未導入。ローカル自己検証と別session/worktree/lease・固定SHAの `harness-local-v1` 独立検証を扱うだけで、実CI、Linux、実機Safari、Repository Gate、製品PASS、本人承認、MVP完成またはmerge許可を証明しない。既存のLOCAL/private資料や証跡をこの文書と一緒に公開しない。

## 実行の正本

Node 24.15.0、npm 11.12.1 と実在する `npm ci` を使用する。製品package/lock/src/e2e/scripts/config/DBは変更しない。quality候補は信頼済みdefault branchを `trusted`、固定headを `product` へ別checkoutする。PRコードを実行するjobはread-only、checkout credentialは残さず、App鍵/書込credentialを渡さない。independent-reviewのprepare/base/head/digest照合、本人 `board-review`、別runnerのApp鍵、7 required status/expected Gatekeeperは従来のまま。

証跡parserは信頼済み固定コードから `python3 -I -c` を起動し、PRのXML/ZIP/PNG/HTMLを標準入力だけで渡す。製品のjsdom/saxesやPR側のparserは読み込まない。Python 3.9以上かつExpat 2.7.2以上をfail-closedで要求し、実version/executable/isolated状態をenvironment.jsonへ記録する。workflow候補はPython 3.12.14を40桁固定のsetup-pythonで準備し、pip install/cacheを使わない。[固定Action入力](https://raw.githubusercontent.com/actions/setup-python/83679a892e2d95755f2dac6acb0bfd1e9ac5d548/action.yml)と[公式配布manifest](https://github.com/actions/python-versions/blob/main/versions-manifest.json)を参照する。Ubuntu候補の実起動・Linux成功は未検証。ローカルMacは既存Codex同梱Python 3.12.14/Expat 2.8.3を使用し、Apple既定Python 3.9.6/Expat 2.2.8では拒否する。新規runtimeや製品依存のinstallではない。

必須7品質scriptは存在だけでなく信頼済みcheckoutのpackageにある実命令との完全一致を検査する。`test:migration`/`test:boundaries`を含むecho/常時成功への差し替えは非zeroで拒否する。製品PRから検査の正本を差し替えない。実命令を更新する場合は別governance契約が必要で、既存validatorを本タスクで弱めない。

信頼済みrunnerの導入前にこのworkflowだけを起動しない。PR側のrunnerを「信頼済み」として実行するfallbackはない。post-mergeは採用済み同じ固定main SHAのrunnerを使う。DDR-0005のdispatcher案は未採用・未実装。

`ci-quality.mjs --product-root <root> --fixed-sha <full SHA> --gate <gate> --output <new directory>` を使用する。既存outputへの上書きは拒否し、同一product作業域のinstall/build/preview/E2E/axe/smokeはexclusive lockで逐次とする。別CI jobは別workspaceなので独立する。

| gate | 実コマンド/測定 | 実生成物 |
|---|---|---|
| install | `npm ci` | stdout/stderr、start/end/exit |
| static | boundaries → typecheck → lint → test:migration → build | 各実コマンドのraw/start/end/exit |
| unit | `npm run test:unit -- --retry=0` + Vitest JSON/JUnit + trusted診断reporter | unit.json、unit.xml、unit-history.json、raw |
| e2e-chromium | build → installed local Playwright CLI、Chromium指定2project | JSON/JUnit/HTML、全trace/screenshot、実行project viewport、raw |
| e2e-webkit-mobile | build → installed local Playwright CLI、WebKit指定2project | 同上 |
| accessibility | build → trusted Playwright+axe probe、4viewport | 実axe JSON、HTTP/console/network、PNG/trace、raw |
| smoke | boundaries → `npm run test:smoke` | 実HTTP200を含むraw/start/end/exit |

製品wrapperはargvを転送しないため使わない。trusted configはChromium 1440×900/1512×982、WebKit 390×844/393×852、retry0、worker1、forbid-only、trace onを固定する。Linux候補には `node node_modules/@playwright/test/cli.js install --with-deps chromium webkit` を明示する。ローカルMacはそのOS依存導入を実証しない。

非zero、timeout、ログ保存失敗、空/missing/malformed出力、zero tests、skip/retry/flaky、欠けたproject/viewport/trace/HTMLを成功にしない。axeのcritical/serious拒否を維持し、実測結果を保存する。初回失敗は保存し、同じ証跡へ再実行で上書きしない。静的boundary scanは全実行時通信/全プロセスや将来のSNS接続安全性を証明しない。

JUnitは標準ElementTreeでXML全体をparseし、UTF-8 strict、DOCTYPE/外部・内部entity、許可外namespace/階層、実failure/error/skipped/flaky/rerun要素、非整数・非zero失敗属性、宣言testsと実testcase件数の不一致を拒否する。コメント・CDATA内のXML風文字列はtestcaseとして数えない。対応する形状はVitest/Playwrightのtestsuites→testsuite→testcase、または単一testsuiteで、root skipped省略・properties・system-out/errを許容する。[ElementTree](https://docs.python.org/3/library/xml.etree.elementtree.html)と[XML security](https://docs.python.org/3/library/xml.html#xml-security)に従い、ファイル20 MiB・XML深さ8/10万node・子process10秒・stdout/stderr64 KiBを上限にする。parse/runtime/spawn/timeoutエラーは成功へfallbackしない。

ZIPは標準zipfileで全entryを読みCRCを検査し、抽出せず、500entry/解凍総量20 MiB、外部path/symlink/重複名/暗号化を拒否する。traceはJSON行の実context-optionsとbrowser/viewportを照合する。HTMLは標準HTMLParserからPlaywright埋込ZIPを取り出す。installed Playwright 1.63.0のHtmlBuilderはreport.jsonのresultsをattachments/startTime/workerIndexへ縮約し、retry/status/errorsは各`<fileId>.json`詳細だけに残すため、summaryだけでは成功にしない。全詳細の存在・一意性、file/test ID・名称・location・project・titleの1対1対応、全件数/file/global statsを検査し、summaryを公式detail projectionへ一致させる。全detail resultは1件/passed/retry整数0/errors空/repeat0に限定し、canonical Playwright JSONのtest IDと実result duration/startTime/workerIndexも照合する。欠落・余剰・重複file/test/JSON key、不整合、nonfinite数値、隠れたretry/status/errorsや複数attemptは拒否する。一般reporter形式や全step意味論の保証へ広げない。PNGは一般画像decoderではなく8bit非interlace RGB/RGBAの限定的な構造・CRC・zlib scanline長検査とし、スクリーンショット幅・viewport以上の全ページ高さ・scaleを照合する。PNG解凍20 MiB/500chunkの上限を守り、表示内容の目視承認や全画像形式の互換性を証明しない。

Vitest標準JSON/JUnitはretry履歴を持たないため、それだけでretry0と判断しない。信頼済み `ci-unit-reporter.mjs` が[実TestCase.diagnostic](https://vitest.dev/api/advanced/test-case#diagnostic)のretryCount/repeatCount/flakyと完了結果を `unit-history.json` に保存し、JSONのfile/ancestor/titleへ全件照合する。履歴欠落、不一致、retry/repeat、残存errorは拒否する。製品config/testsを変更せず、診断reporter保存失敗も非zeroとする。

各gateはenvironment/SHA/runner digest/resultと実ファイルSHA256 manifestを出力する。workflowのalways upload先とrunner出力先は `artifacts/ci/` へ一致させる。証跡はraw・実serialize済みresult・manifest自身のUTF-8 bytesとfile数を合わせて20 MiB/500ファイル以内とし、固定予約余白で代用しない。manifestは自身のhashを持たないが、自身のbytes/fileは上限へ含める。超過は失敗し、黙って削除/圧縮/省略しない。失敗rawはprivateに保持し、上限内の公開artifactとは扱わない。retentionは1日。ローカル原本は共有GitのstateRootへ保存し、公開証跡では合成データだけを使う。

最終2bufferを同filesystemの専用tempへexclusive保存し、manifest→resultの順にexclusive hardlinkで公開する。既存result/manifest衝突を上書きしない。2file同時atomicとは保証せず、途中停止では成功resultを先に発行しない。予算超過・保存失敗は未存在resultへFAILを保存し、衝突/保存不能なら新しいbounded failure recordとstderrへ不成立を残してnonzeroとする。temp掃除は自作2file/dirだけを対象とし、完全保存後の掃除失敗も非zeroを維持するが、完全保存したimmutable bytesをFAILへ書き換えない。成功資格には最終file一致と親gate exit0の両方が必要で、保存済みresultだけを成功根拠にしない。

## LOCAL観測整備（DEC-018追加契約）

正式runtime/JUnit/trace/HTML/PNG呼出しは `ci-parser-observation.mjs` を通り、gate新output内 `parser-observations/<UUID>.start.json` と `.result.json` を別々にexclusive作成する。開始原本へ追記/上書きしない。固定SOURCE/module/観測moduleのSHA256、mode・実input path/hash/bytes・expected、Python探索条件と解決済み絶対executable、`-I -c` argv（SOURCE全文はdigest参照）、PATH/LANG/LC_ALLだけ、親PID・観測可能な子PID、wall/monotonicの呼出し/子process開始終了、exit/signal/errno/timeout/要求SIGKILLを記録する。実行は記録した絶対Pythonで行い、子のexecutable申告と一致させる。未起動/未観測値はnullとし、timeout後のkill要求と実signalを分ける。子自己申告のPython/Expat/isolatedとphase時刻は親側観測から区別する。

固定SOURCEはstderrへcallId/PID付きのbounded構造化phase（bootstrap→stdlib→stdin→parse→該当ZIP/JSON→parse終了→complete）だけを送り、stdoutは正式結果JSONだけに保つ。phase順序・欠落・型・時刻逆転・別call混入・runtimeを検査し、失敗した位置までのvalidated prefixを保存する。traceback等の非phase stderrとstdoutはbytes/hashだけで、元入力・任意stderr・秘密値を原本へ複写しない。metadataは型/深さ/件数/文字列長を制限し、秘密patternと禁止secretキーを拒否する。この限定検査は全秘密の検出保証ではない。合成データのみの実行境界を維持する。

従来の10秒/20 MiB/500entry/64 KiB・fail-closed意味論は維持する。timeout/異常終了/不正stdout/phase欠落・不正/保存失敗はnonzeroで、観測保存不能でも安全な親側recordをerrorに残しgate result.jsonのparserFailureへ渡す。保存衝突では既存原本を保持する。standalone合成fixtureは専用新temp原本を使い、正式runnerにSOURCE/command/timeout/phase/env注入オプションを設けない。process-level helperの制御負fixture（10秒timeout、異常終了、phase欠落等）は正式runnerへの注入ではない。

派生DIAGと新正式instrumented SOURCEは別SHAである。import/出力/timingが変わるため、819fの元timeout根因は未確定のまま、修正済み/免除と宣言しない。旧300/旧8gate/後刻DIAGを新SELFへ転用せず、新clean SHAの全12 profile・全fixture・実8gate初回逐次原本を必要とする。初回正式失敗または証跡不足で停止しPARTIALを返し、同SHAのretrygreenや上限変更をしない。新SELFは独立レビューではなく、Linux/実CI/actor/物理Safari/全通信は未測定である。

無害なPATH/観測pathでもsymlink解決後の値が秘密patternを含む場合があるため、resolved executableとcanonical観測directoryは一時値へ解決し、同じ型/長さ/秘密境界を満たしてから記録/返却対象へ代入する。拒否時に危険値を親error.observation/observationRootへ残さず、子を起動しない。canonical directory準備で空directoryを作る場合はあるが、未検査値へintent/resultを保存しない。初回合成canaryの開発再現原本は正式合格と区別して保持する。

実装・独立それぞれの新固定候補で、正式12項目開始前のPREPとして既存lockのnpm ci、必要Vitest/Playwrightファイル、Node/npm/Python、HEAD/cleanを別labelのraw/start/end/exitへ記録する。PREP初回失敗なら正式検証を始めず原本を残す。PREP成功を後の実8gateのinstallやfixture成功へ代用しない。d222独立の未導入Vitestによる初回327/328・BLOCKEDを抹消/同SHAretrygreenせず、旧期待値/skip0と既存runtime/製品lockを維持する。

## 無料運用と未解放事項

標準 `ubuntu-latest` runnerだけを候補とし、larger/self-hosted runner、新cache、新契約、課金設定変更をしない。setup-nodeの自動npm cacheは無効にする。[固定Action manifest](https://raw.githubusercontent.com/actions/setup-node/820762786026740c76f36085b0efc47a31fe5020/action.yml)に `package-manager-cache` 入力があることを確認済み。

Publicの標準runner minutesとartifact/cache storageの課金条件は別。短期retentionや出力上限だけでaccount全体の無料運用を保証しない。実CI前に本人判断とREADでaccount容量/支払い/budget/無料条件を確認する。実GitHub導入PR、起動、App/Environment/保護/ruleset/Secret、本人actor正負試験、mergeは未許可の別工程。ローカル自己検証後も全MVP/将来機能はPlanのまま保持する。
