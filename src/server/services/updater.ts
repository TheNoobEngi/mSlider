import type { UpdateCheckResult } from '../../shared/types.js';
import { config } from '../config.js';
import { sleep } from '../http.js';
import { getSeries, listSeriesIds, recordSeriesError, refreshSeries } from './library.js';

let running: Promise<UpdateCheckResult> | null = null;
let lastResult: UpdateCheckResult | null = null;
let timer: NodeJS.Timeout | null = null;

/**
 * Sweep every series in the library for new chapters. Series are checked one at
 * a time; the per-source rate limiter already spaces out the requests, and a
 * background job has no reason to hammer anything.
 */
async function sweep(log: (msg: string) => void): Promise<UpdateCheckResult> {
  const ids = listSeriesIds();
  const errors: UpdateCheckResult['errors'] = [];
  let newChapters = 0;

  for (const id of ids) {
    try {
      const added = await refreshSeries(id, true);
      newChapters += added;
      if (added > 0) log(`${getSeries(id).title}: ${added} new chapter(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let title = `series ${id}`;
      try {
        title = getSeries(id).title;
        recordSeriesError(id, message);
      } catch {
        /* series was removed mid-sweep */
      }
      errors.push({ seriesId: id, title, message });
      log(`${title}: update check failed — ${message}`);
    }
    // A small gap between series keeps a multi-source sweep from bursting.
    await sleep(250);
  }

  return { checkedSeries: ids.length, newChapters, errors, finishedAt: new Date().toISOString() };
}

/** Run a sweep, joining the in-flight one if a check is already running. */
export function checkForUpdates(log: (msg: string) => void = () => {}): Promise<UpdateCheckResult> {
  if (running) return running;
  running = sweep(log)
    .then((result) => {
      lastResult = result;
      return result;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

export function isChecking(): boolean {
  return running !== null;
}

export function getLastResult(): UpdateCheckResult | null {
  return lastResult;
}

export function startUpdateScheduler(log: (msg: string) => void): void {
  if (config.updateIntervalMinutes <= 0) {
    log('Background update checks disabled (UPDATE_INTERVAL_MINUTES=0)');
    return;
  }
  const intervalMs = config.updateIntervalMinutes * 60_000;
  const tick = () => {
    checkForUpdates(log).catch((error: unknown) => log(`Update sweep failed: ${String(error)}`));
  };

  setTimeout(() => {
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }, config.updateStartupDelayMs).unref?.();

  log(`Checking for new chapters every ${config.updateIntervalMinutes} min`);
}

export function stopUpdateScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
