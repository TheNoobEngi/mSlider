import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Cover, Empty, ErrorBox, Loading } from '../components/Common.js';
import { useAsync } from '../hooks.js';

export function Library() {
  const { data, loading, error, reload } = useAsync(() => api.library(), []);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  async function checkAll() {
    setChecking(true);
    setCheckMessage(null);
    try {
      const { result } = await api.checkUpdates();
      const failed = result.errors.length;
      setCheckMessage(
        `${result.newChapters} new chapter${result.newChapters === 1 ? '' : 's'} across ${result.checkedSeries} series` +
          (failed ? ` · ${failed} source${failed === 1 ? '' : 's'} failed` : ''),
      );
      reload();
    } catch (err) {
      setCheckMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>Library</h1>
        <div className="spacer" />
        <button type="button" className="btn sm" onClick={checkAll} disabled={checking}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </header>

      <main className="content">
        {checkMessage ? <p className="small muted" style={{ marginTop: 0 }}>{checkMessage}</p> : null}
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        {loading && !data ? <Loading /> : null}

        {data && data.series.length === 0 ? (
          <Empty title="Nothing in your library yet">
            <p>
              Head to <Link to="/browse" style={{ color: 'var(--accent)' }}>Browse</Link> to search a source and add a
              series. Once it is here, mSlider checks it for new chapters on its own.
            </p>
          </Empty>
        ) : null}

        {data && data.series.length > 0 ? (
          <div className="grid">
            {data.series.map((series) => (
              <Link key={series.id} className="card" to={`/series/${series.id}`}>
                <Cover src={series.cover} alt={series.title} />
                {series.unreadCount > 0 ? <span className="pill">{series.unreadCount}</span> : null}
                <div className="title">{series.title}</div>
                <div className="sub">
                  {series.newCount > 0 ? `${series.newCount} new · ` : ''}
                  {series.chapterCount} chapter{series.chapterCount === 1 ? '' : 's'}
                </div>
              </Link>
            ))}
          </div>
        ) : null}
      </main>
    </>
  );
}
