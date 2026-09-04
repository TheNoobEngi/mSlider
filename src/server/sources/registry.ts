import fs from 'node:fs';
import path from 'node:path';
import type { ChapterSummary, SeriesDetail, SeriesSummary, SourceInfo } from '../../shared/types.js';
import { config } from '../config.js';
import { type CrawlContext, engine, makeContext } from './engine.js';
import { overrides } from './overrides/index.js';
import type { SourceOverride } from './overrides/types.js';
import { type SourceConfig, sourceConfigSchema } from './schema.js';

export class UnknownSourceError extends Error {
  constructor(id: string) {
    super(`Unknown or disabled source: ${id}`);
  }
}

/**
 * A source with its declarative config, its optional override module, and the
 * crawl steps resolved: override method if present, engine implementation
 * otherwise.
 */
export class Source {
  readonly ctx: CrawlContext;

  constructor(readonly config: SourceConfig, readonly override?: SourceOverride) {
    this.ctx = makeContext(config);
  }

  get id(): string {
    return this.config.id;
  }

  get canSearch(): boolean {
    return Boolean(this.override?.search ?? this.config.search);
  }

  get canListLatest(): boolean {
    return Boolean(this.override?.latest ?? this.config.latest);
  }

  info(): SourceInfo {
    return {
      id: this.config.id,
      name: this.config.name,
      baseUrl: this.config.baseUrl,
      locale: this.config.locale,
      defaultDirection: this.config.defaultDirection,
      hasOverride: Boolean(this.override),
      capabilities: { search: this.canSearch, latest: this.canListLatest },
    };
  }

  search(query: string, page = 1): Promise<SeriesSummary[]> {
    return this.override?.search
      ? this.override.search(this.ctx, query, page)
      : engine.search(this.ctx, query, page);
  }

  latest(page = 1): Promise<SeriesSummary[]> {
    return this.override?.latest ? this.override.latest(this.ctx, page) : engine.latest(this.ctx, page);
  }

  series(seriesUrl: string): Promise<SeriesDetail> {
    return this.override?.series
      ? this.override.series(this.ctx, seriesUrl)
      : engine.series(this.ctx, seriesUrl);
  }

  chapters(seriesUrl: string): Promise<ChapterSummary[]> {
    return this.override?.chapters
      ? this.override.chapters(this.ctx, seriesUrl)
      : engine.chapters(this.ctx, seriesUrl);
  }

  async pages(chapterUrl: string): Promise<string[]> {
    const urls = this.override?.pages
      ? await this.override.pages(this.ctx, chapterUrl)
      : await engine.pages(this.ctx, chapterUrl);
    const transform = this.override?.transformImageUrl;
    return transform ? urls.map((url) => transform(this.ctx, url)) : urls;
  }

  /** Headers to use when the proxy fetches a page image from this source. */
  imageHeaders(url: string): Record<string, string> {
    return {
      referer: this.config.imageReferer ?? `${this.config.baseUrl}/`,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...this.config.headers,
      ...(this.override?.imageHeaders?.(this.ctx, url) ?? {}),
    };
  }

  /** Hosts this source is allowed to serve images from. */
  allowsImageHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    const patterns = [new URL(this.config.baseUrl).hostname, ...this.config.imageHosts];
    return patterns.some((pattern) => {
      const p = pattern.toLowerCase().trim();
      if (!p) return false;
      if (p.startsWith('*.')) {
        const suffix = p.slice(1); // ".cdn.example"
        return host === p.slice(2) || host.endsWith(suffix);
      }
      return host === p;
    });
  }
}

const sources = new Map<string, Source>();
const loadErrors: { file: string; message: string }[] = [];

export function loadSources(dir = config.sourcesDir): { loaded: Source[]; errors: typeof loadErrors } {
  sources.clear();
  loadErrors.length = 0;

  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    loadErrors.push({ file: dir, message: 'Sources directory not found' });
    return { loaded: [], errors: loadErrors };
  }

  const overrideById = new Map(overrides.map((o) => [o.id, o]));

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const parsed = sourceConfigSchema.parse(JSON.parse(fs.readFileSync(full, 'utf8')));
      if (!parsed.enabled) continue;
      if (sources.has(parsed.id)) {
        loadErrors.push({ file, message: `Duplicate source id "${parsed.id}"` });
        continue;
      }
      sources.set(parsed.id, new Source(parsed, overrideById.get(parsed.id)));
    } catch (error) {
      loadErrors.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const [id] of overrideById) {
    if (!sources.has(id)) {
      loadErrors.push({ file: `overrides/${id}`, message: `Override has no matching enabled config` });
    }
  }

  return { loaded: [...sources.values()], errors: loadErrors };
}

export function listSources(): Source[] {
  return [...sources.values()];
}

export function getSource(id: string): Source {
  const source = sources.get(id);
  if (!source) throw new UnknownSourceError(id);
  return source;
}

export function findSourceForImageHost(hostname: string): Source | undefined {
  return listSources().find((source) => source.allowsImageHost(hostname));
}

export function getLoadErrors(): typeof loadErrors {
  return loadErrors;
}
