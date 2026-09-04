import { z } from 'zod';

/**
 * A source is described declaratively: where to fetch, and which selectors pull
 * each field out of the returned HTML. Anything a selector cannot express is
 * handled by an optional override module (see ./overrides).
 */

/** How to pull one value out of a cheerio scope. */
export const fieldSchema = z.object({
  /** CSS selector, relative to the item/document scope. Omit to use the scope itself. */
  sel: z.string().optional(),
  /** "text" (default), "html", or an attribute name such as "href" or "data-src". */
  attr: z.string().default('text'),
  /** Try these attributes in order, first non-empty wins. Useful for lazy-loaded images. */
  attrs: z.array(z.string()).optional(),
  /** Extract a capture group from the raw value. */
  regex: z.string().optional(),
  regexGroup: z.number().int().min(0).default(1),
  /** Resolve the value against the page URL, turning "/manga/x" into an absolute URL. */
  resolve: z.boolean().default(false),
  /** Collect every match instead of only the first. */
  list: z.boolean().default(false),
  trim: z.boolean().default(true),
  default: z.string().optional(),
});
export type FieldSpec = z.infer<typeof fieldSchema>;

const listingSchema = z.object({
  /** URL template. Placeholders: {baseUrl} {query} {page} {seriesUrl} {chapterUrl}. */
  url: z.string(),
  /** Selector matching one row/card per result. */
  item: z.string(),
  fields: z.object({
    title: fieldSchema,
    url: fieldSchema,
    cover: fieldSchema.optional(),
  }),
  /** Selector that, when present, means "there is another page of results". */
  nextPage: z.string().optional(),
});

const detailSchema = z.object({
  /** Defaults to the series URL itself. */
  url: z.string().optional(),
  fields: z.object({
    title: fieldSchema.optional(),
    cover: fieldSchema.optional(),
    description: fieldSchema.optional(),
    author: fieldSchema.optional(),
    artist: fieldSchema.optional(),
    status: fieldSchema.optional(),
    genres: fieldSchema.optional(),
  }),
});

const chapterListSchema = z.object({
  /** Defaults to the series URL — most sites list chapters on the series page. */
  url: z.string().optional(),
  item: z.string(),
  fields: z.object({
    title: fieldSchema,
    url: fieldSchema,
    number: fieldSchema.optional(),
    date: fieldSchema.optional(),
  }),
  /**
   * Most sites list newest chapter first. We store oldest-first, so leave this
   * true unless a source genuinely lists oldest at the top.
   */
  newestFirst: z.boolean().default(true),
});

const pagesSchema = z.discriminatedUnion('strategy', [
  /** Image URLs sit in the DOM as <img> tags. */
  z.object({
    strategy: z.literal('dom'),
    url: z.string().optional(),
    item: z.string(),
    attr: z.string().default('src'),
    attrs: z.array(z.string()).optional(),
  }),
  /** Image URLs live in an inline <script>, typically as a JSON array. */
  z.object({
    strategy: z.literal('script'),
    url: z.string().optional(),
    /** Regex with one capture group containing the payload. */
    pattern: z.string(),
    /** Parse the captured group as JSON (default) or split it on `separator`. */
    parse: z.enum(['json', 'split']).default('json'),
    separator: z.string().default(','),
    /** Dot path into the parsed JSON, e.g. "chapter.images". Empty means the root. */
    path: z.string().default(''),
    /** When array entries are objects, the property holding the URL. */
    itemKey: z.string().optional(),
    /** Prefix relative filenames with this template, e.g. "{baseUrl}/uploads/". */
    urlTemplate: z.string().optional(),
  }),
  /** A separate JSON endpoint returns the page list. */
  z.object({
    strategy: z.literal('json'),
    url: z.string(),
    path: z.string().default(''),
    itemKey: z.string().optional(),
    urlTemplate: z.string().optional(),
  }),
]);

export const sourceConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'id must be lowercase slug-like'),
  name: z.string(),
  baseUrl: z.string().url(),
  locale: z.string().default('en'),
  enabled: z.boolean().default(true),
  defaultDirection: z.enum(['ltr', 'rtl']).default('rtl'),

  /** Extra hosts images may be served from (CDNs). Supports a leading "*." wildcard. */
  imageHosts: z.array(z.string()).default([]),
  /** Sent as Referer when fetching images; many sites hotlink-protect. Defaults to baseUrl. */
  imageReferer: z.string().optional(),
  headers: z.record(z.string()).default({}),
  /** Politeness: at most `requests` fetches per `perMs` window, plus a fixed gap. */
  rateLimit: z
    .object({ requests: z.number().int().positive().default(1), perMs: z.number().int().positive().default(1000) })
    .default({ requests: 1, perMs: 1000 }),

  search: listingSchema.optional(),
  latest: listingSchema.optional(),
  series: detailSchema.optional(),
  chapters: chapterListSchema.optional(),
  pages: pagesSchema.optional(),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type ListingConfig = z.infer<typeof listingSchema>;
export type ChapterListConfig = z.infer<typeof chapterListSchema>;
export type PagesConfig = z.infer<typeof pagesSchema>;
