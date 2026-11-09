# DDR-0016 probe boundaryを診断可能にするLOCAL候補

2026-11-08 / DEC-035のLOCAL着手承認。品質基準や外部権限は変更しない。

初回実probe run42446097435 attempt1はcheckout前のPROBE_CONTEXT_REJECTEDで失敗した。実actorの受信や本人承認には到達していない。複合拒否の個別理由と実event payloadが原物にないため、空文字列の任意入力が省略されたという説明も現時点では仮説である。

元境界の許可/拒否と後続main READを維持し、固定理由コードと秘密を含まない最小診断を追加する。入力の意味を緩める正規化やraw event dumpで成功化しない。通常/欠落/不正型/未知キー/誤contextを実embedded JSの負fixtureに結び付ける。

特定できた欠陥の最小修復は根拠とともに扱い、未特定の場合は診断追加だけの候補として返す。LOCAL正常fixtureの成功を元障害の解消やGitHub実payloadの証明にしない。

[TASK-0008](../tasks/TASK-0008-probe-boundary-diagnostics.md)に範囲・受入・全12検査・新固定SHA/別session/worktree/leaseと一系列の資格を定める。旧FAIL/原物/使用済みUUIDは保持する。

新候補の外部公開・CI・採用・診断runは別判断。既存main8641とboard-review保護は本工程で変更せず、全Repository Gate/製品/MVPは未完成のままとする。
