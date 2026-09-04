/**
 * One-command demo: starts a local stand-in manga site, points a source config
 * at it, and boots the real server against it.
 *
 * Nothing here touches the internet — the "site" is the same fixture the test
 * suite drives, so you can exercise the reader, the library and update
 * detection end to end before writing a config for a real source.
 *
 *   npm run demo    →  http://localhost:5173
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite } from '../test/fixture-site.js';

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const sourcesDir = path.join(demoDir, 'sources');
const dataDir = path.join(demoDir, 'data');

// The fixture lives on 127.0.0.1, which the SSRF guard blocks by default.
process.env.ALLOW_PRIVATE_HOSTS = 'true';
process.env.SOURCES_DIR = sourcesDir;
process.env.DATA_DIR = dataDir;
// Sweeps are triggered by hand here, via "Check for updates" in the UI.
process.env.UPDATE_INTERVAL_MINUTES = '0';

const site = await startFixtureSite(8091);

// Hold back the newest chapter, then publish it once the series has been added
// (that costs two fetches), so the first "Check for updates" actually finds one.
site.visibleChapters = 2;
site.revealAfterSeriesHits = 2;

fs.mkdirSync(sourcesDir, { recursive: true });
fs.writeFileSync(
  path.join(sourcesDir, 'demo.json'),
  JSON.stringify(
    {
      id: 'demo',
      name: 'Demo Site (local fixture)',
      baseUrl: site.origin,
      defaultDirection: 'rtl',
      rateLimit: { requests: 5, perMs: 200 },
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
      // The fixture hides its page list in an inline script, like many real sites.
      pages: {
        strategy: 'script',
        pattern: 'window\\.chapterData\\s*=\\s*(\\{.*?\\});',
        parse: 'json',
        path: 'chapter.images',
      },
    },
    null,
    2,
  ),
);

const { buildApp } = await import('../src/server/app.js');
const app = await buildApp({ serveClient: false });
await app.listen({ port: 8080, host: '127.0.0.1' });

app.log.info(`Demo site running at ${site.origin}`);
app.log.info('Open http://localhost:5173 — Browse → Demo Site → search "cartographer" → tap a result');
app.log.info('Then: Library → "Check for updates" to see chapter 3 appear in Updates');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all([app.close(), site.close()]).then(() => process.exit(0));
  });
}
