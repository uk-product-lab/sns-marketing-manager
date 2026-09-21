import { useState } from "react";

const foundationChecks = [
  "MacとiPhone相当の画面幅を自動検証",
  "ローカルD1でマイグレーションを検証",
  "外部サービスへの通信を行わない",
] as const;

export function App() {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="hero__copy">
          <p className="eyebrow">Product foundation</p>
          <h1 id="page-title">SNS Marketing Manager</h1>
          <p className="lead">
            複数ブランドの投稿準備を、MacとiPhoneから安全に扱うための製品基盤です。
          </p>
          <p className="phase-note" role="status">
            現在は基盤準備中です。SNS管理機能や外部サービス接続はまだ実装していません。
          </p>
        </div>

        <aside className="status-card" aria-labelledby="status-title">
          <div className="status-card__heading">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <p className="status-card__label">現在の工程</p>
              <h2 id="status-title">品質基盤を確認中</h2>
            </div>
          </div>

          <button
            className="details-toggle"
            type="button"
            aria-expanded={detailsOpen}
            aria-controls="foundation-details"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? "確認項目を閉じる" : "確認項目を表示"}
          </button>

          {detailsOpen ? (
            <div id="foundation-details" className="foundation-details">
              <h3>この工程で確かめること</h3>
              <ul>
                {foundationChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
              <p>SNSへの自動投稿は行いません。</p>
            </div>
          ) : null}
        </aside>
      </section>

      <section className="guardrails" aria-labelledby="guardrails-title">
        <div>
          <p className="section-kicker">Foundation guardrails</p>
          <h2 id="guardrails-title">後続機能のための安全な土台</h2>
        </div>
        <dl className="guardrail-grid">
          <div>
            <dt>画面</dt>
            <dd>Mac・iPhone相当のレスポンシブ表示</dd>
          </div>
          <div>
            <dt>データ</dt>
            <dd>資格情報なしのローカルD1検証</dd>
          </div>
          <div>
            <dt>外部接続</dt>
            <dd>課金・実SNS・実メールへの通信なし</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
