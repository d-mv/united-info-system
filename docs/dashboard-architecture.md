# United InfoSystem (UIS) — Architecture Design

**Status:** v1.0 (active)
**Constraints locked in:** no build step, no `package.json`, no framework runtime, served locally via a static file server (not `file://`, not a hosted page, not a browser extension).

---

## 1. Goals

- **Cold-open fast.** This replaces the browser homepage — every millisecond before first paint is felt on every new tab.
- **Cloneable and runnable with zero setup** beyond a static server command.
- **Modular.** Apps and widgets are independent modules that can be added, removed, or broken without affecting the rest of the shell.
- **Textual-first.** Minimal graphics, no borders between modules, seamless grid — visual weight comes from typography and spacing, not chrome.
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
  registry.js               # module id -> { type, load } map
  storage.js                # thin localStorage wrapper, namespaced keys, change subscriptions
  config.js                 # initializes/migrates the auto-generated config in localStorage
  expand.js                 # zoom-to-full-page toggle + Escape
  html.js                   # escapeHtml / safeHref for values interpolated into markup
  theme.css                 # design tokens + shared primitives (§11)
/apps/
  todo/todo-app.js          # defines <app-todo>
  bookmarks/bookmarks-app.js # defines <app-bookmarks>
/widgets/
  clock/
    clock-widget.js         # defines <widget-clock>
    clock-logic.js          # pure alarm/timer rules (no DOM)
    clock-notify.js         # Notification API wrapper
  weather/
    weather-widget.js       # defines <widget-weather>
    font/                   # Weather Icons webfont (LICENSE.txt alongside)
/fonts/                     # self-hosted Space Grotesk + IBM Plex Mono (OFL)
/assets/                    # SVG icons used as CSS masks
/tests/                     # node --test suites (mock DOM)
/docs/                      # this doc, visual reference, drafts for future modules
/start.sh                   # zero-dependency Ruby static server executable
/README.md                  # clone + run instructions
```

No `src/`, no `dist/`. What's on disk is what runs.

---

## 3. Runtime Model

- Served via `./start.sh` (or `ruby start.sh [port] [root]`) — a ~100-line, zero-dependency Ruby script (stdlib `socket` only, no gems, no `npx`/Node, no Python) that serves static files with correct MIME types and blocks path traversal.
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

The snippet above shows the shape; the real modules render with `innerHTML` templates and an inline `<style>` block each.

**Manifest fields** (each module declares a `static manifest`, but `grid.js` doesn't read it yet — placement comes from `dashboard:config`; see §5):

| field | meaning |
|---|---|
| `id` | unique module id, also the registry key |
| `type` | `'app'` or `'widget'` |
| `cols` / `rows` | span in grid units |
| `defaultCol` / `defaultRow` | 1-indexed default placement |
| `expandable` | whether the hover-zoom-to-fullpage affordance applies |

Default placements in the 12-column layout (`DEFAULT_CONFIG.modules` in `core/config.js`):
- `clock`: `2×2` (`col: 1, row: 1`)
- `weather`: `2×2` (`col: 1, row: 3`)
- `bookmarks`: `4×4` (`col: 3, row: 1`)
- `todo`: `6×4` (`col: 7, row: 1`)

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

`core/grid.js` reads the enabled modules from `dashboard:config`, renders a skeleton cell per module with `grid-column` / `grid-row` set inline, then swaps in the real element once its module has loaded. It re-renders the shell only when the layout part of the config (`grid` and `modules`) changes. Widget settings live in the same key (`secrets`), so widgets that have settings subscribe to the config themselves (the weather widget refetches when its provider, city or key changes).

`grid.js` sets `--grid-cols`, `--cell-size` and `--module-padding` on `#shell` from `config.grid` with `style.setProperty()` (defaults: 12 columns, 100px cells, 16px padding, matching `core/theme.css`). Config v3 resets grid values saved by older versions, which were never applied. **Current gap:** the grid is not responsive on narrow screens yet.

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
dashboard:config            # auto-generated config: version, grid, modules (enabled + placement), secrets
dashboard:clock             # alarm, countdown timer, ringing state
dashboard:weather:cache     # { query, reading }: last-known reading and the settings it was fetched for
dashboard:app:todo          # todo items: { id, text, done, active }
dashboard:app:todo:view     # { showCompleted }
dashboard:app:bookmarks     # bookmark list
```

`core/storage.js` wraps `get`/`set`/`remove` with the namespace prefix and JSON parse/stringify, so modules never touch `localStorage` directly. `subscribe(key, cb)` fires on same-tab writes and on `storage` events from other tabs; modules subscribe to their key and re-render, which is how cross-tab sync works.

**Config Strategy:**
No external `config.local.json` is fetched over HTTP. When the app boots, `core/config.js` checks `dashboard:config` in `localStorage`. If missing (e.g. first cold-open), `core/config.js` generates the default configuration, persists it to `localStorage`, and returns it synchronously. This guarantees zero network latency during startup, eliminates 404 setup errors, and establishes a single portable data structure ready for future sync integration.

Layout isn't user-editable yet. When `DEFAULT_CONFIG.modules` changes, bump `CONFIG_VERSION`; `_migrate()` then resets saved configs to the new layout while keeping enabled flags, grid settings and secrets.

---

## 9. Hover-to-Expand

Showing the button is pure CSS — no `mouseenter` listener needed. Header actions (`.block-header__actions`, which hold the zoom button) are hidden until the module is hovered, has focus inside it, or is expanded; on touch screens (`@media (hover: none)`) they're always visible.

JS in `core/expand.js` (`setupExpandController()`) delegates document click and keydown events for modal toggling:

```js
// core/expand.js
export function setupExpandController() {
  document.addEventListener('click', (e) => {
    const zoomBtn = e.target.closest('.zoom-button');
    if (!zoomBtn) return;
    const moduleEl = zoomBtn.closest('.module');
    if (!moduleEl) return;

    const toggle = () => {
      const isExpanded = moduleEl.classList.contains('expanded');
      if (isExpanded) {
        moduleEl.classList.remove('expanded');
        document.body.classList.remove('modal-open');
        zoomBtn.setAttribute('aria-label', zoomBtn.getAttribute('aria-label')?.replace('Collapse', 'Expand'));
      } else {
        moduleEl.classList.add('expanded');
        document.body.classList.add('modal-open');
        zoomBtn.setAttribute('aria-label', zoomBtn.getAttribute('aria-label')?.replace('Expand', 'Collapse'));
      }
    };

    if (document.startViewTransition) {
      document.startViewTransition(toggle);
    } else {
      toggle();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const expandedMod = document.querySelector('.module.expanded');
      if (expandedMod) {
        // collapses expanded modal and updates body/aria state
      }
    }
  });
}
```

Escape does nothing while a `<dialog>` is open, so closing a dialog doesn't also collapse the module behind it.

`.expanded` switches the module to a fixed, full-viewport position via CSS; `body.modal-open` locks page scroll and adds a scrim. Focus is not moved into the expanded module or returned afterwards, and the button has no `aria-expanded` yet (tracked as debt). `startViewTransition` gives the native morph/zoom feel in Chromium and recent Safari; browsers without support (older Firefox) just snap — acceptable degradation, not worth a JS animation library for.

---

## 10. Weather Widget — Multi-Provider Network Handling

Since this may run on protected/air-gapped networks, weather must fail quietly:

1. **Provider Selection:** Supports `openmeteo` (default; free, no API key required) and `openweathermap` (requires API key).
2. **Open-Meteo Flow:** Resolves city name to coordinates via Geocoding API (`geocoding-api.open-meteo.com/v1/search`), then queries forecast (`api.open-meteo.com/v1/forecast`) and maps WMO codes to human-readable weather conditions via `mapWmoCodeToCondition`.
3. On mount, render the last-known reading from `dashboard:weather:cache` immediately (stale-while-revalidate). The cache is stored as `{ query: {provider, city, units}, reading }` and is shown only when its query matches the current settings (city compared case-insensitively); otherwise the widget shows Loading until the new fetch lands. `resolveWeatherQuery()` applies every settings default in one place (city default comes from `DEFAULT_CONFIG`).
4. Fetch in the background only when the reading is older than 15 minutes (or there is none), with a ~3s `AbortController` timeout per request. While the page is open, a once-a-minute check refetches stale readings; after a failure it waits 15 minutes before trying again.
5. On success: update cache + DOM.
6. On failure/timeout: leave the stale reading visible with its "As of [time]" note plus "Update failed" — never a blocking spinner. With no cache at all, say why: "City not found" or "API key rejected" (with Open setup), otherwise "Weather unavailable" (with Retry). OpenWeatherMap without a key shows a prompt to open setup. Adapters return tagged results (`{ _tag: 'Ok', value }` / `{ _tag: 'Err', error: { reason } }`), and only the latest request (a sequence number) may write the cache and status, so a slow older fetch can't overwrite newer settings.
7. Secrets & preferences (provider, city, units, apiKey) are persisted in `dashboard:config` via `ConfigManager`. The setup dialog edits provider, city and API key; units come from config (default `metric`) and have no selector yet.


---

## 10a. Clock Widget — Alarm & Timer

- `clock-logic.js` holds the rules as pure functions, tested without a DOM. The alarm is a daily `HH:MM`; it counts as due within a 5-minute grace window (background tabs throttle timers) and records `lastFiredDate` so it rings once per day. Setting a time that already passed today arms it for tomorrow. The timer stores an absolute `endsAt` while running and the remaining time while paused, so reloads don't drift.
- State lives in `dashboard:clock`, so every open tab ticks the same alarm/timer; dismissing in one tab dismisses in all.
- Ringing shows a Dismiss banner and beeps via Web Audio for up to a minute. Browsers only allow sound after a user gesture, so the `AudioContext` is unlocked by clicks inside the widget.
- `clock-notify.js` sends a system notification (permission is requested on the set-alarm / start-timer gesture). The fixed tag `uis-clock` stops several tabs from stacking duplicates, and the notification is closed on dismiss, including from another tab.

## 10b. Todo App

- Items are `{ id, text, done, active }`. `active` means "in progress"; any number of tasks can be active, and it's cleared when a task is completed.
- Completed tasks are hidden by default. The "Completed · N" footer row toggles `dashboard:app:todo:view.showCompleted`.

## 11. Visual System — Light/Dark Theme

Tokens live in `core/theme.css`. The visual language is **Braun / Dieter Rams**, shared with Kairos, Paciol and drive_read; token names and values match theirs (`--color-canvas`, `--color-ink`, `--color-line`, …). Summary:

- **Surfaces:** three depths only: recessed (input wells, skeletons), canvas (page), raised (module panels, dialogs). Depth is tone plus a 1px hairline (`--color-line`). Never shadows.
- **Geometry:** `--radius: 2px` everywhere, a manufacturing tolerance rather than a style. Never more.
- **Accent:** one signal red (`--color-accent`). It is used for the live dot, destructive hovers and the single primary button per dialog. Nothing else.
- **Type:** Space Grotesk for UI text, IBM Plex Mono for labels and numerals. Both are self-hosted woff2 in `/fonts` (SIL OFL 1.1; licenses alongside), so there are no network calls. Labels are mono, uppercase, letterspaced (`.label`). Numerals are mono with tabular figures (`.num`, `.numeral`), so ticking values don't shift layout.
- **Signature element:** the 6px accent `.live-dot`, which pulses on live data (clock, weather freshness) and goes grey when an update failed.
- **Icons:** `assets/*.svg` are applied as CSS masks (`.icon--zoom`, `.icon--close`) so they take the ink colour in both themes.
- **Dialogs:** native `<dialog>` opened with `showModal()`, which gives focus trapping, Escape handling and a `::backdrop` scrim without custom JS.
- **User text:** module markup is built with template strings, so every user or API value goes through `escapeHtml` / `safeHref` from `core/html.js`.

**Switching mechanism:** `prefers-color-scheme` only, decided for v1 — no manual toggle, no `data-theme` attribute, no `localStorage` read for theme. The OS setting is the single source of truth, which also means no anti-flash script is needed in `<head>` (there's nothing to flash — the media query resolves before first paint regardless). Simpler for now; a manual override can be layered on later without disturbing these tokens if it turns out to be wanted.

---

## 12. Server Start — Manual

Decided: no launchd agent, no auto-start. The static server is started manually per session.

- Document a single copy-pasteable command in `README.md`: `./start.sh`. No wrapper script required unless you want a fish abbreviation later for convenience.
- Practical implication: the browser homepage will only load correctly if the server happens to be running. Worth a one-line note in the README (and maybe a friendly "server not running" fallback message baked into `index.html` via a fetch-self health check, or just accepted as a known rough edge for v1) — your call whether that's worth the complexity now or later.

---

## 13. Adding a New App or Widget (checklist)

1. Decide the type: **app** (functional — real state, persistence, or interaction) or **widget** (display-first, minimal/no interaction).
2. Create `/apps/<id>/<id>-app.js` or `/widgets/<id>/<id>-widget.js`, define the custom element + `static manifest` (including `type`).
3. Register it in `core/registry.js` with its `type` and `load` path.
4. Add `<id>` with its placement to `DEFAULT_CONFIG.modules` in `core/config.js` and bump `CONFIG_VERSION` so existing saved configs pick it up.
5. If it persists state, add a namespaced key via `core/storage.js` — don't touch `localStorage` directly.
6. If it's network-bound, follow the stale-while-revalidate pattern from §10 — no module should block paint.
7. Escape every user or API value interpolated into markup with `core/html.js`.
8. Add a `tests/<id>.test.js` suite (`node --test`).
