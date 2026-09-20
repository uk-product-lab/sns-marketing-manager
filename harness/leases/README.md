# Lease領域

実際のleaseは、全worktreeが共有する`<git-common-dir>/sns-marketing-harness/leases/`へ保存する。このリポジトリ内のディレクトリは説明専用。

共有状態の`active/`と`archive/`はleaseスクリプトが管理する。ファイルを手作業で作成、編集、削除しない。

- `active/`: 現在の排他的担当
- `archive/`: 終了結果と引き継ぎ履歴
