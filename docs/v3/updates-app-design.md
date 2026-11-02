# UIS — Updates App — Design

**Status:** draft v1 — CORS proxy (§6 option A), excerpt-only parsing (§5), and browser TTS default (§9) are decided
**Extends:** `dashboard-architecture.md` — cross-references below use that doc's section numbers (§1, §6, §8, §10, §11).

---

## 1. What this is

`updates` is a new **app** (real state, persistence, interaction — per §4's app/widget split): it pulls from multiple sources (RSS/Atom feeds and generic web pages), normalizes everything into one shape, and shows a unified reverse-chronological list with links. Optionally, a selection of items can be turned into a spoken audio digest via AI summarization + TTS.

It inherits the shell's core tenets — textual-first, offline-first for anything already cached, fails quietly, no build step, no bundler, native APIs, single Custom Element as the registry entry point.

---

## 2. The rule this breaks

§1 states: *"Only the weather widget touches the network; everything else must work with zero connectivity."* That's no longer true once `updates` exists — it's now two network-touching modules, not one. Both should get the same treatment: fail quiet, stale-while-revalidate, never a blocking spinner. Worth updating §1's wording rather than leaving it stale.

---

## 3. Directory structure

```
/apps/updates/
  updates-app.js          # defines <app-updates>, manifest, orchestration, list rendering
  source-manager.js        # CRUD for sources, dispatches to the right parser, dedup
  parsers/
    rss-parser.js           # DOMParser-based RSS 2.0 / Atom parsing
    web-parser.js            # heuristic HTML meta/content extraction
  digest/
    digest-builder.js        # selected items -> spoken-style script (via Claude API)
    tts-provider.js          # pluggable TTS: 'browser' (default) | 'external'
```

One registry entry point, same as every other module — `core/registry.js` only ever imports `updates-app.js`; everything under `parsers/` and `digest/` is a plain ES module import internal to the app, invisible to the grid engine. This matches §6's per-module isolation: if `digest-builder.js` throws, the list still renders.

Registry addition:
```js
updates: { type: 'app', load: () => import('/apps/updates/updates-app.js') },
```

---

## 4. Source model & homogenized schema

**Source config** — new namespaced key, not folded into `dashboard:config`, since sources are user data that grows over time rather than static settings:

```js
// dashboard:app:updates:sources
[
  {
    id: 'slug-or-nanoid',
    type: 'rss' | 'web',
    url: 'https://example.com/feed.xml',
    label: 'Human name',        // source badge in the list
    enabled: true,
    refreshIntervalMin: 30,      // falls back to a global default if unset
  }
]
```

**Homogenized item** — the one shape every parser must converge on before the item touches cache, dedup, the list renderer, or the digest builder. Neither the UI nor the digest pipeline should ever need to know whether an item came from RSS or a scrape:

```js
{
  id: `${sourceId}::${link}`,   // plain string key, no hashing needed — just uniqueness
  sourceId,
  sourceLabel,
  title,
  link,
  excerpt,        // plain text, trimmed, HTML stripped
  publishedAt,    // ISO string, or null -> falls back to fetchedAt for sorting
  fetchedAt,
  read: false,
}
```

---

## 5. Parsing

**RSS/Atom** (`rss-parser.js`): native `DOMParser` on the fetched XML text — zero deps, same philosophy as the weather widget's native `fetch`. RSS (`<item>`) and Atom (`<entry>`) have different tag vocabularies, so the parser checks the document's root element and picks the right field mapping.

**Web pages** (`web-parser.js`): no feed to lean on, so this is heuristic extraction from `<meta property="og:title">` / `og:description`, falling back to `<title>` and the first `<p>`. **Decided: excerpt-only for v1** — no Readability port, no content-body reconstruction. It produces title + excerpt + link, which is what a "list with links" needs. Full-article reading is a materially bigger feature (sanitization, XSS surface from arbitrary third-party HTML rendered in your shell) and stays out of scope until there's a specific reason to revisit it.

---

## 6. CORS — the central problem

RSS feeds are hit or miss on CORS (some are permissive since they're meant to be machine-read); arbitrary web pages almost never send headers permitting a `localhost` origin to read them. Without something in the middle, `fetch()` from `updates` will silently fail for a large fraction of sources.

| Option | Trade-off |
|---|---|
| **A. Extend `start.sh` with a proxy route** (`GET /api/proxy?url=...`) | Same-origin from the browser's view, no CORS issue at all, no new dependency — `start.sh` is already custom Ruby with path-traversal blocking, not a vanilla static server. Changes the server's trust boundary slightly: it now makes outbound requests on your behalf (SSRF-shaped surface if this box is ever exposed past localhost — worth a README line). |
| **B. Public CORS proxy** (corsproxy.io, allorigins, etc.) | Zero code, but a third party sees every URL you fetch, and it's a dependency outside your control — directly at odds with §1's "resilient on protected networks" goal. Not recommended. |
| **C. RSS-only, drop generic web-page sources** | Sidesteps the problem for CORS-permissive feeds, but silently fails on the rest and removes "web page" as a source type from the actual ask. |

**Decided: A.** It's the only option that doesn't compromise the resilience goal or introduce a third party, and it fits the existing pattern of `start.sh` already being "your" server rather than an off-the-shelf one.

**A second, independent reason A is necessary:** the Anthropic API (used in §9's digest step) blocks direct browser calls by default — the CORS block is deliberate, not an oversight, because the alternative is an API key sitting in client-side JS for anyone to read from dev tools. So the digest step needs the same proxy pattern regardless of what's decided for RSS/web sources: a server-side route that holds the key and forwards the request, never handing the key to the browser. This is a stronger argument for A than the RSS/web case alone — for RSS you could technically ship v1 without a proxy and just accept some sources fail; for the AI call there's no equivalent "ship it anyway" option once you're using the real API.

---

## 7. Fetch & cache strategy (mirrors §10's weather pattern)

1. Render cached items immediately from `dashboard:app:updates:cache` — stale-while-revalidate, same as weather.
2. Background-refresh per source, merge new items in, dedup by `id`.
3. `AbortController` timeout per source (~3–5s; a little longer than weather's 3s given page sizes vary more). One source timing out doesn't block the others — same per-import isolation principle as §6 of the main doc.
4. On failure: leave stale items visible, subtle "source last updated [time]" note — never a blocking spinner or an error state that competes visually with the rest of the shell.

---

## 8. List rendering

Flat, reverse-chronological, merged across all enabled sources — source badge, title, excerpt, relative time. This is the same "river" model already running through Huginn, the Telegram client, and Read Later: no folders, just one stream with filters layered on top if wanted (per-source toggle, unread-only) rather than the default view being pre-split by source.

---

## 9. Audio digest — two-stage pipeline

```
selected items  --(1. summarize)-->  spoken-style script  --(2. synthesize)-->  audio
```

**Stage 1 — script generation.** User selects items (checkbox in the list, or a "digest my unread" shortcut). Homogenized item data goes into a prompt to the Claude API — Haiku, the same model already doing Instagram-capture summarization in Read Later — which returns a spoken-style script rather than concatenated excerpts read verbatim. Worth storing the generated script as editable text before synthesis; cheap to add, useful if the AI mangles something.

**Correction from v1 of this doc:** the Claude API key does *not* belong in `dashboard:config` the way weather's `apiKey` does. Anthropic's API rejects direct browser calls by default specifically to stop keys from being exposed in client-side code, and a leaked Claude key is a real financial exposure in a way a rate-limited OpenWeatherMap key isn't. The key lives server-side — an env var or gitignored `secrets.local.json` read by `start.sh` — and the client talks to a local `POST /api/digest` route that holds the key and forwards the request. The browser never sees it. See §6 for the matching proxy-route rationale.

**Stage 2 — text-to-speech**, provider-pluggable the same way weather's `provider` field works in §10 of the main doc:

| Provider | Notes |
|---|---|
| `browser` (default) | Native `SpeechSynthesisUtterance`. Zero cost, zero network, zero API key. Can't be saved as a file — the Web Speech API gives you speaker playback, not a Blob — and voice quality depends entirely on the OS. |
| `external` (opt-in) | e.g. OpenAI TTS / ElevenLabs. Needs an API key in config, same secrets pattern as weather's `apiKey`. Returns real audio bytes, so it can be cached, downloaded, replayed without re-synthesizing. Costs money per digest. |

**Decided: `browser` as the v1 default** — zero setup, consistent with the shell's cold-open-fast ethos. The provider field stays open the way weather's already is, so `external` can be layered on later without touching the pipeline shape. Same deferral pattern §11 uses for the theme toggle.

---

## 10. Persistence keys (extends §8's table)

```
dashboard:app:updates:sources     # source list
dashboard:app:updates:cache       # { sourceId: { items: [...], fetchedAt } }
dashboard:app:updates:digests     # saved digest scripts + metadata (optional history)
```

`read` state can live directly on cached items rather than a separate set — one less key to keep in sync.

---

## 11. Manifest & grid placement

Row 1 is already full (`2+4+6=12`). Row 2 currently only has weather (`2×2`, col 1), leaving 10 columns open — `updates` fills that gap exactly:

```js
static manifest = {
  id: 'updates',
  type: 'app',
  cols: 10,
  rows: 4,
  defaultCol: 3,
  defaultRow: 2,
  expandable: true,
};
```

---

## 12. Backend & DB — what's actually needed

**Backend: yes, minimal.** Two stateless routes added to the existing `start.sh`, not a new service:

```
GET  /api/proxy?url=...     # relays RSS/web fetches, sidesteps CORS (§6)
POST /api/digest             # holds the Claude key server-side, forwards the summarization request (§9)
```

Neither route needs to remember anything between requests.

**DB: no.** `dashboard:app:updates:sources` / `:cache` / `:digests` in localStorage cover everything this app needs to persist — same pattern already carrying todo, bookmarks, and weather's cache. A DB would be solving a problem (schema, migrations, a process to keep alive) this app doesn't have.

The one thing that could tip this toward real server-side storage: scheduled background refresh independent of the browser being open, so items are already fresh at cold-open. Even there, a flat JSON file on disk fits "what's on disk is what runs" better than a DB engine — worth treating as a deferred v2 decision, not a v1 requirement.

---

## 13. Decisions locked for v1

- **CORS handling:** §6 option A — proxy route in `start.sh`. Applies to both RSS/web fetches and the AI digest call.
- **Web-page parsing:** excerpt + link only (§5). No full-article extraction.
- **TTS:** `browser` provider default (§9). `external` stays a documented-but-unbuilt upgrade path.

Next natural step is the two `start.sh` routes (§12), since `source-manager.js` and both parsers depend on `/api/proxy` existing before they can be exercised end-to-end.
