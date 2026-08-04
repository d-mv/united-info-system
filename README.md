# United InfoSystem (UIS)

> A modular, fast-booting, zero-dependency local browser dashboard built with native Web Components, CSS Grid, and zero build tools.

---

## Features

- ⚡ **Cold-Open Fast**: Sub-100ms first paint with critical inlined CSS and no build step.
- 🧱 **Web Components**: Modular Custom Elements for Apps (`<app-todo>`, `<app-bookmarks>`) and Widgets (`<widget-clock>`, `<widget-weather>`).
- ⚡ **Self-Generating Config**: Auto-initializes `localStorage` config (`dashboard:config`) without external HTTP fetch requirements.
- 🔄 **Cross-Tab Reactivity**: Built-in `storage` event listeners for real-time synchronization across open browser tabs.
- 🔑 **Secrets Setup Dialog**: Inline setup dialog for modules requiring API keys (e.g. OpenWeatherMap API key).
- 🔍 **Accessible Modal Expansion**: Hover-to-expand UI with native `document.startViewTransition` support, focus handling, and `Escape` key dismissal.

---

## Quick Start

### 1. Run the Local Server

No `npm install`, no `package.json`, no gems needed. Requires Ruby (built into macOS / Linux stdlib):

```bash
ruby serve.rb
```

The server starts at `http://localhost:8000`. You can optionally pass a custom port or root path:

```bash
ruby serve.rb 3000
```

### 2. Open in Browser

Navigate to [http://localhost:8000](http://localhost:8000) or set it as your browser homepage / new tab page.

---

## Architecture & Data Storage

All data is stored in your browser's `localStorage` under namespaced keys:

- `dashboard:config`: Grid dimensions, enabled modules, and secret settings.
- `dashboard:app:todo`: List of task items and completion states.
- `dashboard:app:bookmarks`: Saved links and domains.
- `dashboard:weather:cache`: Stale-while-revalidate cached weather reading.

---

## Testing

Run the Node test suite:

```bash
node --test tests/*.test.js
```
