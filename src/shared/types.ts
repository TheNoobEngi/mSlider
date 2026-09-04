/** Types shared between the crawler backend and the reader frontend. */

export interface SourceInfo {
  id: string;
  name: string;
  baseUrl: string;
  locale: string;
  /** Right-to-left is the norm for Japanese manga, left-to-right for most webtoons/manhwa. */
  defaultDirection: ReadingDirection;
  /** True when a hand-written override module supplies part of the crawl. */
  hasOverride: boolean;
  capabilities: {
    search: boolean;
    latest: boolean;
  };
}

export type ReadingDirection = 'ltr' | 'rtl';

export interface SeriesSummary {
  sourceId: string;
  url: string;
  title: string;
  cover?: string;
}

export interface SeriesDetail extends SeriesSummary {
  description?: string;
  author?: string;
  artist?: string;
  status?: string;
  genres?: string[];
}

export interface ChapterSummary {
  url: string;
  title: string;
  /** Parsed chapter number when one could be found; used for ordering and dedupe. */
  number?: number;
  publishedAt?: string;
}

/** A series the user has added to their library. */
export interface LibrarySeries extends SeriesDetail {
  id: number;
  addedAt: string;
  lastCheckedAt?: string;
  direction: ReadingDirection;
  chapterCount: number;
  unreadCount: number;
  newCount: number;
  latestChapterTitle?: string;
}

export interface LibraryChapter extends ChapterSummary {
  id: number;
  seriesId: number;
  /** Position in the source's own listing, normalised to oldest-first. */
  position: number;
  isNew: boolean;
  read: boolean;
  progressPage: number;
  pageCount?: number;
}

export interface ChapterPages {
  chapterId: number;
  seriesId: number;
  seriesTitle: string;
  chapterTitle: string;
  direction: ReadingDirection;
  /** Same-origin proxy URLs — the browser never talks to the source directly. */
  pages: string[];
  prevChapterId?: number;
  nextChapterId?: number;
  progressPage: number;
}

export interface UpdateEntry {
  chapterId: number;
  seriesId: number;
  seriesTitle: string;
  seriesCover?: string;
  chapterTitle: string;
  discoveredAt: string;
}

export interface UpdateCheckResult {
  checkedSeries: number;
  newChapters: number;
  errors: { seriesId: number; title: string; message: string }[];
  finishedAt: string;
}
