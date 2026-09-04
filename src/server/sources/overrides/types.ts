import type { ChapterSummary, SeriesDetail, SeriesSummary } from '../../../shared/types.js';
import type { CrawlContext } from '../engine.js';

/**
 * The code escape hatch. A source keeps its JSON config for everything that
 * selectors can express, and adds a module here for the steps they cannot —
 * a token that has to be computed, an image list behind an obfuscated payload,
 * a chapter list that needs pagination.
 *
 * Every method is optional. Whatever you implement replaces that step; the rest
 * still runs through the declarative engine, so you never have to reimplement a
 * whole source to fix one awkward part of it.
 */
export interface SourceOverride {
  /** Must match the `id` of the JSON config this override attaches to. */
  id: string;

  search?(ctx: CrawlContext, query: string, page: number): Promise<SeriesSummary[]>;
  latest?(ctx: CrawlContext, page: number): Promise<SeriesSummary[]>;
  series?(ctx: CrawlContext, seriesUrl: string): Promise<SeriesDetail>;
  chapters?(ctx: CrawlContext, seriesUrl: string): Promise<ChapterSummary[]>;
  pages?(ctx: CrawlContext, chapterUrl: string): Promise<string[]>;

  /** Last chance to rewrite an image URL (CDN swaps, signing) before it is fetched. */
  transformImageUrl?(ctx: CrawlContext, url: string): string;
  /** Extra headers for image requests, merged over the defaults. */
  imageHeaders?(ctx: CrawlContext, url: string): Record<string, string>;
}
