import type {
  ChapterPages,
  LibraryChapter,
  LibrarySeries,
  ReadingDirection,
  SeriesSummary,
  SourceInfo,
  UpdateCheckResult,
  UpdateEntry,
} from '../shared/types.js';

/** Set once if the server was started with MSLIDER_TOKEN. Kept in localStorage. */
const TOKEN_KEY = 'mslider.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  sources: () => request<{ sources: SourceInfo[]; errors: { file: string; message: string }[] }>('/sources'),

  search: (source: string, q: string, page = 1) =>
    request<{ results: SeriesSummary[] }>(
      `/search?source=${encodeURIComponent(source)}&q=${encodeURIComponent(q)}&page=${page}`,
    ),

  latest: (source: string, page = 1) =>
    request<{ results: SeriesSummary[] }>(`/latest?source=${encodeURIComponent(source)}&page=${page}`),

  library: () => request<{ series: LibrarySeries[] }>('/library'),
  addSeries: (sourceId: string, url: string) => post<{ series: LibrarySeries }>('/library', { sourceId, url }),
  series: (id: number) => request<{ series: LibrarySeries; chapters: LibraryChapter[] }>(`/library/${id}`),
  removeSeries: (id: number) => request<{ ok: true }>(`/library/${id}`, { method: 'DELETE' }),
  setDirection: (id: number, direction: ReadingDirection) =>
    request<{ series: LibrarySeries }>(`/library/${id}`, { method: 'PATCH', body: JSON.stringify({ direction }) }),
  refreshSeries: (id: number) =>
    post<{ added: number; series: LibrarySeries; chapters: LibraryChapter[] }>(`/library/${id}/refresh`),
  markReadUpTo: (id: number, position: number) =>
    post<{ chapters: LibraryChapter[] }>(`/library/${id}/read-up-to`, { position }),

  pages: (chapterId: number, refresh = false) =>
    request<ChapterPages>(`/chapters/${chapterId}/pages${refresh ? '?refresh=true' : ''}`),
  saveProgress: (chapterId: number, page: number, completed: boolean) =>
    post<{ ok: true }>(`/chapters/${chapterId}/progress`, { page, completed }),
  setRead: (chapterId: number, read: boolean) => post<{ ok: true }>(`/chapters/${chapterId}/read`, { read }),

  updates: () =>
    request<{ entries: UpdateEntry[]; checking: boolean; last: UpdateCheckResult | null }>('/updates'),
  checkUpdates: () => post<{ result: UpdateCheckResult }>('/updates/check'),
  clearUpdates: () => post<{ ok: true }>('/updates/clear'),
};

/** Progress beacons must survive the page being closed mid-chapter. */
export function beaconProgress(chapterId: number, page: number, completed: boolean): void {
  const token = getToken();
  const url = `/api/chapters/${chapterId}/progress${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const payload = JSON.stringify({ page, completed });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    return;
  }
  void fetch(url, { method: 'POST', body: payload, headers: { 'content-type': 'application/json' }, keepalive: true });
}
