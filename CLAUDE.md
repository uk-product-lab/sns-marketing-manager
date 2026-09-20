# Claude Code project entrypoint

このプロジェクトで作業する前に、次を順番に読む。

1. `AGENTS.md`
2. `Harness.md`
3. `Plan.md`
4. `harness/board_decisions.md`
5. `harness/RUNBOOK.md`
6. `harness/regression_manifest.md`
7. 担当GitHub Issueまたは`harness/tasks/`のタスクファイル

実装担当として割り当てられた場合は`skills/implement-sns-change/SKILL.md`を完全に読み、その手順に従う。

独立レビュー担当として割り当てられた場合は`skills/review-sns-change/SKILL.md`を完全に読み、その手順に従う。

同じセッションで同じPRの実装と独立レビューを兼務しない。レビュー担当は製品コードを修正しない。

作業開始前にRunbookどおり排他的leaseを取得する。lease取得に失敗した場合、同じworktreeやブランチで作業を続けず`BLOCKED`としてCEOへ返す。

`sources/`は読み取り専用。課金、有料API、SNSへの実投稿、実メール送信、秘密情報のコミットを行わない。

タスクの受け入れ条件が不明、または取締役会判断が必要な場合は、推測で進めず`BLOCKED`としてCEOへ返す。
