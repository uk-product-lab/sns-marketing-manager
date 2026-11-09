# TASK-0009 Probeの任意起動元入力を処理する

- 状態: READY（LOCALの候補作成・自己検証・独立レビュー）
- 基準: `04341bfaa5f15cd26b80e644fad276dbd2a509a3` / `69c77cc287b28fef58f6899bd925cef06b0046ef`
- 契機: [診断run 42587971280](https://github.com/uk-product-lab/sns-marketing-manager/actions/runs/42587971280) の初回は、任意の起動元2入力が欠けた形を `INPUT_KEYS_MISMATCH` としてcheckout前で拒否した。

## 受け入れ条件

- SRC-001: checkout前の境界と後続パーサーは、`dispatch` / `direct-negative` でのみ `source_run_id` / `source_attempt` の片方または両方の省略を許す。後続では省略分だけを空文字列とし、明示の空文字列も受け付ける。
- SRC-002: `receive` は両方の起動元キーと従来の値・照合条件を必須とする。未知キー、全モード共通の必須キーの欠落、明示した不正な起動元値は既存の検査段階で拒否する。境界診断の項目・秘匿性とmain/SHA/attemptの固定条件を保つ。
- SRC-003: 4キーのpayloadで実embedded JSと後続stageを合成fixtureで動かす。dispatchの合成POSTは1回で、受信向けに元run IDとattempt 1を渡す。直接negativeの事前確認は書き込み0件。受信で起動元が欠ける場合は境界のAPI到達前に停止する。
- SRC-004: 全 `harness/tests/*.test.mjs` と固定 `harness-local-v1` の12項目を同じ固定SHAで自己検証し、別担当・別session/worktreeの独立レビューを受ける。失敗時は原物を保持して判定する。

## 変更範囲

- `.github/workflows/board-actor-probe.yml` の入力キー判定だけ
- `harness/scripts/board-actor-probe.mjs` の入力パーサーだけ
- `harness/tests/board-actor-probe.test.mjs` の回帰fixture
- `harness/board-actor-probe.md` の入力契約と本タスク

合成fixtureのみを使用する。権限・保護・actor/receipt照合、製品・依存関係・sourcesは対象外。GitHubへの公開、実CI、マージ、実probe、設定変更と本人承認は別判断。旧失敗runの原因は今回の診断から確定しない。
