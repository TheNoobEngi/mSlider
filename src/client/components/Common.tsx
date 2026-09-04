import type { ReactNode } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="error">
      <div>{error}</div>
      {onRetry ? (
        <button type="button" className="btn sm ghost" style={{ marginTop: 10 }} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Covers are hotlink-protected on most sources, so they go through the proxy too. */
export function Cover({ src, alt }: { src?: string; alt: string }) {
  return (
    <img
      className="cover"
      src={src || '/icon.svg'}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={(event) => {
        event.currentTarget.src = '/icon.svg';
      }}
    />
  );
}
