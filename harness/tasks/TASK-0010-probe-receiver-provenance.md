# TASK-0010 受信run作成直後の来歴を確認する

状態は READY。基準は d4164f38005a7654c3281a58a0006a9fc6757d92。固定候補の作成と検証はLOCALで行う。

DEC-039では受信runを作成できたが、起動元が直後に取得した受信runを RUN_PROVENANCE_INVALID で拒否した。終了後のGETは全照合項目に一致した。最初の応答で不一致だった項目は未特定。 [起動元run](https://github.com/uk-product-lab/sns-marketing-manager/actions/runs/42724275145) ・ [受信run](https://github.com/uk-product-lab/sns-marketing-manager/actions/runs/42724310511)

## 受け入れ条件

- PRV-001。固定された一回のPOSTがHTTP 200と正しいID・URLを返した後、そのIDのGETだけを対象にする。同じIDの稼働中runで来歴の未設定項目だけが残る場合に、3秒間隔で読み直せる。初回を含め最大6回とし、追加GETの開始は初回GETから20秒以内。期限または回数に達した場合は BLOCKED。
- PRV-002。明示的な値・型の不一致、別ID、終端runの欠落、来歴以外の検証不良、API失敗は即停止。全項目と既存のrunメタデータ検証が揃って初めてreceiptを作成する。再POST、別ID探索、受信側の検証緩和を行わない。
- PRV-003。成功時と来歴で停止した場合はGET回数、初回と最後の不足・不一致の項目名を起動元の観測に記録する。値・本文・任意文字列は記録対象外。receiptとEnvironmentの境界は従来どおり。
- PRV-004。実runtime経路で、準備中から一致へ進む場合、継続欠落、明示的不一致、受信側が未確定のままのrunを拒否する場合を合成fixtureで検証する。全ハーネスと harness-local-v1 の12項目を固定SHAで自己検証し、別担当が独立に照合する。

対象は probe helper、そのテスト、probe手順書、この契約。公開、実CI、マージ、実probeと本人承認は別判断。
