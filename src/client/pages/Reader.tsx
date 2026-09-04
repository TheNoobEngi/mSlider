import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, beaconProgress } from '../api.js';
import { ErrorBox, Loading } from '../components/Common.js';
import { useAsync, useStored } from '../hooks.js';

/** How many pages ahead to warm in the browser cache. */
const PRELOAD_AHEAD = 3;
const PRELOAD_BEHIND = 1;

type FitMode = 'contain' | 'width';

export function Reader() {
  const { chapterId } = useParams();
  const id = Number(chapterId);
  const navigate = useNavigate();
  const location = useLocation();
  /** Set when we arrived by paging backwards out of the following chapter. */
  const enterAtEnd = (location.state as { atEnd?: boolean } | null)?.atEnd === true;

  const { data, loading, error, reload } = useAsync(() => api.pages(id), [id]);
  const [page, setPage] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [fit, setFit] = useStored<FitMode>('mslider.fit', 'contain');

  const total = data?.pages.length ?? 0;
  const rtl = data?.direction === 'rtl';

  // Position ourselves once the page list arrives: resume where we left off,
  // or land on the last page when the reader paged backwards into this chapter.
  useEffect(() => {
    if (!data) return;
    const last = Math.max(0, data.pages.length - 1);
    setPage(enterAtEnd ? last : Math.min(data.progressPage, last));
    setChromeVisible(false);
  }, [data, enterAtEnd]);

  useEffect(() => {
    setImageLoaded(false);
    setImageFailed(false);
  }, [page, id]);

  // Persist progress, coalescing rapid page turns into one write.
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    if (!data || total === 0) return;
    const timer = setTimeout(() => {
      void api.saveProgress(id, page, page >= total - 1).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [data, id, page, total]);

  // A closed tab or a backgrounded phone must not lose the current page.
  useEffect(() => {
    if (!data || total === 0) return;
    const flush = () => beaconProgress(id, pageRef.current, pageRef.current >= total - 1);
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [data, id, total]);

  const goToChapter = useCallback(
    (targetId: number, atEnd: boolean) => {
      navigate(`/read/${targetId}`, { replace: true, state: { atEnd } });
    },
    [navigate],
  );

  /** delta is in reading order: +1 is "further into the chapter". */
  const advance = useCallback(
    (delta: number) => {
      if (!data) return;
      const next = pageRef.current + delta;
      if (next < 0) {
        if (data.prevChapterId) goToChapter(data.prevChapterId, true);
        return;
      }
      if (next >= data.pages.length) {
        beaconProgress(id, data.pages.length - 1, true);
        if (data.nextChapterId) goToChapter(data.nextChapterId, false);
        else setChromeVisible(true); // end of the series so far — show the exit UI
        return;
      }
      setPage(next);
    },
    [data, goToChapter, id],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      switch (event.key) {
        case 'ArrowRight':
          advance(rtl ? -1 : 1);
          break;
        case 'ArrowLeft':
          advance(rtl ? 1 : -1);
          break;
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          advance(1);
          break;
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault();
          advance(-1);
          break;
        case 'Escape':
          navigate(data ? `/series/${data.seriesId}` : '/');
          break;
        case 'm':
          setChromeVisible((visible) => !visible);
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, data, navigate, rtl]);

  // Warm nearby pages so a tap shows the next image immediately.
  useEffect(() => {
    if (!data) return;
    const warmed: HTMLImageElement[] = [];
    for (let offset = -PRELOAD_BEHIND; offset <= PRELOAD_AHEAD; offset++) {
      const target = data.pages[page + offset];
      if (!target || offset === 0) continue;
      const image = new Image();
      image.src = target;
      warmed.push(image);
    }
    return () => {
      warmed.forEach((image) => {
        image.src = '';
      });
    };
  }, [data, page]);

  const touch = useRef<{ x: number; y: number; time: number } | null>(null);
  const onTouchStart = (event: React.TouchEvent) => {
    const point = event.touches[0];
    if (point) touch.current = { x: point.clientX, y: point.clientY, time: Date.now() };
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touch.current;
    const point = event.changedTouches[0];
    touch.current = null;
    if (!start || !point) return;
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    // Horizontal, fast, and clearly not a vertical scroll.
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.8 && Date.now() - start.time < 600) {
      const forward = rtl ? dx > 0 : dx < 0;
      advance(forward ? 1 : -1);
    }
  };

  const zones = useMemo(
    () => [
      { key: 'left', label: rtl ? 'Next page' : 'Previous page', action: () => advance(rtl ? 1 : -1) },
      { key: 'center', label: 'Toggle controls', action: () => setChromeVisible((visible) => !visible) },
      { key: 'right', label: rtl ? 'Previous page' : 'Next page', action: () => advance(rtl ? -1 : 1) },
    ],
    [advance, rtl],
  );

  if (loading && !data) return <div className="reader"><Loading label="Fetching pages…" /></div>;

  if (error) {
    return (
      <div className="reader" style={{ flexDirection: 'column', padding: 20 }}>
        <ErrorBox error={error} onRetry={reload} />
        <div className="row">
          <button type="button" className="btn" onClick={() => void api.pages(id, true).then(reload)}>
            Re-crawl pages
          </button>
          <button type="button" className="btn ghost" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const currentSrc = data.pages[page];
  const atLastPage = page >= total - 1;

  return (
    <div className={`reader ${fit === 'width' ? 'fit-width' : ''}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {currentSrc ? (
        <img
          className="page"
          src={currentSrc}
          alt={`Page ${page + 1} of ${total}`}
          // The first page must appear fast; the rest are already warmed.
          decoding="async"
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageFailed(true)}
          style={{ visibility: imageLoaded ? 'visible' : 'hidden' }}
        />
      ) : null}

      {!imageLoaded && !imageFailed ? (
        <div className="reader-status" style={{ position: 'absolute' }}>
          <div className="spinner" />
          Page {page + 1}
        </div>
      ) : null}

      {imageFailed ? (
        <div className="reader-status" style={{ position: 'absolute' }}>
          <p>Page {page + 1} would not load.</p>
          <button type="button" className="btn sm" onClick={() => void api.pages(id, true).then(reload)}>
            Re-crawl this chapter
          </button>
        </div>
      ) : null}

      <div className="tap-zones">
        {zones.map((zone) => (
          <button key={zone.key} type="button" aria-label={zone.label} onClick={zone.action} />
        ))}
      </div>

      {!chromeVisible ? (
        <div className="page-counter">
          {page + 1} / {total}
        </div>
      ) : null}

      <div className={`reader-bar top ${chromeVisible ? '' : 'hidden'}`}>
        <div className="row">
          <button type="button" className="btn sm ghost" onClick={() => navigate(`/series/${data.seriesId}`)}>
            ‹ Chapters
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="title">{data.chapterTitle}</div>
            <div className="sub">{data.seriesTitle}</div>
          </div>
          <button
            type="button"
            className="btn sm ghost"
            title="Fit mode"
            onClick={() => setFit(fit === 'contain' ? 'width' : 'contain')}
          >
            {fit === 'contain' ? '⤢ Fit' : '↔ Width'}
          </button>
        </div>
      </div>

      <div className={`reader-bar bottom ${chromeVisible ? '' : 'hidden'}`}>
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="sub" style={{ minWidth: 62 }}>
            {page + 1} / {total}
          </span>
          <input
            className="scrubber"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={page}
            // Right-to-left series scrub in the direction the pages actually run.
            style={{ direction: rtl ? 'rtl' : 'ltr' }}
            onChange={(event) => setPage(Number(event.target.value))}
          />
        </div>
        <div className="row">
          <button
            type="button"
            className="btn sm"
            disabled={!data.prevChapterId}
            onClick={() => data.prevChapterId && goToChapter(data.prevChapterId, false)}
          >
            ‹ Prev chapter
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className={`btn sm ${atLastPage ? 'primary' : ''}`}
            disabled={!data.nextChapterId}
            onClick={() => {
              if (!data.nextChapterId) return;
              beaconProgress(id, total - 1, true);
              goToChapter(data.nextChapterId, false);
            }}
          >
            Next chapter ›
          </button>
        </div>
      </div>
    </div>
  );
}
