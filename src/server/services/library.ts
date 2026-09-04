import type {
  ChapterPages,
  LibraryChapter,
  LibrarySeries,
  ReadingDirection,
  SeriesDetail,
  UpdateEntry,
} from '../../shared/types.js';
import { type ChapterRow, db, now, type SeriesRow } from '../db.js';
import { getSource } from '../sources/registry.js';

/** Page lists are re-crawled after this long; image URLs are often short-lived. */
const PAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseGenres(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

function direction(raw: string): ReadingDirection {
  return raw === 'ltr' ? 'ltr' : 'rtl';
}

export class NotFoundError extends Error {}

export function addSeries(sourceId: string, seriesUrl: string): LibrarySeries {
  const source = getSource(sourceId);
  const existing = db
    .prepare<[string, string], SeriesRow>('SELECT * FROM series WHERE source_id = ? AND url = ?')
    .get(sourceId, seriesUrl);
  if (existing) return getSeries(existing.id);

  return addSeriesFromDetail(sourceId, seriesUrl, source.config.defaultDirection);
}

function addSeriesFromDetail(sourceId: string, seriesUrl: string, dir: ReadingDirection): LibrarySeries {
  const id = db
    .prepare(
      `INSERT INTO series (source_id, url, title, direction, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sourceId, seriesUrl, seriesUrl, dir, now()).lastInsertRowid as number;
  return getSeries(id);
}

/** Re-crawl a series' metadata and chapter list, recording anything new. */
export async function refreshSeries(seriesId: number, markNew = true): Promise<number> {
  const row = getSeriesRow(seriesId);
  const source = getSource(row.source_id);

  let detail: SeriesDetail | undefined;
  try {
    detail = await source.series(row.url);
  } catch {
    // Metadata is nice to have; a failure here should not stop us finding chapters.
  }

  const chapters = await source.chapters(row.url);

  const insert = db.prepare(
    `INSERT INTO chapters (series_id, url, title, number, published_at, position, discovered_at, is_new)
     VALUES (@series_id, @url, @title, @number, @published_at, @position, @discovered_at, @is_new)
     ON CONFLICT (series_id, url) DO UPDATE SET
       title = excluded.title,
       number = COALESCE(excluded.number, chapters.number),
       published_at = COALESCE(excluded.published_at, chapters.published_at),
       position = excluded.position`,
  );
  const known = new Set(
    db
      .prepare<[number], { url: string }>('SELECT url FROM chapters WHERE series_id = ?')
      .all(seriesId)
      .map((r) => r.url),
  );

  let added = 0;
  const timestamp = now();
  const isFirstCrawl = known.size === 0;

  db.transaction(() => {
    if (detail) {
      db.prepare(
        `UPDATE series SET title = ?, cover = ?, description = ?, author = ?, artist = ?, status = ?, genres = ?
         WHERE id = ?`,
      ).run(
        detail.title || row.title,
        detail.cover ?? row.cover,
        detail.description ?? row.description,
        detail.author ?? row.author,
        detail.artist ?? row.artist,
        detail.status ?? row.status,
        JSON.stringify(detail.genres ?? parseGenres(row.genres)),
        seriesId,
      );
    }

    chapters.forEach((chapter, index) => {
      const fresh = !known.has(chapter.url);
      if (fresh) added++;
      insert.run({
        series_id: seriesId,
        url: chapter.url,
        title: chapter.title,
        number: chapter.number ?? null,
        published_at: chapter.publishedAt ?? null,
        position: index,
        discovered_at: timestamp,
        // Adding a series should not flood the updates feed with its whole backlog.
        is_new: fresh && markNew && !isFirstCrawl ? 1 : 0,
      });
    });

    db.prepare('UPDATE series SET last_checked_at = ?, last_error = NULL WHERE id = ?').run(timestamp, seriesId);
  })();

  return isFirstCrawl ? 0 : added;
}

export function recordSeriesError(seriesId: number, message: string): void {
  db.prepare('UPDATE series SET last_checked_at = ?, last_error = ? WHERE id = ?').run(
    now(),
    message.slice(0, 500),
    seriesId,
  );
}

function getSeriesRow(seriesId: number): SeriesRow {
  const row = db.prepare<[number], SeriesRow>('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!row) throw new NotFoundError(`No series ${seriesId}`);
  return row;
}

interface Counts {
  chapterCount: number;
  unreadCount: number;
  newCount: number;
  latestChapterTitle?: string;
}

function countsFor(seriesId: number): Counts {
  const row = db
    .prepare<[number], { total: number; unread: number; fresh: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(p.completed, 0) = 0 THEN 1 ELSE 0 END) AS unread,
              SUM(c.is_new) AS fresh
       FROM chapters c LEFT JOIN progress p ON p.chapter_id = c.id
       WHERE c.series_id = ?`,
    )
    .get(seriesId);
  const latest = db
    .prepare<[number], { title: string }>(
      'SELECT title FROM chapters WHERE series_id = ? ORDER BY position DESC LIMIT 1',
    )
    .get(seriesId);
  return {
    chapterCount: row?.total ?? 0,
    unreadCount: row?.unread ?? 0,
    newCount: row?.fresh ?? 0,
    latestChapterTitle: latest?.title,
  };
}

function toLibrarySeries(row: SeriesRow): LibrarySeries {
  return {
    id: row.id,
    sourceId: row.source_id,
    url: row.url,
    title: row.title,
    // Covers go through our proxy too — most sources reject hotlinked images.
    cover: row.cover ? proxyUrl(row.source_id, row.cover) : undefined,
    description: row.description ?? undefined,
    author: row.author ?? undefined,
    artist: row.artist ?? undefined,
    status: row.status ?? undefined,
    genres: parseGenres(row.genres),
    direction: direction(row.direction),
    addedAt: row.added_at,
    lastCheckedAt: row.last_checked_at ?? undefined,
    ...countsFor(row.id),
  };
}

export function getSeries(seriesId: number): LibrarySeries {
  return toLibrarySeries(getSeriesRow(seriesId));
}

export function listLibrary(): LibrarySeries[] {
  return db
    .prepare<[], SeriesRow>('SELECT * FROM series ORDER BY title COLLATE NOCASE')
    .all()
    .map(toLibrarySeries);
}

export function removeSeries(seriesId: number): void {
  const result = db.prepare('DELETE FROM series WHERE id = ?').run(seriesId);
  if (result.changes === 0) throw new NotFoundError(`No series ${seriesId}`);
}

export function setDirection(seriesId: number, dir: ReadingDirection): LibrarySeries {
  getSeriesRow(seriesId);
  db.prepare('UPDATE series SET direction = ? WHERE id = ?').run(dir, seriesId);
  return getSeries(seriesId);
}

interface ChapterJoinRow extends ChapterRow {
  page: number | null;
  completed: number | null;
}

function toLibraryChapter(row: ChapterJoinRow): LibraryChapter {
  return {
    id: row.id,
    seriesId: row.series_id,
    url: row.url,
    title: row.title,
    number: row.number ?? undefined,
    publishedAt: row.published_at ?? undefined,
    position: row.position,
    isNew: row.is_new === 1,
    read: (row.completed ?? 0) === 1,
    progressPage: row.page ?? 0,
    pageCount: row.page_count ?? undefined,
  };
}

export function listChapters(seriesId: number): LibraryChapter[] {
  getSeriesRow(seriesId);
  return db
    .prepare<[number], ChapterJoinRow>(
      `SELECT c.*, p.page, p.completed FROM chapters c
       LEFT JOIN progress p ON p.chapter_id = c.id
       WHERE c.series_id = ? ORDER BY c.position`,
    )
    .all(seriesId)
    .map(toLibraryChapter);
}

function getChapterRow(chapterId: number): ChapterRow {
  const row = db.prepare<[number], ChapterRow>('SELECT * FROM chapters WHERE id = ?').get(chapterId);
  if (!row) throw new NotFoundError(`No chapter ${chapterId}`);
  return row;
}

/** Resolve a chapter's image URLs, using the cache unless it has gone stale. */
export async function getChapterPages(chapterId: number, force = false): Promise<ChapterPages> {
  const chapter = getChapterRow(chapterId);
  const series = getSeriesRow(chapter.series_id);

  let pages: string[] | undefined;
  if (!force) {
    const cached = db
      .prepare<[number], { urls: string; fetched_at: string }>('SELECT urls, fetched_at FROM page_cache WHERE chapter_id = ?')
      .get(chapterId);
    if (cached && Date.now() - Date.parse(cached.fetched_at) < PAGE_CACHE_TTL_MS) {
      const parsed: unknown = JSON.parse(cached.urls);
      if (Array.isArray(parsed) && parsed.length) pages = parsed as string[];
    }
  }

  if (!pages) {
    pages = await getSource(series.source_id).pages(chapter.url);
    if (!pages.length) throw new Error(`No pages found for "${chapter.title}"`);
    db.prepare(
      `INSERT INTO page_cache (chapter_id, urls, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (chapter_id) DO UPDATE SET urls = excluded.urls, fetched_at = excluded.fetched_at`,
    ).run(chapterId, JSON.stringify(pages), now());
    db.prepare('UPDATE chapters SET page_count = ? WHERE id = ?').run(pages.length, chapterId);
  }

  const neighbour = (comparison: '<' | '>', order: 'DESC' | 'ASC') =>
    db
      .prepare<[number, number], { id: number }>(
        `SELECT id FROM chapters WHERE series_id = ? AND position ${comparison} ? ORDER BY position ${order} LIMIT 1`,
      )
      .get(chapter.series_id, chapter.position)?.id;

  // Reading a chapter clears its "new" flag.
  db.prepare('UPDATE chapters SET is_new = 0 WHERE id = ?').run(chapterId);
  const progress = db
    .prepare<[number], { page: number }>('SELECT page FROM progress WHERE chapter_id = ?')
    .get(chapterId);

  return {
    chapterId,
    seriesId: series.id,
    seriesTitle: series.title,
    chapterTitle: chapter.title,
    direction: direction(series.direction),
    pages: pages.map((url) => proxyUrl(series.source_id, url)),
    prevChapterId: neighbour('<', 'DESC'),
    nextChapterId: neighbour('>', 'ASC'),
    progressPage: progress?.page ?? 0,
  };
}

/** Images are served through our own origin so the browser never hits the source. */
export function proxyUrl(sourceId: string, imageUrl: string): string {
  const encoded = Buffer.from(imageUrl, 'utf8').toString('base64url');
  return `/api/image/${encodeURIComponent(sourceId)}/${encoded}`;
}

export function setProgress(chapterId: number, page: number, completed: boolean): void {
  getChapterRow(chapterId);
  db.prepare(
    `INSERT INTO progress (chapter_id, page, completed, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (chapter_id) DO UPDATE SET
       page = excluded.page,
       completed = MAX(progress.completed, excluded.completed),
       updated_at = excluded.updated_at`,
  ).run(chapterId, Math.max(0, page), completed ? 1 : 0, now());
}

export function setChapterRead(chapterId: number, read: boolean): void {
  getChapterRow(chapterId);
  if (read) {
    db.prepare(
      `INSERT INTO progress (chapter_id, page, completed, updated_at) VALUES (?, 0, 1, ?)
       ON CONFLICT (chapter_id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at`,
    ).run(chapterId, now());
    db.prepare('UPDATE chapters SET is_new = 0 WHERE id = ?').run(chapterId);
  } else {
    db.prepare('DELETE FROM progress WHERE chapter_id = ?').run(chapterId);
  }
}

/** Mark every chapter up to and including `position` as read. */
export function markReadUpTo(seriesId: number, position: number): void {
  const ids = db
    .prepare<[number, number], { id: number }>('SELECT id FROM chapters WHERE series_id = ? AND position <= ?')
    .all(seriesId, position)
    .map((r) => r.id);
  db.transaction(() => ids.forEach((id) => setChapterRead(id, true)))();
}

export function listUpdates(limit = 100): UpdateEntry[] {
  return db
    .prepare<[number], { chapterId: number; seriesId: number; seriesTitle: string; seriesCover: string | null; chapterTitle: string; discoveredAt: string }>(
      `SELECT c.id AS chapterId, s.id AS seriesId, s.title AS seriesTitle, s.cover AS seriesCover,
              c.title AS chapterTitle, c.discovered_at AS discoveredAt
       FROM chapters c JOIN series s ON s.id = c.series_id
       WHERE c.is_new = 1
       ORDER BY c.discovered_at DESC, c.position DESC
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({ ...row, seriesCover: row.seriesCover ?? undefined }));
}

export function clearUpdates(): void {
  db.prepare('UPDATE chapters SET is_new = 0 WHERE is_new = 1').run();
}

export function listSeriesIds(): number[] {
  return db.prepare<[], { id: number }>('SELECT id FROM series ORDER BY id').all().map((r) => r.id);
}
