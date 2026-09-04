import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as cheerio from 'cheerio';

process.env.DATA_DIR = process.env.DATA_DIR ?? '/tmp/mslider-engine-test';
process.env.LOG_LEVEL = 'silent';

const { extract, extractAll, parseChapterNumber, template } = await import('../src/server/sources/engine.js');
const { sourceConfigSchema } = await import('../src/server/sources/schema.js');
const { Source } = await import('../src/server/sources/registry.js');

const field = (partial: Record<string, unknown>) =>
  sourceConfigSchema.shape.search.unwrap().shape.fields.shape.title.parse(partial);

describe('field extraction', () => {
  const $ = cheerio.load(`
    <div class="card">
      <a href="/manga/x" class="link">  Some   Title </a>
      <img data-src="/covers/x.jpg" src="/placeholder.png">
      <span class="n">Chapter 12.5 - Tide</span>
      <div class="genres"><a>Action</a><a>Drama</a></div>
    </div>
  `);
  const scope = $('.card');
  const pageUrl = 'https://site.test/browse';

  it('collapses whitespace in text', () => {
    assert.equal(extract($, scope, field({ sel: '.link' }), pageUrl), 'Some Title');
  });

  it('resolves relative URLs against the page', () => {
    const value = extract($, scope, field({ sel: '.link', attr: 'href', resolve: true }), pageUrl);
    assert.equal(value, 'https://site.test/manga/x');
  });

  it('prefers the first non-empty attribute in attrs', () => {
    const value = extract($, scope, field({ sel: 'img', attrs: ['data-src', 'src'], resolve: true }), pageUrl);
    assert.equal(value, 'https://site.test/covers/x.jpg');
  });

  it('falls through attrs when the first is missing', () => {
    const value = extract($, scope, field({ sel: 'img', attrs: ['data-nope', 'src'], resolve: true }), pageUrl);
    assert.equal(value, 'https://site.test/placeholder.png');
  });

  it('pulls a capture group out with regex', () => {
    const value = extract($, scope, field({ sel: '.n', regex: 'Chapter\\s+([0-9.]+)' }), pageUrl);
    assert.equal(value, '12.5');
  });

  it('falls back to default when nothing matches', () => {
    const value = extract($, scope, field({ sel: '.missing', default: 'Unknown' }), pageUrl);
    assert.equal(value, 'Unknown');
  });

  it('collects every match when list is set', () => {
    assert.deepEqual(extractAll($, scope, field({ sel: '.genres a', list: true }), pageUrl), ['Action', 'Drama']);
  });

  it('returns only the first match when list is not set', () => {
    assert.deepEqual(extractAll($, scope, field({ sel: '.genres a' }), pageUrl), ['Action']);
  });
});

describe('parseChapterNumber', () => {
  it('reads plain and decimal numbers', () => {
    assert.equal(parseChapterNumber('Chapter 7'), 7);
    assert.equal(parseChapterNumber('Ch. 12.5 - Tide'), 12.5);
  });

  it('falls through to the next candidate when the first has no number', () => {
    assert.equal(parseChapterNumber(undefined, 'Epilogue', '/read/series/44'), 44);
  });

  it('gives up rather than inventing a number', () => {
    assert.equal(parseChapterNumber('Epilogue', 'Extra'), undefined);
  });
});

describe('url templates', () => {
  it('substitutes known placeholders and leaves unknown ones alone', () => {
    assert.equal(
      template('{baseUrl}/search?q={query}&p={page}&x={mystery}', { baseUrl: 'https://a.test', query: 'k', page: 2 }),
      'https://a.test/search?q=k&p=2&x={mystery}',
    );
  });
});

describe('override escape hatch', () => {
  const config = sourceConfigSchema.parse({
    id: 'ov',
    name: 'Override Test',
    baseUrl: 'https://ov.test',
    imageHosts: ['*.cdn.ov.test'],
    pages: { strategy: 'dom', item: 'img' },
  });

  it('uses the override for a step it implements', async () => {
    const source = new Source(config, {
      id: 'ov',
      async pages() {
        return ['https://ov.test/a.jpg', 'https://ov.test/b.jpg'];
      },
    });
    assert.deepEqual(await source.pages('https://ov.test/read/1'), [
      'https://ov.test/a.jpg',
      'https://ov.test/b.jpg',
    ]);
  });

  it('applies transformImageUrl on top of whichever page step ran', async () => {
    const source = new Source(config, {
      id: 'ov',
      async pages() {
        return ['https://ov.test/a.jpg'];
      },
      transformImageUrl: (_ctx, url) => url.replace('ov.test', 'img.cdn.ov.test'),
    });
    assert.deepEqual(await source.pages('https://ov.test/read/1'), ['https://img.cdn.ov.test/a.jpg']);
  });

  it('merges override headers over the source defaults', () => {
    const source = new Source(config, {
      id: 'ov',
      imageHeaders: () => ({ referer: 'https://elsewhere.test/' }),
    });
    assert.equal(source.imageHeaders('https://ov.test/a.jpg').referer, 'https://elsewhere.test/');
  });

  it('reports which steps a source can do, counting overrides', () => {
    assert.equal(new Source(config).canSearch, false);
    assert.equal(new Source(config, { id: 'ov', async search() { return []; } }).canSearch, true);
  });
});

describe('image host allowlist', () => {
  const config = sourceConfigSchema.parse({
    id: 'hosts',
    name: 'Hosts',
    baseUrl: 'https://site.test',
    imageHosts: ['*.cdn.site.test', 'images.other.test'],
  });
  const source = new Source(config);

  it('allows the base host, listed hosts, and wildcard subdomains', () => {
    assert.ok(source.allowsImageHost('site.test'));
    assert.ok(source.allowsImageHost('images.other.test'));
    assert.ok(source.allowsImageHost('a.cdn.site.test'));
    assert.ok(source.allowsImageHost('cdn.site.test')); // "*.x" also matches bare "x"
  });

  it('rejects anything else, including lookalikes', () => {
    assert.equal(source.allowsImageHost('evil.test'), false);
    assert.equal(source.allowsImageHost('169.254.169.254'), false);
    assert.equal(source.allowsImageHost('notcdn.site.test.evil.test'), false);
    // A suffix match must not let "xcdn.site.test" through as "*.cdn.site.test".
    assert.equal(source.allowsImageHost('xcdn.site.test'), false);
  });
});
