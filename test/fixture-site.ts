import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny stand-in for a manga site, so the crawler can be tested end to end
 * without touching the network. Deliberately awkward in the ways real sites
 * are: lazy-loaded covers, newest-chapter-first listing, and a page list that
 * only exists inside an inline script.
 */

const SERIES = {
  slug: 'test-series',
  title: 'The Cartographer of Quiet Places',
  author: 'A. Writer',
  description: 'A surveyor walks the edges of a map that keeps redrawing itself.',
  genres: ['Adventure', 'Mystery'],
  chapters: [
    { n: 3, title: 'Chapter 3 - The Third Shore', date: '2026-08-01', pages: 3 },
    { n: 2, title: 'Chapter 2 - Salt and Paper', date: '2026-07-20', pages: 2 },
    { n: 1, title: 'Chapter 1 - A Blank Coast', date: '2026-07-01', pages: 4 },
  ],
};

/**
 * Generated page art. Real page proportions and a big page number, so paging
 * through the reader is verifiable by eye rather than by a 1x1 pixel.
 */
function pageImage(label: string, sub: string, hue: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1200" width="800" height="1200">
       <rect width="800" height="1200" fill="hsl(${hue}, 30%, 88%)"/>
       <rect x="30" y="30" width="740" height="1140" fill="none" stroke="hsl(${hue}, 40%, 45%)" stroke-width="4"/>
       <text x="400" y="540" text-anchor="middle" font-family="sans-serif" font-size="150"
             font-weight="700" fill="hsl(${hue}, 45%, 28%)">${label}</text>
       <text x="400" y="640" text-anchor="middle" font-family="sans-serif" font-size="52"
             fill="hsl(${hue}, 35%, 38%)">${sub}</text>
     </svg>`,
    'utf8',
  );
}

export interface FixtureSite {
  origin: string;
  close(): Promise<void>;
  /** How many times each path was fetched — used to prove caching/rate limiting. */
  hits: Map<string, number>;
  /** Chapters the site will admit to having. Raise it to simulate a new release. */
  visibleChapters: number;
  /**
   * Publish every remaining chapter once the series page has been fetched this
   * many times. Adding a series costs two fetches (details + chapter list), so
   * a threshold of 2 releases on the next update sweep. 0 disables it.
   */
  revealAfterSeriesHits: number;
}

export async function startFixtureSite(port = 0): Promise<FixtureSite> {
  const hits = new Map<string, number>();
  const state = { visibleChapters: SERIES.chapters.length, revealAfter: 0, seriesHits: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);

    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };

    if (url.pathname === '/search') {
      const query = (url.searchParams.get('keyword') ?? '').toLowerCase();
      const match = SERIES.title.toLowerCase().includes(query);
      return html(
        match
          ? `<div class="series-card">
               <img data-src="/covers/${SERIES.slug}.gif" src="/placeholder.gif">
               <h3><a href="/series/${SERIES.slug}">${SERIES.title}</a></h3>
             </div>`
          : '<p>No results</p>',
      );
    }

    if (url.pathname === `/series/${SERIES.slug}`) {
      state.seriesHits++;
      if (state.revealAfter > 0 && state.seriesHits > state.revealAfter) {
        state.visibleChapters = SERIES.chapters.length;
      }
      // Newest first, as almost every real site does.
      const rows = SERIES.chapters
        .slice(SERIES.chapters.length - state.visibleChapters)
        .map(
          (chapter) =>
            `<li><a href="/read/${SERIES.slug}/${chapter.n}">
               <span class="chapter-name">${chapter.title}</span>
               <span class="chapter-date">${chapter.date}</span>
             </a></li>`,
        )
        .join('');
      return html(
        `<h1 class="series-title">${SERIES.title}</h1>
         <div class="series-cover"><img data-src="/covers/${SERIES.slug}.gif"></div>
         <div class="series-synopsis">${SERIES.description}</div>
         <span class="meta-author">${SERIES.author}</span>
         <span class="meta-status">Ongoing</span>
         <div class="genre-list">${SERIES.genres.map((g) => `<a href="#">${g}</a>`).join('')}</div>
         <ul class="chapter-list">${rows}</ul>`,
      );
    }

    const readMatch = /^\/read\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (readMatch) {
      const number = Number(readMatch[2]);
      const chapter = SERIES.chapters.find((c) => c.n === number);
      if (!chapter) {
        res.writeHead(404).end('no such chapter');
        return;
      }
      // Page URLs live only inside a script, which no CSS selector can reach.
      const images = Array.from(
        { length: chapter.pages },
        (_, i) => `/img/${SERIES.slug}/${number}/p${i + 1}.gif`,
      );
      return html(
        `<div id="reader"></div>
         <script>
           window.chapterData = ${JSON.stringify({ chapter: { images } })};
         </script>`,
      );
    }

    if (url.pathname.endsWith('.gif')) {
      // Hotlink protection: a missing or wrong Referer is refused, like the real thing.
      const referer = req.headers.referer ?? '';
      if (!referer.startsWith(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)) {
        res.writeHead(403).end('hotlinking not allowed');
        return;
      }

      const page = /^\/img\/[^/]+\/(\d+)\/p(\d+)\.gif$/.exec(url.pathname);
      const body = page
        ? pageImage(`${page[2]}`, `Chapter ${page[1]} \u00b7 page ${page[2]}`, Number(page[1]) * 70)
        : pageImage('COVER', SERIES.title, 210);

      res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(body.length) });
      res.end(body);
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const boundPort = (server.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${boundPort}`,
    hits,
    get visibleChapters() {
      return state.visibleChapters;
    },
    set visibleChapters(value: number) {
      state.visibleChapters = value;
    },
    get revealAfterSeriesHits() {
      return state.revealAfter;
    },
    set revealAfterSeriesHits(value: number) {
      state.revealAfter = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const fixtureSeries = SERIES;
