# United InfoSystem (UIS)

> A fast, local browser start page built from native Web Components and CSS Grid. No build step, no dependencies.

---

## Modules

- **Clock** (`<widget-clock>`): current time, a daily alarm and a countdown timer with presets. Both survive reloads and stay in sync across tabs. The Alarm row shows time left until it rings. When one goes off, the clock shows a Dismiss banner, beeps for up to a minute and sends a browser notification. Sound needs one click on the page first (browser autoplay rules); notification permission is asked the first time you set an alarm or start a timer.
- **Weather** (`<widget-weather>`): current conditions and forecast from Open-Meteo (default, free, no API key) or OpenWeatherMap (needs an API key). The setup dialog picks provider, city and key. The last reading is cached and shown immediately on load, and refreshed once it is 15 minutes old (also while the page stays open); if a refresh fails, it stays visible marked "Update failed". Failures say why (city not found, API key rejected, unavailable).
- **Todo** (`<app-todo>`): add and complete tasks (there is no delete yet). Mark any number of tasks as in progress. Completed tasks are hidden by default; the "Completed · N" row at the bottom shows or hides them.
- **Bookmarks** (`<app-bookmarks>`): add, edit and delete links.

## Shell

- **Fast cold open**: critical CSS is inlined, modules load lazily and render into pre-sized skeleton cells. A module that fails to load shows an error in its own cell without breaking the rest.
- **Config without setup**: on first open the default config (`dashboard:config`) is written to `localStorage`. Nothing is fetched to boot.
- **Cross-tab sync**: changes in one tab show up in other open tabs via the `storage` event.
- **Expand**: each module has a zoom button (shown on hover or focus, always on touch screens) that expands it to full page, using `document.startViewTransition` where supported. Only one module is expanded at a time; the rest of the page is inert while it is, and `Escape` collapses it and returns focus to the button.
- **Theme**: light and dark follow the OS setting (`prefers-color-scheme`). Fonts are self-hosted, so the only network calls are weather requests.

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

The server listens on `127.0.0.1` only.

### 2. Open in the browser

Go to [http://localhost:8000](http://localhost:8000), or set it as your homepage / new tab page. The server isn't started automatically, so the page only loads while `start.sh` is running.

---

## Data Storage

Everything lives in the browser's `localStorage` under `dashboard:` keys:

| Key | Contents |
|---|---|
| `dashboard:config` | Config version, grid settings, enabled modules and their placement, weather settings (provider, city, units, API key). |
| `dashboard:clock` | Daily alarm (time, on/off, last day it rang), countdown timer (end time while running, remaining time while paused) and the current ringing state. |
| `dashboard:weather:cache` | Last weather reading and the provider, city and units it was fetched for (shown only while those match the settings). |
| `dashboard:app:todo` | Tasks with done and in-progress flags. |
| `dashboard:app:todo:view` | Todo view preference (`showCompleted`). |
| `dashboard:app:bookmarks` | Saved links. |

When the default module layout changes, `CONFIG_VERSION` in `core/config.js` is bumped; older saved configs get the new layout but keep enabled flags, grid settings and weather settings (v3 resets grid settings from older versions, which were never applied).

---

## Known Limitations

- The grid is not responsive on narrow screens.
- Units (metric/imperial) can only be changed by editing `dashboard:config`; the setup dialog has no units selector.

---

## Testing

```bash
node --test tests/*.test.js
```

Tests run in Node against a mock DOM, so they don't catch every browser-only bug.

---

## Docs

- [`docs/dashboard-architecture.md`](docs/dashboard-architecture.md): architecture and design decisions.
- [`docs/index.html`](docs/index.html): visual reference for the design system.
- [`docs/v3/updates-app-design.md`](docs/v3/updates-app-design.md): draft design for a planned Updates (feeds) app.
- `docs/v2/`: earlier version of the architecture doc and preview, kept for reference.
