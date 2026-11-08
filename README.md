# United InfoSystem (UIS)

> A fast, local browser start page built from native Web Components and CSS Grid. No build step, no dependencies.

---

## Modules

- **Clock** (`<app-clock>`): current time, any number of alarms (each daily or on chosen weekdays, switchable on/off), a countdown timer with presets and a Pomodoro mode (4 × 25 min focus with 5 min breaks, then a 15 min break; each phase starts the next and rings in between; Skip and Stop in the Timer dialog). An optional second time zone shows in the header (`+ Zone`). Everything survives reloads and stays in sync across tabs. The Alarm row shows the next alarm and time left until it rings. When one goes off, the clock shows a Dismiss banner, beeps for up to a minute and sends a browser notification. Sound needs one click on the page first (browser autoplay rules); notification permission is asked the first time you set an alarm or start a timer.
- **Weather** (`<widget-weather>`): current conditions and forecast from Open-Meteo (default, free, no API key) or OpenWeatherMap (needs an API key). The setup dialog picks provider, city, units and key. The last reading is cached and shown immediately on load, and refreshed once it is 15 minutes old (also while the page stays open); if a refresh fails, it stays visible marked "Update failed". When the hourly forecast shows a 60%+ chance of rain (or snow) within the next three hours, a "Rain likely ~HH:00" line appears, plus one browser notification per rain event if notifications are already allowed. Expanded, it shows current details, the next hours and a 7-day forecast. Failures say why (city not found, API key rejected, unavailable).
- **Todo** (`<app-todo>`): add, edit, delete and complete tasks, with an optional due date (overdue dates show in the accent color). Reorder by dragging a row, or focus its grip (⋮⋮) and press ↑/↓. Mark any number of tasks as in progress. Completed tasks are hidden by default; the "Completed · N" row at the bottom shows or hides them.
- **Bookmarks** (`<app-bookmarks>`): add, edit and delete links, optionally in named groups (ungrouped links come first). Each link shows the site's `/favicon.ico` (a letter when there is none). Keys `1`–`9` open the first nine links in a new tab (not while typing or when a dialog is open). **Import** reads a bookmarks HTML file exported from Chrome, Firefox or Safari; folders become groups and links already saved are skipped.

## Shell

- **Fast cold open**: critical CSS is inlined, modules load lazily and render into pre-sized skeleton cells. A module that fails to load shows an error in its own cell without breaking the rest.
- **Config without setup**: on first open the default config (`dashboard:config`) is written to `localStorage`. Nothing is fetched to boot.
- **Cross-tab sync**: changes in one tab show up in other open tabs via the `storage` event.
- **Expand**: each module has a zoom button (shown on hover or focus, always on touch screens) that expands it to full page, using `document.startViewTransition` where supported. Only one module is expanded at a time; the rest of the page is inert while it is, and `Escape` collapses it and returns focus to the button.
- **Shell bar**: a slim bar above the grid. **Settings → Data** exports everything as one JSON backup file (`uis-backup-YYYY-MM-DD.json`; it includes API keys and tokens, so keep it private) and imports one back. Importing shows what the file holds and asks before it replaces all UIS data, then reloads the page.
- **Command palette**: `⌘K` / `Ctrl+K` anywhere, `/` when not typing, or the `⌘K` button in the bar. Type to find a bookmark, mark a task done, add a task (`Add task: …`), start a timer (`10`, `10m`, `timer 25`), start Pomodoro, open Alarms, dismiss a ring, expand/collapse a module, open Settings, export a backup, or search the web (DuckDuckGo). Each module adds its own commands while it is on the page (`core/commands.js`).
- **Layout editor**: **Edit layout** in the bar (or the palette) puts an overlay on each module: drag to move, drag the corner to resize, or focus one and use arrow keys (Shift+arrows resize); **Hide** removes it from the page. Moves that leave the grid or overlap another module are refused. **Settings → Modules** turns modules on and off. Wide windows only (below 900px the grid stacks).
- **Pages**: several dashboards (e.g. Home, Work), each with its own modules and layout; tasks, bookmarks and other data are shared. Add, rename and delete them in **Settings → Pages**; tabs show in the bar once there are two or more, and the palette has `Go to page: …` / `New page`. A new page starts empty. Each browser tab keeps its own page (`#page=<id>` in the address, so pages can be bookmarked); new tabs open the page used last.
- **Theme**: Auto (follows the OS), Light or Dark, plus an accent colour (red, orange, green, blue, graphite) in **Settings → Appearance**; also `Theme: …` in the palette. Colours are `light-dark()` tokens driven by `color-scheme`, and an inline script applies the saved choice before first paint. Fonts are self-hosted, so the only network calls are weather requests and bookmark favicons.

---

## Quick Start

### 1. Run the local server

No `npm install`, no `package.json`, no gems. Needs Ruby (preinstalled on macOS; stdlib only).

```bash
./start.sh            # serves this folder on http://localhost:8000
./start.sh 3000       # custom port
./start.sh 3000 ./www # custom port and root
ruby start.sh 8000    # if the file isn't executable
```

The server listens on `127.0.0.1` only, answers only requests addressed to `localhost` / `127.0.0.1` / `[::1]` (blocks DNS-rebinding pages), and never serves dotfiles such as `.git`.

### 2. Open in the browser

Go to [http://localhost:8000](http://localhost:8000), or set it as your homepage / new tab page. The server isn't started automatically, so the page only loads while `start.sh` is running.

---

## Data Storage

Everything lives in the browser's `localStorage` under `dashboard:` keys:

| Key | Contents |
|---|---|
| `dashboard:config` | Config version, grid settings, pages (each with its enabled modules and their placement) and the last used page, appearance (theme, accent), weather settings (provider, city, units, API key). |
| `dashboard:clock` | Alarms (time, weekdays, on/off, last day each rang), countdown timer (end time while running, remaining time while paused), Pomodoro phase, second time zone and the current ringing state. An older single `alarm` is carried over into the list if it was on. |
| `dashboard:weather:rain-alert` | Last rain event a notification was sent for (so it isn't repeated). |
| `dashboard:weather:cache` | Last weather reading and the provider, city and units it was fetched for (shown only while those match the settings). |
| `dashboard:app:todo` | Tasks in display order, with done and in-progress flags and an optional `due` date (`YYYY-MM-DD`). |
| `dashboard:app:todo:view` | Todo view preference (`showCompleted`). |
| `dashboard:app:bookmarks` | Saved links (`title`, `url`, optional `group`). |

Since config v4 the layout is yours (v5 moved it into pages; an older layout becomes the "Home" page): saved module placement is kept across updates. A module added to UIS later is appended to your layout automatically (below everything else), and modules that no longer exist are dropped (`normalizeModules` in `core/layout.js`). Configs older than v3 get the default layout but keep enabled flags, and their grid settings reset (they were never applied).

---

## Testing

```bash
node --test tests/*.test.js
```

Tests run in Node against a mock DOM, so they don't catch every browser-only bug. For that there is a real-browser smoke run (layout, CSS variables, expand/focus, server hardening):

```bash
# one-time: Playwright lives outside the repo (no package.json here)
npm install --prefix ~/.cache/uis-playwright playwright-core@1.64.1
npx --prefix ~/.cache/uis-playwright playwright-core install chromium

node tests/browser/smoke.mjs   # starts start.sh on port 8790, exits non-zero on failure
```

---

## Docs

- [`docs/dashboard-architecture.md`](docs/dashboard-architecture.md): architecture and design decisions.
- [`docs/index.html`](docs/index.html): visual reference for the design system.
- [`docs/v3/updates-app-design.md`](docs/v3/updates-app-design.md): draft design for a planned Updates (feeds) app.
- `docs/v2/`: earlier version of the architecture doc and preview, kept for reference.
