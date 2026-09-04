import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db: SqliteDatabase = new Database(path.join(config.dataDir, 'mslider.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS series (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  cover         TEXT,
  description   TEXT,
  author        TEXT,
  artist        TEXT,
  status        TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',
  direction     TEXT NOT NULL DEFAULT 'rtl',
  added_at      TEXT NOT NULL,
  last_checked_at TEXT,
  last_error    TEXT,
  UNIQUE (source_id, url)
);

CREATE TABLE IF NOT EXISTS chapters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id     INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  number        REAL,
  published_at  TEXT,
  position      INTEGER NOT NULL,
  discovered_at TEXT NOT NULL,
  is_new        INTEGER NOT NULL DEFAULT 0,
  page_count    INTEGER,
  UNIQUE (series_id, url)
);
CREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters(series_id, position);
CREATE INDEX IF NOT EXISTS idx_chapters_new ON chapters(is_new, discovered_at DESC);

CREATE TABLE IF NOT EXISTS progress (
  chapter_id  INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_cache (
  chapter_id  INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  urls        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
`);

export function now(): string {
  return new Date().toISOString();
}

export interface SeriesRow {
  id: number;
  source_id: string;
  url: string;
  title: string;
  cover: string | null;
  description: string | null;
  author: string | null;
  artist: string | null;
  status: string | null;
  genres: string;
  direction: string;
  added_at: string;
  last_checked_at: string | null;
  last_error: string | null;
}

export interface ChapterRow {
  id: number;
  series_id: number;
  url: string;
  title: string;
  number: number | null;
  published_at: string | null;
  position: number;
  discovered_at: string;
  is_new: number;
  page_count: number | null;
}
