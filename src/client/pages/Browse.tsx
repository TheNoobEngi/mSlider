import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Cover, Empty, ErrorBox, Loading } from '../components/Common.js';
import { useAsync, useStored } from '../hooks.js';
import type { SeriesSummary } from '../../shared/types.js';

export function Browse() {
  const navigate = useNavigate();
  const sources = useAsync(() => api.sources(), []);
  const [sourceId, setSourceId] = useStored<string>('mslider.source', '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SeriesSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const available = sources.data?.sources ?? [];
  const selected = available.find((source) => source.id === sourceId) ?? available[0];

  // Fall back to the first available source if the stored one has gone away.
  useEffect(() => {
    if (selected && selected.id !== sourceId) setSourceId(selected.id);
  }, [selected, sourceId, setSourceId]);

  async function run(kind: 'search' | 'latest') {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response =
        kind === 'search' ? await api.search(selected.id, query.trim()) : await api.latest(selected.id);
      setResults(response.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  async function add(result: SeriesSummary) {
    setAdding(result.url);
    setError(null);
    try {
      const { series } = await api.addSeries(result.sourceId, result.url);
      navigate(`/series/${series.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(null);
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>Browse</h1>
      </header>

      <main className="content">
        {sources.loading ? <Loading label="Loading sources…" /> : null}
        {sources.error ? <ErrorBox error={sources.error} onRetry={sources.reload} /> : null}

        {sources.data?.errors.length ? (
          <ErrorBox
            error={`Some source configs were skipped: ${sources.data.errors
              .map((e) => `${e.file} (${e.message})`)
              .join('; ')}`}
          />
        ) : null}

        {sources.data && available.length === 0 ? (
          <Empty title="No sources configured">
            <p>
              Drop a JSON config into the <code>sources/</code> folder and restart. See <code>sources/README.md</code>{' '}
              for the format and a worked example.
            </p>
          </Empty>
        ) : null}

        {selected ? (
          <>
            <div className="row wrap" style={{ marginBottom: 12 }}>
              <select
                value={selected.id}
                onChange={(event) => {
                  setSourceId(event.target.value);
                  setResults(null);
                }}
                style={{ width: 'auto', flex: '1 1 160px' }}
              >
                {available.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              {selected.capabilities.latest ? (
                <button type="button" className="btn" onClick={() => run('latest')} disabled={busy}>
                  Latest
                </button>
              ) : null}
            </div>

            <form
              className="row"
              style={{ marginBottom: 18 }}
              onSubmit={(event) => {
                event.preventDefault();
                void run('search');
              }}
            >
              <input
                type="search"
                value={query}
                placeholder={selected.capabilities.search ? `Search ${selected.name}…` : 'Search not supported'}
                onChange={(event) => setQuery(event.target.value)}
                disabled={!selected.capabilities.search}
              />
              <button
                type="submit"
                className="btn primary"
                disabled={busy || !query.trim() || !selected.capabilities.search}
              >
                {busy ? '…' : 'Go'}
              </button>
            </form>

            {error ? <ErrorBox error={error} /> : null}
            {busy && !results ? <Loading label="Crawling…" /> : null}

            {results && results.length === 0 ? <Empty title="No results" /> : null}

            {results && results.length > 0 ? (
              <div className="grid">
                {results.map((result) => (
                  <button
                    key={result.url}
                    type="button"
                    className="card btn ghost"
                    style={{ border: 0, padding: 0, textAlign: 'left' }}
                    onClick={() => void add(result)}
                    disabled={adding !== null}
                  >
                    <Cover src={result.cover} alt={result.title} />
                    <div className="title">{result.title}</div>
                    <div className="sub">{adding === result.url ? 'Adding…' : 'Tap to add'}</div>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </>
  );
}
