import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { ChapterSummary, SeriesDetail, SeriesSummary } from '../../shared/types.js';
import { fetchText, limiterFor } from '../http.js';
import type { ChapterListConfig, FieldSpec, ListingConfig, SourceConfig } from './schema.js';

export interface CrawlContext {
  config: SourceConfig;
  /** Rate-limited GET returning HTML/text, with the source's headers applied. */
  get(url: string): Promise<string>;
}

export function makeContext(config: SourceConfig): CrawlContext {
  const limiter = limiterFor(config.id, config.rateLimit.requests, config.rateLimit.perMs);
  return {
    config,
    get: (url: string) =>
      limiter.run(() =>
        fetchText(url, { headers: { referer: config.baseUrl, ...config.headers } }),
      ),
  };
}

/** Fill {baseUrl}, {query}, {page}, {seriesUrl}, {chapterUrl} in a URL template. */
export function template(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = vars[key];
    return value === undefined ? whole : String(value);
  });
}

function rawValue($: CheerioAPI, scope: Cheerio<AnyNode>, node: AnyNode, spec: FieldSpec): string {
  const el = $(node);
  if (spec.attrs?.length) {
    for (const attr of spec.attrs) {
      const value = attr === 'text' ? el.text() : attr === 'html' ? (el.html() ?? '') : (el.attr(attr) ?? '');
      if (value.trim()) return value;
    }
    return '';
  }
  if (spec.attr === 'text') return el.text();
  if (spec.attr === 'html') return el.html() ?? '';
  return el.attr(spec.attr) ?? '';
}

function postProcess(value: string, spec: FieldSpec, pageUrl: string): string | undefined {
  let out = spec.trim ? value.trim().replace(/\s+/g, ' ') : value;
  if (spec.regex) {
    const match = new RegExp(spec.regex, 's').exec(out);
    if (!match) return undefined;
    out = match[spec.regexGroup] ?? '';
    if (spec.trim) out = out.trim();
  }
  if (!out) return undefined;
  if (spec.resolve) {
    try {
      out = new URL(out, pageUrl).toString();
    } catch {
      return undefined;
    }
  }
  return out;
}

/** Extract a single value described by `spec`, searching within `scope`. */
export function extract(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  spec: FieldSpec | undefined,
  pageUrl: string,
): string | undefined {
  if (!spec) return undefined;
  const nodes = spec.sel ? scope.find(spec.sel).toArray() : scope.toArray();
  for (const node of nodes) {
    const value = postProcess(rawValue($, scope, node, spec), spec, pageUrl);
    if (value !== undefined) return value;
  }
  return spec.default;
}

/** Extract every match described by `spec`. */
export function extractAll(
  $: CheerioAPI,
  scope: Cheerio<AnyNode>,
  spec: FieldSpec | undefined,
  pageUrl: string,
): string[] {
  if (!spec) return [];
  const nodes = spec.sel ? scope.find(spec.sel).toArray() : scope.toArray();
  const out: string[] = [];
  for (const node of nodes) {
    const value = postProcess(rawValue($, scope, node, spec), spec, pageUrl);
    if (value !== undefined) out.push(value);
    if (!spec.list) break;
  }
  return out;
}

/** "Chapter 12.5 - The Sea" -> 12.5 */
export function parseChapterNumber(...candidates: (string | undefined)[]): number | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = /(?:^|[^\d.])(\d{1,5}(?:\.\d{1,3})?)/.exec(candidate);
    if (match?.[1]) {
      const n = Number.parseFloat(match[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(key, 10);
      current = Number.isFinite(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function toUrlList(
  raw: unknown,
  opts: { itemKey?: string; urlTemplate?: string; baseUrl: string; pageUrl: string },
): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    let value: unknown = entry;
    if (value && typeof value === 'object') {
      value = opts.itemKey
        ? (value as Record<string, unknown>)[opts.itemKey]
        : Object.values(value as Record<string, unknown>).find((v) => typeof v === 'string');
    }
    if (typeof value !== 'string' || !value.trim()) continue;
    let url = value.trim();
    if (opts.urlTemplate && !/^https?:\/\//i.test(url)) {
      url = template(opts.urlTemplate, { baseUrl: opts.baseUrl }) + url;
    }
    try {
      out.push(new URL(url, opts.pageUrl).toString());
    } catch {
      /* skip malformed entries rather than failing the whole chapter */
    }
  }
  return out;
}

export class SourceCrawlError extends Error {}

function requireSection<T>(section: T | undefined, sourceId: string, name: string): T {
  if (!section) {
    throw new SourceCrawlError(
      `Source "${sourceId}" has no "${name}" config and no override supplying it.`,
    );
  }
  return section;
}

async function crawlListing(
  ctx: CrawlContext,
  listing: ListingConfig,
  vars: Record<string, string | number>,
): Promise<SeriesSummary[]> {
  const pageUrl = template(listing.url, { baseUrl: ctx.config.baseUrl, ...vars });
  const $ = cheerio.load(await ctx.get(pageUrl));
  const results: SeriesSummary[] = [];

  for (const node of $(listing.item).toArray()) {
    const scope = $(node);
    const title = extract($, scope, listing.fields.title, pageUrl);
    const url = extract($, scope, listing.fields.url, pageUrl);
    if (!title || !url) continue;
    results.push({
      sourceId: ctx.config.id,
      title,
      url,
      cover: extract($, scope, listing.fields.cover, pageUrl),
    });
  }
  return results;
}

export const engine = {
  async search(ctx: CrawlContext, query: string, page: number): Promise<SeriesSummary[]> {
    const listing = requireSection(ctx.config.search, ctx.config.id, 'search');
    return crawlListing(ctx, listing, { query: encodeURIComponent(query), page });
  },

  async latest(ctx: CrawlContext, page: number): Promise<SeriesSummary[]> {
    const listing = requireSection(ctx.config.latest, ctx.config.id, 'latest');
    return crawlListing(ctx, listing, { page });
  },

  async series(ctx: CrawlContext, seriesUrl: string): Promise<SeriesDetail> {
    const detail = requireSection(ctx.config.series, ctx.config.id, 'series');
    const pageUrl = detail.url
      ? template(detail.url, { baseUrl: ctx.config.baseUrl, seriesUrl })
      : seriesUrl;
    const $ = cheerio.load(await ctx.get(pageUrl));
    const root = $.root();

    return {
      sourceId: ctx.config.id,
      url: seriesUrl,
      title: extract($, root, detail.fields.title, pageUrl) ?? seriesUrl,
      cover: extract($, root, detail.fields.cover, pageUrl),
      description: extract($, root, detail.fields.description, pageUrl),
      author: extract($, root, detail.fields.author, pageUrl),
      artist: extract($, root, detail.fields.artist, pageUrl),
      status: extract($, root, detail.fields.status, pageUrl),
      genres: extractAll($, root, detail.fields.genres, pageUrl),
    };
  },

  async chapters(ctx: CrawlContext, seriesUrl: string): Promise<ChapterSummary[]> {
    const list: ChapterListConfig = requireSection(ctx.config.chapters, ctx.config.id, 'chapters');
    const pageUrl = list.url ? template(list.url, { baseUrl: ctx.config.baseUrl, seriesUrl }) : seriesUrl;
    const $ = cheerio.load(await ctx.get(pageUrl));
    const chapters: ChapterSummary[] = [];

    for (const node of $(list.item).toArray()) {
      const scope = $(node);
      const title = extract($, scope, list.fields.title, pageUrl);
      const url = extract($, scope, list.fields.url, pageUrl);
      if (!title || !url) continue;
      chapters.push({
        title,
        url,
        number: parseChapterNumber(extract($, scope, list.fields.number, pageUrl), title, url),
        publishedAt: extract($, scope, list.fields.date, pageUrl),
      });
    }
    // Normalise to oldest-first so chapter positions are stable as new ones land.
    if (list.newestFirst) chapters.reverse();
    return chapters;
  },

  async pages(ctx: CrawlContext, chapterUrl: string): Promise<string[]> {
    const pages = requireSection(ctx.config.pages, ctx.config.id, 'pages');
    const vars = { baseUrl: ctx.config.baseUrl, chapterUrl };
    const pageUrl = pages.url ? template(pages.url, vars) : chapterUrl;
    const body = await ctx.get(pageUrl);

    if (pages.strategy === 'dom') {
      const $ = cheerio.load(body);
      const spec: FieldSpec = {
        attr: pages.attr,
        attrs: pages.attrs,
        resolve: true,
        list: true,
        trim: true,
        regexGroup: 1,
      };
      return extractAll($, $.root(), { ...spec, sel: pages.item }, pageUrl);
    }

    if (pages.strategy === 'script') {
      const match = new RegExp(pages.pattern, 's').exec(body);
      const captured = match?.[1];
      if (!captured) {
        throw new SourceCrawlError(`Page-list pattern did not match at ${pageUrl}`);
      }
      if (pages.parse === 'split') {
        return toUrlList(captured.split(pages.separator), { ...pages, baseUrl: ctx.config.baseUrl, pageUrl });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(captured);
      } catch {
        throw new SourceCrawlError(`Captured page list at ${pageUrl} was not valid JSON`);
      }
      return toUrlList(readPath(parsed, pages.path), { ...pages, baseUrl: ctx.config.baseUrl, pageUrl });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new SourceCrawlError(`Expected JSON from ${pageUrl}`);
    }
    return toUrlList(readPath(parsed, pages.path), { ...pages, baseUrl: ctx.config.baseUrl, pageUrl });
  },
};
