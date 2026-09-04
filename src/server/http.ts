import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

/** Per-host politeness gate: serialises fetches and spaces them out. */
class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly requests: number, private readonly perMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const gap = Math.ceil(this.perMs / Math.max(1, this.requests));
    const result = this.queue.then(fn);
    // Chain the *delay* regardless of whether fn resolved, so a failure does not
    // let the next caller through early.
    this.queue = result.then(
      () => sleep(gap),
      () => sleep(gap),
    );
    return result;
  }
}

const limiters = new Map<string, RateLimiter>();

export function limiterFor(key: string, requests: number, perMs: number): RateLimiter {
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(requests, perMs);
    limiters.set(key, limiter);
  }
  return limiter;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FetchError';
  }
}

function isPrivateAddress(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (type === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
    if (v.startsWith('fe80')) return true; // link local
    // IPv4-mapped, e.g. ::ffff:127.0.0.1
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** Guards against a source config (or a redirect) pointing at internal infrastructure. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FetchError(`Refusing non-http(s) URL: ${url.protocol}`);
  }
  if (!config.blockPrivateAddresses) return;

  const literal = net.isIP(url.hostname) ? url.hostname : null;
  if (literal) {
    if (isPrivateAddress(literal)) throw new FetchError(`Refusing private address: ${url.hostname}`);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new FetchError(`Could not resolve ${url.hostname}`);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FetchError(`Refusing host resolving to a private address: ${url.hostname}`);
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Number of retries on network errors and 5xx/429. */
  retries?: number;
  signal?: AbortSignal;
}

async function fetchOnce(url: string, options: FetchOptions): Promise<Response> {
  const target = new URL(url);
  await assertPublicUrl(target);

  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  return fetch(target, {
    redirect: 'follow',
    signal,
    headers: {
      'user-agent': config.userAgent,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      ...options.headers,
    },
  });
}

/** Fetch with retry/backoff on the failures that are usually transient. */
export async function httpFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const response = await fetchOnce(url, options);
      if (response.status === 429 || response.status >= 500) {
        lastError = new FetchError(`${response.status} ${response.statusText} for ${url}`, response.status);
        // Drain so the socket can be reused.
        await response.body?.cancel().catch(() => {});
        continue;
      }
      return response;
    } catch (error) {
      // A deliberate SSRF/protocol refusal is not worth retrying.
      if (error instanceof FetchError && error.status === undefined) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new FetchError(`Failed to fetch ${url}`);
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await httpFetch(url, options);
  if (!response.ok) throw new FetchError(`${response.status} ${response.statusText} for ${url}`, response.status);
  return response.text();
}
