# United InfoSystem (UIS)

> A modular, fast-booting, zero-dependency local browser dashboard built with native Web Components, CSS Grid, and zero build tools.

---

## Features

- ⚡ **Cold-Open Fast**: Sub-100ms first paint with critical inlined CSS and no build step.
- 🧱 **Web Components**: Modular Custom Elements for Apps (`<app-todo>`, `<app-bookmarks>`) and Widgets (`<widget-clock>`, `<widget-weather>`).
- 🌤️ **Dual Weather Providers**: Built-in support for zero-config Open-Meteo (free, no API key required) as well as OpenWeatherMap with API key.
- ⚡ **Self-Generating Config**: Auto-initializes `localStorage` config (`dashboard:config`) on a responsive 12-column grid layout without external HTTP fetch requirements.
- 🔄 **Cross-Tab Reactivity**: Built-in `storage` event listeners for real-time synchronization across open browser tabs.
- 🔑 **Secrets Setup Dialog**: Inline setup dialog for modules requiring secrets/provider selection (e.g. Weather provider choice, city, unit system, and API key).
- ⏰ **Alarm & Countdown Timer**: The clock has a daily alarm and a countdown timer with presets. Both survive reloads and stay in sync across tabs; the Alarm row shows time left until it rings. When one goes off the clock shows a Dismiss banner, beeps for up to a minute (sound needs one click on the page first, per browser autoplay rules) and sends a browser notification (permission is asked when you first set an alarm or start a timer).
- 🔍 **Accessible Modal Expansion**: Hover-to-expand UI with native `document.startViewTransition` support, SVG zoom iconography, focus handling, and `Escape` key dismissal.

---

## Quick Start

### 1. Run the Local Server

No `npm install`, no `package.json`, no gems needed. Requires Ruby (built into macOS / Linux stdlib). Execute `./start.sh` directly:

```bash
./start.sh
```

Alternatively, run via Ruby:

```bash
ruby start.sh 8000
```

The server starts at `http://localhost:8000`. You can optionally pass a custom port or root path:

```bash
./start.sh 3000
```

### 2. Open in Browser

Navigate to [http://localhost:8000](http://localhost:8000) or set it as your browser homepage / new tab page.

---

## Architecture & Data Storage

All data is stored in your browser's `localStorage` under namespaced keys:

- `dashboard:config`: Grid dimensions (12-column), enabled modules, and secret settings.
- `dashboard:app:todo`: List of task items and completion states.
- `dashboard:app:bookmarks`: Saved links, domains, inline editing state.
- `dashboard:clock`: Daily alarm (time, on/off, last day it rang), countdown timer (running end time or paused remainder) and the current ringing state.
- `dashboard:weather:cache`: Stale-while-revalidate cached weather reading (Open-Meteo or OpenWeatherMap).

---

## Testing

Run the Node test suite:

```bash
node --test tests/*.test.js
```
