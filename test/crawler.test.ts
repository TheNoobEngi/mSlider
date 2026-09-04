import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ChapterPages, LibraryChapter, LibrarySeries, SeriesSummary } from '../src/shared/types.js';
import { startFixtureSite, type FixtureSite } from './fixture-site.js';

/**
 * These run against a fixture HTTP server standing in for a manga site, so the
 * whole path — crawl, parse, store, proxy — is exercised without the network.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mslider-test-'));
const dataDir = path.join(tmp, 'data');
const sourcesDir = path.join(tmp, 'sources');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(sourcesDir, { recursive: true });

// config.ts reads these at import time, so they must be set before anything else loads.
process.env.DATA_DIR = dataDir;
process.env.SOURCES_DIR = sourcesDir;
process.env.ALLOW_PRIVATE_HOSTS = 'true'; // the fixture lives on 127.0.0.1
process.env.UPDATE_INTERVAL_MINUTES = '0'; // no background sweeps during tests
process.env.LOG_LEVEL = 'silent';

let site: FixtureSite;
let app: FastifyInstance;

function sourceConfig(origin: string) {
  return {
    id: 'fixture',
    name: 'Fixture Scans',
    baseUrl: origin,
    defaultDirection: 'rtl',
    rateLimit: { requests: 5, perMs: 100 },
    search: {
      url: '{baseUrl}/search?keyword={query}&page={page}',
      item: 'div.series-card',
      fields: {
        title: { sel: 'h3 a' },
        url: { sel: 'h3 a', attr: 'href', resolve: true },
        cover: { sel: 'img', attrs: ['data-src', 'src'], resolve: true },
      },
    },
    series: {
      fields: {
        title: { sel: 'h1.series-title' },
        cover: { sel: '.series-cover img', attrs: ['data-src', 'src'], resolve: true },
        description: { sel: '.series-synopsis' },
        author: { sel: '.meta-author' },
        status: { sel: '.meta-status' },
        genres: { sel: '.genre-list a', list: true },
      },
    },
    chapters: {
      item: 'ul.chapter-list li',
      newestFirst: true,
      fields: {
        title: { sel: 'a .chapter-name' },
        url: { sel: 'a', attr: 'href', resolve: true },
        number: { sel: 'a .chapter-name', regex: 'Chapter\\s+([0-9.]+)' },
        date: { sel: 'a .chapter-date' },
      },
    },
    pages: {
      strategy: 'script',
      pattern: 'window\\.chapterData\\s*=\\s*(\\{.*?\\});',
      parse: 'json',
      path: 'chapter.images',
    },
  };
}

before(async () => {
  site = await startFixtureSite();
  // Start with only the two oldest chapters visible, so we can "release" one later.
  site.visibleChapters = 2;
  fs.writeFileSync(path.join(sourcesDir, 'fixture.json'), JSON.stringify(sourceConfig(site.origin), null, 2));

  const { buildApp } = await import('../src/server/app.js');
  app = await buildApp({ serveClient: false, logLevel: 'silent' });
  await app.ready();
});

after(async () => {
  await app?.close();
  await site?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('source loading', () => {
  it('loads the fixture config and reports its capabilities', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sources' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { sources: { id: string; capabilities: { search: boolean } }[]; errors: unknown[] };
    assert.deepEqual(body.errors, []);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0]?.id, 'fixture');
    assert.equal(body.sources[0]?.capabilities.search, true);
  });
});

describe('search', () => {
  it('parses result cards and proxies the cover URL', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/search?source=fixture&q=cartographer' });
    assert.equal(response.statusCode, 200);
    const { results } = response.json() as { results: SeriesSummary[] };
    assert.equal(results.length, 1);
    assert.match(results[0]!.title, /Cartographer/);
    assert.ok(results[0]!.url.startsWith(site.origin));
    // The lazy-loaded data-src wins over the placeholder src, and the cover is proxied.
    assert.ok(results[0]!.cover?.startsWith('/api/image/fixture/'));
  });

  it('returns nothing for a query that does not match', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/search?source=fixture&q=nonexistent' });
    const { results } = response.json() as { results: SeriesSummary[] };
    assert.equal(results.length, 0);
  });

  it('404s on an unknown source', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/search?source=nope&q=x' });
    assert.equal(response.statusCode, 404);
  });
});

let seriesId: number;
let chapters: LibraryChapter[];

describe('adding a series', () => {
  it('stores metadata and the existing backlog', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/library',
      payload: { sourceId: 'fixture', url: `${site.origin}/series/test-series` },
    });
    assert.equal(response.statusCode, 201);
    const { series } = response.json() as { series: LibrarySeries };
    seriesId = series.id;

    assert.match(series.title, /Cartographer/);
    assert.equal(series.author, 'A. Writer');
    assert.equal(series.status, 'Ongoing');
    assert.deepEqual(series.genres, ['Adventure', 'Mystery']);
    assert.equal(series.chapterCount, 2);
    // The backlog must not arrive pre-flagged as new — that would be noise on day one.
    assert.equal(series.newCount, 0);
  });

  it('normalises a newest-first listing to oldest-first positions', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/library/${seriesId}` });
    const body = response.json() as { chapters: LibraryChapter[] };
    chapters = body.chapters;

    assert.equal(chapters.length, 2);
    assert.equal(chapters[0]?.position, 0);
    assert.match(chapters[0]!.title, /Chapter 1/);
    assert.match(chapters[1]!.title, /Chapter 2/);
    assert.equal(chapters[0]?.number, 1);
    assert.equal(chapters[1]?.number, 2);
    assert.equal(chapters[0]?.publishedAt, '2026-07-01');
  });

  it('is idempotent — adding the same series again returns the same row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/library',
      payload: { sourceId: 'fixture', url: `${site.origin}/series/test-series` },
    });
    const { series } = response.json() as { series: LibrarySeries };
    assert.equal(series.id, seriesId);

    const library = (await app.inject({ method: 'GET', url: '/api/library' })).json() as { series: LibrarySeries[] };
    assert.equal(library.series.length, 1);
  });
});

describe('chapter pages', () => {
  let pages: ChapterPages;

  it('pulls image URLs out of an inline script', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/chapters/${chapters[0]!.id}/pages` });
    assert.equal(response.statusCode, 200);
    pages = response.json() as ChapterPages;

    assert.equal(pages.pages.length, 4); // chapter 1 has 4 pages
    assert.equal(pages.direction, 'rtl');
    assert.equal(pages.prevChapterId, undefined);
    assert.equal(pages.nextChapterId, chapters[1]!.id);
    for (const page of pages.pages) assert.ok(page.startsWith('/api/image/fixture/'));
  });

  it('serves page images through the proxy, satisfying hotlink protection', async () => {
    const response = await app.inject({ method: 'GET', url: pages.pages[0]! });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /^image\/svg\+xml/);
    // The bytes are the real image, and they are the page we asked for.
    const body = response.rawPayload.toString('utf8');
    assert.match(body, /^<svg/);
    assert.match(body, /Chapter 1 · page 1/);
  });

  it('serves the correct image for a later page, not a cached first page', async () => {
    const response = await app.inject({ method: 'GET', url: pages.pages[3]! });
    assert.equal(response.statusCode, 200);
    assert.match(response.rawPayload.toString('utf8'), /Chapter 1 · page 4/);
  });

  it('caches the page list instead of re-crawling on every open', async () => {
    const before = site.hits.get('/read/test-series/1') ?? 0;
    await app.inject({ method: 'GET', url: `/api/chapters/${chapters[0]!.id}/pages` });
    assert.equal(site.hits.get('/read/test-series/1') ?? 0, before);
  });

  it('re-crawls when asked explicitly', async () => {
    const before = site.hits.get('/read/test-series/1') ?? 0;
    await app.inject({ method: 'GET', url: `/api/chapters/${chapters[0]!.id}/pages?refresh=true` });
    assert.equal(site.hits.get('/read/test-series/1') ?? 0, before + 1);
  });

  it('refuses to proxy a host the source does not declare', async () => {
    const forged = Buffer.from('http://169.254.169.254/latest/meta-data/', 'utf8').toString('base64url');
    const response = await app.inject({ method: 'GET', url: `/api/image/fixture/${forged}` });
    assert.equal(response.statusCode, 403);
  });
});

describe('reading progress', () => {
  it('tracks the current page and marks a chapter complete', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapters[0]!.id}/progress`,
      payload: { page: 2, completed: false },
    });
    let body = (await app.inject({ method: 'GET', url: `/api/library/${seriesId}` })).json() as {
      series: LibrarySeries;
      chapters: LibraryChapter[];
    };
    assert.equal(body.chapters[0]?.progressPage, 2);
    assert.equal(body.chapters[0]?.read, false);
    assert.equal(body.series.unreadCount, 2);

    await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapters[0]!.id}/progress`,
      payload: { page: 3, completed: true },
    });
    body = (await app.inject({ method: 'GET', url: `/api/library/${seriesId}` })).json() as typeof body;
    assert.equal(body.chapters[0]?.read, true);
    assert.equal(body.series.unreadCount, 1);
  });

  it('marks everything up to a position as read', async () => {
    await app.inject({ method: 'POST', url: `/api/library/${seriesId}/read-up-to`, payload: { position: 1 } });
    const body = (await app.inject({ method: 'GET', url: `/api/library/${seriesId}` })).json() as {
      series: LibrarySeries;
    };
    assert.equal(body.series.unreadCount, 0);
  });

  it('rejects a negative page', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/chapters/${chapters[0]!.id}/progress`,
      payload: { page: -1 },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('update checking', () => {
  it('finds a newly released chapter and flags only that one', async () => {
    site.visibleChapters = 3; // the site publishes chapter 3

    const response = await app.inject({ method: 'POST', url: '/api/updates/check' });
    assert.equal(response.statusCode, 200);
    const { result } = response.json() as { result: { newChapters: number; checkedSeries: number; errors: unknown[] } };
    assert.equal(result.checkedSeries, 1);
    assert.equal(result.newChapters, 1);
    assert.deepEqual(result.errors, []);

    const updates = (await app.inject({ method: 'GET', url: '/api/updates' })).json() as {
      entries: { chapterTitle: string; seriesTitle: string }[];
    };
    assert.equal(updates.entries.length, 1);
    assert.match(updates.entries[0]!.chapterTitle, /Chapter 3/);
  });

  it('reports the new chapter against the series and keeps positions stable', async () => {
    const body = (await app.inject({ method: 'GET', url: `/api/library/${seriesId}` })).json() as {
      series: LibrarySeries;
      chapters: LibraryChapter[];
    };
    assert.equal(body.series.chapterCount, 3);
    assert.equal(body.series.unreadCount, 1);
    assert.equal(body.series.newCount, 1);
    // Chapters 1 and 2 must not have shifted, or read state would point at the wrong ones.
    assert.match(body.chapters[0]!.title, /Chapter 1/);
    assert.match(body.chapters[1]!.title, /Chapter 2/);
    assert.match(body.chapters[2]!.title, /Chapter 3/);
    assert.equal(body.chapters[0]?.read, true);
  });

  it('does not re-flag the same chapter on a second sweep', async () => {
    const { result } = (await app.inject({ method: 'POST', url: '/api/updates/check' })).json() as {
      result: { newChapters: number };
    };
    assert.equal(result.newChapters, 0);
  });

  it('clears the updates feed', async () => {
    await app.inject({ method: 'POST', url: '/api/updates/clear' });
    const updates = (await app.inject({ method: 'GET', url: '/api/updates' })).json() as { entries: unknown[] };
    assert.equal(updates.entries.length, 0);
  });
});

describe('removing a series', () => {
  it('deletes the series and everything hanging off it', async () => {
    const response = await app.inject({ method: 'DELETE', url: `/api/library/${seriesId}` });
    assert.equal(response.statusCode, 200);
    const library = (await app.inject({ method: 'GET', url: '/api/library' })).json() as { series: unknown[] };
    assert.equal(library.series.length, 0);
    // Chapters were cascade-deleted, so their pages are gone too.
    const pages = await app.inject({ method: 'GET', url: `/api/chapters/${chapters[0]!.id}/pages` });
    assert.equal(pages.statusCode, 404);
  });
});
