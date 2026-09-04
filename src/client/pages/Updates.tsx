import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Empty, ErrorBox, Loading } from '../components/Common.js';
import { useAsync } from '../hooks.js';

function relative(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  const minutes = Math.round(diffMs / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Updates() {
  const { data, loading, error, reload } = useAsync(() => api.updates(), []);

  async function clear() {
    await api.clearUpdates();
    reload();
  }

  return (
    <>
      <header className="topbar">
        <h1>Updates</h1>
        <div className="spacer" />
        {data && data.entries.length > 0 ? (
          <button type="button" className="btn sm ghost" onClick={clear}>
            Clear
          </button>
        ) : null}
      </header>

      <main className="content">
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        {loading && !data ? <Loading /> : null}

        {data?.last?.errors.length ? (
          <ErrorBox
            error={`Last check could not reach ${data.last.errors.length} series: ${data.last.errors
              .map((e) => e.title)
              .join(', ')}`}
          />
        ) : null}

        {data && data.entries.length === 0 ? (
          <Empty title="No new chapters">
            <p>New chapters found by the background check show up here.</p>
          </Empty>
        ) : null}

        {data && data.entries.length > 0 ? (
          <ul className="chapter-list">
            {data.entries.map((entry) => (
              <li key={entry.chapterId} className="row" style={{ padding: '4px 0' }}>
                <Link to={`/read/${entry.chapterId}`} style={{ flex: 1, minWidth: 0 }}>
                  <span className="dot" />
                  <span className="ch-title">
                    <span className="name">{entry.chapterTitle}</span>
                    <span className="when">
                      {entry.seriesTitle} · {relative(entry.discoveredAt)}
                    </span>
                  </span>
                </Link>
                <Link className="btn sm ghost" to={`/series/${entry.seriesId}`}>
                  Series
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </>
  );
}
