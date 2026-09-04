# mSlider

A self-hosted manga reader that turns pages instead of scrolling a strip, and
keeps track of new chapters across several sites so you don't have to check each
one by hand.

Two problems it solves:

- **Reading.** A lot of sites only offer an endless vertical scroll. mSlider
  shows one page at a time and you tap to advance — left/right zones, swipes,
  arrow keys — with the next few pages preloaded so a tap is instant.
- **Keeping up.** Add a series once, and a background job re-checks its chapter
  list on a schedule. New chapters land in an Updates feed instead of you
  opening five bookmarks.

It runs as a single web app, so you open it from your phone, tablet or desktop
at the same URL, and reading progress follows you between them.

## How it fits together

```
browser ──▶ Fastify server ──▶ source config (JSON) ──▶ the site
             │                        └ optional TS override
             ├─ SQLite: library, chapters, progress, page cache
             └─ image proxy: page images are fetched server-side
```

The server does all the crawling. That matters for three reasons: browsers can't
fetch cross-origin HTML, most sites reject hotlinked images unless the request
carries the right `Referer`, and a server can keep polling for new chapters while
your phone is asleep.

**mSlider ships with no sites configured.** `sources/example.json` is a disabled
template. You point it at whatever you read by writing a config — see
[`sources/README.md`](sources/README.md).

## Running it

```bash
npm install
npm run dev      # server on :8080, Vite dev server on :5173
```

Open <http://localhost:5173>. For a real deployment:

```bash
npm run build
npm start        # serves API + client on :8080
```

Or with Docker:

```bash
docker compose up -d --build
```

### Try it without configuring a site

```bash
npm run demo
```

This starts a local stand-in manga site alongside the real server and points a
source config at it — nothing leaves your machine. Open
<http://localhost:5173>, then: **Browse → Demo Site → search "cartographer" →
tap the result**. Open a chapter to test the tap zones, then go back to
**Library → Check for updates**: the demo site publishes a held-back chapter on
that first sweep, so it shows up in **Updates**.

It's the fastest way to confirm the reader, library and update detection all
behave before you write a config for a real source.

Add it to your phone's home screen and it runs full-screen like an app.

### Configuration

Everything is environment variables, all optional:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen. |
| `DATA_DIR` | `./data` | SQLite database location. **Back this up** — it holds your library and progress. |
| `SOURCES_DIR` | `./sources` | Where source configs are read from. |
| `UPDATE_INTERVAL_MINUTES` | `60` | How often to check for new chapters. `0` disables it. |
| `MSLIDER_TOKEN` | *(unset)* | When set, every API call needs this as a bearer token. Set it if the app is reachable from the internet. |
| `USER_AGENT` | a desktop Chrome string | Sent with every request. |
| `REQUEST_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `ALLOW_PRIVATE_HOSTS` | `false` | Lets sources point at private/loopback addresses. Only for local testing. |

If you expose this beyond your own network, put it behind HTTPS and set
`MSLIDER_TOKEN`. There is no multi-user support — it assumes one reader.

## Using it

**Browse** → pick a source, search, tap a result to add it. The first crawl pulls
in metadata and the whole back catalogue without marking it all as new.

**Library** → your series with unread counts. "Check for updates" runs a sweep now
rather than waiting for the timer.

**Series page** → chapter list, per-series reading direction (right-to-left for
manga, left-to-right for webtoons), mark-as-read, and "mark this and everything
before it" for when you're catching up mid-series.

**Reader** → the point of the whole thing:

| Input | Action |
| --- | --- |
| Tap left / right third | Previous / next page, flipped for right-to-left series |
| Tap centre | Show or hide the controls |
| Swipe horizontally | Same as tapping |
| `←` `→` | Page, following the series' direction |
| `↑` `↓` `space` | Page, always in reading order |
| `m` | Toggle controls |
| `Esc` | Back to the chapter list |

Paging past the last page rolls into the next chapter and marks the current one
read. Progress is saved as you go, including when you close the tab mid-chapter.

## Adding a site

A source is a JSON file of selectors — no code for the common case:

```json
{
  "id": "my-site",
  "name": "My Site",
  "baseUrl": "https://example.com",
  "chapters": {
    "item": "ul.chapter-list li",
    "fields": {
      "title": { "sel": "a .chapter-name" },
      "url": { "sel": "a", "attr": "href", "resolve": true }
    }
  },
  "pages": { "strategy": "dom", "item": ".reader img", "attrs": ["data-src", "src"] }
}
```

Three strategies cover how sites hand over page images: `dom` (they're `<img>`
tags), `script` (a JSON blob in an inline script), and `json` (a separate
endpoint). When none of those fit — the list is computed in JavaScript, URLs are
signed, the chapter list paginates — you write an override module in
`src/server/sources/overrides/` implementing just the step that's awkward. The
rest of the source keeps running off the JSON.

Full reference and a worked example: [`sources/README.md`](sources/README.md).

### Debugging a new config

- Source doesn't appear → it failed validation. The reason is in the server log
  and at the top of the Browse tab.
- Results are empty → your `item` selector doesn't match. Check it in devtools
  with `document.querySelectorAll(...)`.
- Images 403 → the CDN host isn't in `imageHosts`, or the site wants a different
  `imageReferer`.
- No pages found → they're probably injected by script. Try the `script`
  strategy, or write an override.

## Layout

```
src/server/sources/   config schema, crawl engine, registry, override hooks
src/server/services/  library operations and the background update sweep
src/server/routes/    HTTP API and the image proxy
src/client/pages/     Library, Updates, Browse, Series, Reader
sources/              your site configs
test/                 runs against a fixture site — no network needed
```

## Tests

```bash
npm test        # 39 tests: crawl, parse, store, proxy, update detection
npm run typecheck
```

`npm run typecheck` covers the server, the client, and the test/demo helpers.

The suite spins up a fixture HTTP server that behaves like a real site — lazy
loaded covers, newest-chapter-first listings, page URLs hidden in an inline
script, and hotlink protection — then drives the whole flow through the real API.

## Scope and limits

- One user. No accounts, no per-user libraries.
- Online reading only. Page lists are cached for six hours; images aren't stored
  for offline use.
- Nothing is bundled. The app has no sites in it until you configure them, and it
  stores no chapter content — only URLs, metadata and your reading position.
