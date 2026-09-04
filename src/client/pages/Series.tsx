import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Cover, Empty, ErrorBox, Loading } from '../components/Common.js';
import { useAsync } from '../hooks.js';
import type { LibraryChapter } from '../../shared/types.js';

export function Series() {
  const { seriesId } = useParams();
  const id = Number(seriesId);
  const navigate = useNavigate();
  const { data, loading, error, reload, setData } = useAsync(() => api.series(id), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);

  async function guard(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const refresh = () =>
    guard('refresh', async () => {
      const result = await api.refreshSeries(id);
      setData({ series: result.series, chapters: result.chapters });
    });

  const remove = () =>
    guard('remove', async () => {
      if (!confirm(`Remove "${data?.series.title}" from your library? Reading progress is deleted too.`)) return;
      await api.removeSeries(id);
      navigate('/');
    });

  const toggleRead = (chapter: LibraryChapter) =>
    guard(`read-${chapter.id}`, async () => {
      await api.setRead(chapter.id, !chapter.read);
      reload();
    });

  const markPrevious = (chapter: LibraryChapter) =>
    guard(`upto-${chapter.id}`, async () => {
      const result = await api.markReadUpTo(id, chapter.position);
      if (data) setData({ series: data.series, chapters: result.chapters });
    });

  if (loading && !data) return <Loading />;
  if (error) {
    return (
      <main className="content">
        <ErrorBox error={error} onRetry={reload} />
      </main>
    );
  }
  if (!data) return null;

  const { series, chapters } = data;
  // Resume = the first unread chapter in reading order, else the very first.
  const resume = chapters.find((chapter) => !chapter.read) ?? chapters[0];
  const ordered = newestFirst ? [...chapters].reverse() : chapters;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="btn sm ghost">
          ‹ Back
        </Link>
        <h1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{series.title}</h1>
      </header>

      <main className="content">
        {actionError ? <ErrorBox error={actionError} /> : null}

        <div className="series-head">
          <div style={{ flex: 'none', width: 118 }}>
            <Cover src={series.cover} alt={series.title} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h2>{series.title}</h2>
            <div className="series-meta">
              {[series.author, series.status].filter(Boolean).join(' · ') || series.sourceId}
            </div>
            <div className="series-meta" style={{ marginTop: 4 }}>
              {series.chapterCount} chapters · {series.unreadCount} unread
            </div>
            <div className="row wrap" style={{ marginTop: 10 }}>
              {resume ? (
                <Link className="btn primary sm" to={`/read/${resume.id}`}>
                  {resume.read ? 'Read' : series.unreadCount === series.chapterCount ? 'Start' : 'Resume'}
                </Link>
              ) : null}
              <button type="button" className="btn sm" onClick={refresh} disabled={busy === 'refresh'}>
                {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>

        {series.genres?.length ? (
          <div className="tags">
            {series.genres.map((genre) => (
              <span key={genre} className="tag">
                {genre}
              </span>
            ))}
          </div>
        ) : null}

        {series.description ? <p className="description">{series.description}</p> : null}

        <div className="row wrap" style={{ margin: '18px 0 10px' }}>
          <label className="small muted" htmlFor="direction">
            Reading direction
          </label>
          <select
            id="direction"
            style={{ width: 'auto' }}
            value={series.direction}
            onChange={(event) =>
              void guard('direction', async () => {
                const result = await api.setDirection(id, event.target.value as 'ltr' | 'rtl');
                setData({ series: result.series, chapters });
              })
            }
          >
            <option value="rtl">Right to left (manga)</option>
            <option value="ltr">Left to right</option>
          </select>
          <div className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn sm ghost" onClick={() => setNewestFirst((value) => !value)}>
            {newestFirst ? 'Newest first' : 'Oldest first'}
          </button>
        </div>

        {chapters.length === 0 ? (
          <Empty title="No chapters found">
            <p className="small">
              The source's chapter selectors may not match. Check the <code>chapters</code> section of its config.
            </p>
          </Empty>
        ) : (
          <ul className="chapter-list">
            {ordered.map((chapter) => (
              <li key={chapter.id} className={chapter.read ? 'read' : ''}>
                <div className="row" style={{ padding: '4px 0' }}>
                  <Link to={`/read/${chapter.id}`} style={{ flex: 1, minWidth: 0, display: 'flex', gap: 10, alignItems: 'center', padding: '9px 4px' }}>
                    <span className={`dot ${chapter.isNew ? '' : 'hidden'}`} />
                    <span className="ch-title">
                      <span className="name">{chapter.title}</span>
                      <span className="when">
                        {chapter.publishedAt ?? ''}
                        {chapter.progressPage > 0 && !chapter.read
                          ? `${chapter.publishedAt ? ' · ' : ''}page ${chapter.progressPage + 1}`
                          : ''}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    className="btn sm ghost"
                    title={chapter.read ? 'Mark unread' : 'Mark read'}
                    onClick={() => void toggleRead(chapter)}
                    disabled={busy === `read-${chapter.id}`}
                  >
                    {chapter.read ? '✓' : '○'}
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost"
                    title="Mark this and everything before it as read"
                    onClick={() => void markPrevious(chapter)}
                    disabled={busy === `upto-${chapter.id}`}
                  >
                    ⤓
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div style={{ marginTop: 28 }}>
          <button type="button" className="btn danger sm" onClick={remove} disabled={busy === 'remove'}>
            Remove from library
          </button>
        </div>
      </main>
    </>
  );
}
