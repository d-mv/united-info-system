# United InfoSystem (UIS) — Architecture Design

**Status:** draft v1
**Constraints locked in:** no build step, no `package.json`, no framework runtime, served locally via a static file server (not `file://`, not a hosted page, not a browser extension).

---

## 1. Goals

- **Cold-open fast.** This replaces the browser homepage — every millisecond before first paint is felt on every new tab.
- **Cloneable and runnable with zero setup** beyond a static server command.
- **Modular.** Apps and widgets are independent modules that can be added, removed, or broken without affecting the rest of the shell.
- **Textual-first.** Minimal graphics, no borders between modules, seamless grid — visual weight comes from typography and spacing, not chrome. One deliberate exception: weather condition icons, for faster glanceable recognition — see §10.
- **Resilient offline / on protected networks.** Only the weather widget touches the network; everything else must work with zero connectivity.

**Terminology:**
- **Shell** — the main block: the grid container that holds and positions everything.
- **App** — a functional module with real state and interaction (todo, bookmarks).
- **Widget** — a display-first module with minimal or no interaction (clock, weather).
- **Module** — umbrella term for either, used when the distinction doesn't matter.

---

## 2. Directory Structure

```
/index.html                 # the shell — grid container, inline critical CSS
/core/
  grid.js                   # layout engine — reads config, places modules into the shell
  registry.js                # module id -> { type, load } map
  storage.js                 # thin localStorage wrapper, namespaced keys
/apps/
  todo/
    todo-app.js               # defines <app-todo>
  bookmarks/
    bookmarks-app.js          # defines <app-bookmarks>
/widgets/
  clock/
    clock-widget.js           # defines <widget-clock>
  weather/
    weather-widget.js         # defines <widget-weather>
/config.example.json         # template — copy to config.local.json
/config.local.json           # gitignored — API keys, layout overrides
/README.md                   # clone + run instructions
```

No `src/`, no `dist/`. What's on disk is what runs.

---

## 3. Runtime Model

- Served via `serve.rb` — a ~100-line, zero-dependency Ruby script (stdlib `socket` only, no gems, no `npx`/Node, no Python) that serves static files with correct MIME types and blocks path traversal. `ruby serve.rb [port] [root]`.
- Real ES modules (`<script type="module" src="/core/grid.js">`), real `import`/`export`. No bundler, no transpilation. This works because we're on `http://localhost:PORT`, not `file://`.
- Browser homepage is set to `http://localhost:PORT`. See §12 for the "who keeps the server running" question — it's a real gap worth deciding on deliberately.

---

## 4. Component Contract — Apps & Widgets (Web Components)

Given the native-APIs-first preference and the desire to avoid a framework runtime tax, every module — app or widget — is a **Custom Element**, not a Vue component. This gets you lifecycle hooks, encapsulation, and zero framework overhead for free from the platform.

**Apps vs. widgets:** apps (todo, bookmarks) carry real functional state — user input, persistence, interaction. Widgets (clock, weather) are display-first, with minimal or no interaction. Both are built identically as Custom Elements — the distinction is about what a module *does*, not how it's implemented — but it drives directory placement (`/apps/` vs `/widgets/`) and the manifest's `type` field.

```js
// widgets/clock/clock-widget.js
export class ClockWidget extends HTMLElement {
  static manifest = {
    id: 'clock',
    type: 'widget',
    cols: 2,
    rows: 1,
    defaultCol: 1,
    defaultRow: 1,
    expandable: true,
  };

  connectedCallback() {
    this._tick();
    this._interval = setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }

  _tick() {
    this.textContent = new Date().toLocaleTimeString();
  }
}

customElements.define('widget-clock', ClockWidget);
```

**Why not Shadow DOM:** CSS custom properties (theme tokens — spacing, type scale, color) pierce shadow boundaries fine, but given the "seamless, no borders" requirement, light DOM keeps styling simpler — one global stylesheet governs module internals rather than duplicating tokens per shadow root. Revisit only if a module needs true style isolation.

**Manifest fields:**

| field | meaning |
|---|---|
| `id` | unique module id, also the registry key |
| `type` | `'app'` or `'widget'` |
| `cols` / `rows` | span in grid units |
| `defaultCol` / `defaultRow` | 1-indexed default placement |
| `expandable` | whether the hover-zoom-to-fullpage affordance applies |

Per your spec: clock = `2×1` top-left (`col:1,row:1`), todo = `4×4` top-right.

---

## 5. Grid System

This is CSS Grid with unit-based placement, not true masonry (masonry auto-packs variable-height items; here every module has a declared, fixed span). Worth being precise about since the CSS APIs differ.

```css
#shell {
  display: grid;
  grid-template-columns: repeat(var(--grid-cols), var(--cell-size));
  grid-auto-rows: var(--cell-size);
  gap: 0; /* seamless — no visible borders between modules */
}

[data-module] {
  grid-column: var(--col) / span var(--col-span);
  grid-row: var(--row) / span var(--row-span);
  padding: var(--module-padding); /* the only separation between modules */
}
```

`core/grid.js` reads each module's manifest, sets the four custom properties inline per element, and appends it to `#shell`. `--grid-cols` and `--cell-size` come from `config.local.json` so the grid density is user-tunable without touching code.

---

## 6. Registry & Lazy Loading

```js
// core/registry.js
export const registry = {
  clock:     { type: 'widget', load: () => import('/widgets/clock/clock-widget.js') },
  weather:   { type: 'widget', load: () => import('/widgets/weather/weather-widget.js') },
  todo:      { type: 'app',    load: () => import('/apps/todo/todo-app.js') },
  bookmarks: { type: 'app',    load: () => import('/apps/bookmarks/bookmarks-app.js') },
};
```

`grid.js` walks the enabled-module list from config, dynamically imports each one, and only then instantiates the custom element. This gives free code-splitting via native HTTP/2 multiplexing — no bundler required — and means a broken module fails in isolation (caught per-import) without blocking the rest of the shell.

---

## 7. Rendering & Performance Strategy

- **Critical CSS inlined** in `index.html`'s `<head>` — shell layout, type scale, and skeleton states. No external stylesheet round-trip blocks first paint.
- **Skeleton first.** Grid cells render immediately from cached layout (localStorage), sized and positioned correctly, before any module JS executes — this avoids layout shift entirely rather than fixing it after the fact.
- **Clock renders synchronously** (no network, trivial cost) — it should be the first thing visible.
- **Todo/bookmarks (apps) hydrate from localStorage** — synchronous read, near-instant.
- **Weather is the only async, network-bound widget** — never blocks paint; see §9.

**Rough budget** (tune once you have a real build to measure against):
- First paint: sub-100ms on warm cache.
- JS parsed before any module mounts: under ~15KB (the grid engine + registry + storage wrapper).
- Each module: independently small; weather is the heaviest due to fetch/cache logic.

---

## 8. State & Persistence

`localStorage`, namespaced to avoid collisions:

```
dashboard:layout            # module positions/sizes if user rearranges
dashboard:app:todo          # todo items
dashboard:app:bookmarks     # bookmark list
dashboard:weather:cache     # { data, fetchedAt } — last-known reading
```

`core/storage.js` wraps `get`/`set`/`remove` with the namespace prefix and JSON parse/stringify, so modules never touch `localStorage` directly.

`config.local.json` (gitignored, `config.example.json` committed as template) holds non-secret-but-personal config: grid density, enabled modules, weather API key, default city. Fetched once at boot via `fetch('/config.local.json')` — works fine under `http://`, no env vars or build-time injection needed.

---

## 9. Hover-to-Expand

Showing the button is pure CSS — no `mouseenter` listener needed:

```css
[data-module] .zoom-button {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

[data-module]:hover .zoom-button {
  opacity: 1;
  pointer-events: auto;
}
```

JS is only needed for the actual expand action, since `startViewTransition` has no CSS-only equivalent:

```js
zoomButton.addEventListener('click', () => {
  if (document.startViewTransition) {
    document.startViewTransition(() => module.classList.add('expanded'));
  } else {
    module.classList.add('expanded'); // plain CSS transition fallback
  }
});
```

`.expanded` switches the module to a fixed, full-viewport position via CSS. `startViewTransition` gives the native morph/zoom feel in Chromium and recent Safari; browsers without support (older Firefox) just snap — acceptable degradation, not worth a JS animation library for.

---

## 10. Weather Widget — Network Handling & Icons

Since this may run on protected/air-gapped networks, weather must fail quietly:

1. On mount, render last-known cached reading from `dashboard:weather:cache` immediately (stale-while-revalidate).
2. Fetch in the background with a short timeout (~3s).
3. On success: update cache + DOM.
4. On failure/timeout: leave the stale reading visible, optionally with a subtle "as of [time]" note — never a blocking spinner, never an error state that competes visually with the rest of the dashboard.
5. API endpoint + key read from `config.local.json`, not hardcoded, so the provider is swappable.

**Icons:** condition icons use [Weather Icons](https://erikflowers.github.io/weather-icons/) (Erik Flowers, font SIL OFL 1.1, CSS MIT) — decided over text-only because pictograms are recognized faster than reading a condition word, and that recognition speed matters for a glanceable dashboard. This doesn't reopen the textual-first decision elsewhere: **icons for data, text for interface** — the zoom button and any future controls stay plain text; only the weather condition glyphs use icons.

- **Self-hosted, not CDN.** Font files live in `/weather-icons/font/` (woff2 + woff only — eot/ttf/svg dropped, not needed for this project's browser targets). Consistent with the protected-network requirement: nothing here depends on reaching an external CDN at runtime.
- **Trimmed CSS.** The upstream stylesheet defines ~222 icon classes; `weather-icons-subset.css` hand-trims that down to the ~13 this app actually uses (clear/cloudy × day/night, overcast, fog, rain, showers, thunderstorm, snow, windy, sunrise, sunset markers). Same font file — this only shrinks the CSS payload, not the font itself. Font subsetting (via `fonttools`/`pyftsubset`) is a possible follow-up if the 44KB woff2 needs to shrink further, but wasn't necessary for v1.
- **Loaded lazily, scoped to weather.** The `@font-face` and icon CSS live in the weather widget's own stylesheet, not the global critical CSS — matches the existing per-widget lazy-loading pattern (§6) and doesn't touch the shell's first-paint budget (§7). `font-display: swap` avoids blocking text render while the font loads.
- **Day/night variants.** The widget picks day vs. night icon classes (e.g. `wi-day-cloudy` vs. `wi-night-alt-cloudy`) by comparing the forecast hour against sunrise/sunset from the same API response — no extra request needed.
- **Condition → icon mapping** is a small lookup table in `weather-widget.js`; Weather Icons ships companion CSS mappings for several popular weather APIs (OpenWeatherMap, WMO, etc.) which may cover this directly depending on which provider ends up configured.
- **License note:** `LICENSE.txt` ships alongside the vendored files, crediting Erik Flowers and original icon artist Lukas Bischoff, per the OFL/MIT terms.

---

## 11. Visual System — Light/Dark Theme

Tokens live in `core/theme.css` (design draft finalized — see file). Summary:

- **Palette:** warm off-white / warm near-black bg-text pairs for light and dark, not stark white/pure black. One accent (`#BF4E30` light, `#D6633F` dark) reserved strictly for live/status indication — clock ticking, data freshness, due-today — never decoration. Both muted-text pairs verified at WCAG AA (4.77:1 light, 6.07:1 dark).
- **Type:** system sans stack for body/labels (zero network cost, no font file to fetch). Monospace with `font-variant-numeric: tabular-nums` for the clock and any ticking value, so digit changes don't shift layout.
- **Signature element:** a single 5px accent dot (`.live-dot`) — the one deliberate splash of color, used nowhere else. Consistent with "spend your boldness in one place" — everything around it stays quiet.
- **Zoom button is plain text**, no icon — matches the textual-first, interface-stays-textual direction. Weather condition glyphs are the one exception — see §10 for the icons-for-data-not-interface rationale.

**Switching mechanism:** `prefers-color-scheme` only, decided for v1 — no manual toggle, no `data-theme` attribute, no `localStorage` read for theme. The OS setting is the single source of truth, which also means no anti-flash script is needed in `<head>` (there's nothing to flash — the media query resolves before first paint regardless). Simpler for now; a manual override can be layered on later without disturbing these tokens if it turns out to be wanted.

---

## 12. Server Start — Manual

Decided: no launchd agent, no auto-start. The static server is started manually per session.

- Document a single copy-pasteable command in `README.md`: `ruby serve.rb 8000`. No wrapper script required unless you want a fish abbreviation later for convenience.
- Practical implication: the browser homepage will only load correctly if the server happens to be running. Worth a one-line note in the README (and maybe a friendly "server not running" fallback message baked into `index.html` via a fetch-self health check, or just accepted as a known rough edge for v1) — your call whether that's worth the complexity now or later.

---

## 13. Adding a New App or Widget (checklist)

1. Decide the type: **app** (functional — real state, persistence, or interaction) or **widget** (display-first, minimal/no interaction).
2. Create `/apps/<id>/<id>-app.js` or `/widgets/<id>/<id>-widget.js`, define the custom element + `static manifest` (including `type`).
3. Register it in `core/registry.js` with its `type` and `load` path.
4. Add `<id>` to the enabled-modules list in `config.local.json` (and `config.example.json`).
5. If it persists state, add a namespaced key via `core/storage.js` — don't touch `localStorage` directly.
6. If it's network-bound, follow the stale-while-revalidate pattern from §10 — no module should block paint.
