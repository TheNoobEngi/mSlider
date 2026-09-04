# Sources

Each `*.json` file here describes one site. The file is validated at startup; a
config that fails validation is skipped and reported in the log and in the
Browse tab, so one bad file never takes the server down.

`example.json` ships with `"enabled": false` — it is a template, not a working
site. Copy it, point it at a real site, and flip `enabled` to `true`.

## The shape of a config

| Key | What it does |
| --- | --- |
| `id` | Lowercase slug. Must be unique, and must match an override module's `id` if you write one. |
| `name` | What the UI shows in the source picker. |
| `baseUrl` | Origin. Used for `{baseUrl}` in templates, as the default `Referer`, and as the default allowed image host. |
| `enabled` | Set `false` to keep a config around without loading it. |
| `defaultDirection` | `rtl` for manga, `ltr` for manhwa/webtoons. Per-series overridable in the UI. |
| `imageHosts` | Extra hosts pages may load from. `*.cdn.example.com` matches subdomains. The proxy refuses anything not listed. |
| `imageReferer` | Sent when fetching images. Defaults to `baseUrl` + `/`. |
| `rateLimit` | `{ requests, perMs }`. Requests to a source are serialised and spaced out. |
| `search` / `latest` | Listing pages. `url` supports `{baseUrl}`, `{query}`, `{page}`. |
| `series` | Selectors for the series detail page. |
| `chapters` | Selectors for the chapter list. Set `newestFirst: false` only if the site lists oldest at the top. |
| `pages` | How to find the image URLs for one chapter. Three strategies, below. |

## Field selectors

Every field is an object:

```json
{ "sel": "h3 a", "attr": "href", "resolve": true }
```

- `sel` — CSS selector, relative to the current item. Omit to use the item itself.
- `attr` — `"text"` (default), `"html"`, or an attribute name.
- `attrs` — try several attributes in order, first non-empty wins. This is how
  you handle lazy-loaded images: `["data-src", "data-lazy-src", "src"]`.
- `regex` + `regexGroup` — pull a capture group out of the value.
- `resolve` — turn `/manga/x` into an absolute URL.
- `list` — collect every match instead of the first (used for `genres`).
- `default` — fall back to this when nothing matched.

## Page strategies

**`dom`** — images are `<img>` tags in the HTML:

```json
{ "strategy": "dom", "item": "div.reader-area img", "attrs": ["data-src", "src"] }
```

**`script`** — the image list is embedded in an inline script. Give a regex with
one capture group holding the payload:

```json
{
  "strategy": "script",
  "pattern": "ts_reader\\.run\\((\\{.*?\\})\\);",
  "parse": "json",
  "path": "sources.0.images"
}
```

`path` is a dot path into the parsed JSON (array indices allowed). Use
`itemKey` when entries are objects, and `urlTemplate` when the payload holds
bare filenames that need a prefix.

**`json`** — a separate endpoint returns the list:

```json
{ "strategy": "json", "url": "{baseUrl}/api/chapter?url={chapterUrl}", "path": "data.pages", "itemKey": "url" }
```

## When selectors are not enough

Some sites compute their image list in JavaScript, sign URLs, or paginate the
chapter list. Write an override module in
`src/server/sources/overrides/` and register it in `overrides/index.ts`:

```ts
export const mySourceOverride: SourceOverride = {
  id: 'my-source',
  async pages(ctx, chapterUrl) {
    const html = await ctx.get(chapterUrl);
    // ... whatever this site needs
    return urls;
  },
};
```

Every method is optional, and each one you implement replaces just that step —
`search`, `latest`, `series`, `chapters`, `pages`, plus `transformImageUrl` and
`imageHeaders` hooks. The rest of the source keeps running off the JSON config,
so a site with one awkward part does not need a hand-written crawler.

`ctx.get(url)` is the rate-limited, retrying fetch with the source's headers
already applied — use it rather than calling `fetch` directly, so overrides stay
as polite as the declarative path.

## Writing a config for a new site

1. Open a search results page, a series page, and a chapter page in a browser.
2. In devtools, find a selector that matches one result card, one chapter row,
   and the page images. Verify each with `document.querySelectorAll(...)`.
3. Fill in the config, restart, and check the Browse tab for load errors.
4. If the images 403, the host is probably missing from `imageHosts`, or the
   site wants a different `imageReferer`.
5. If page images are missing entirely, they are likely injected by script —
   switch to the `script` strategy or write an override.
