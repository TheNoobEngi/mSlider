import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/server/config.js and src/server/config.ts are both two levels below the repo root. */
export const rootDir = path.resolve(here, '..', '..');

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.DATA_DIR ?? path.join(rootDir, 'data'),
  sourcesDir: process.env.SOURCES_DIR ?? path.join(rootDir, 'sources'),
  clientDir: path.join(rootDir, 'dist', 'client'),

  /** How often the background poller looks for new chapters. 0 disables it. */
  updateIntervalMinutes: int('UPDATE_INTERVAL_MINUTES', 60),
  /** Wait this long after boot before the first sweep, so startup stays fast. */
  updateStartupDelayMs: int('UPDATE_STARTUP_DELAY_MS', 30_000),

  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 20_000),
  userAgent:
    process.env.USER_AGENT ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',

  /** Optional shared password. When set, every /api call needs it. */
  authToken: process.env.MSLIDER_TOKEN ?? '',
  /**
   * Refuse to fetch hosts that resolve to private/loopback addresses. Turn off
   * only if you deliberately point a source at something on your own LAN.
   */
  blockPrivateAddresses: process.env.ALLOW_PRIVATE_HOSTS !== 'true',
} as const;
