/**
 * Module Registry & Resilient Loader
 * Maps module IDs to dynamic loaders and isolates module load errors.
 */
export const registry = {
  clock:     { type: 'widget', load: () => import('../widgets/clock/clock-widget.js') },
  weather:   { type: 'widget', load: () => import('../widgets/weather/weather-widget.js') },
  bookmarks: { type: 'app',    load: () => import('../apps/bookmarks/bookmarks-app.js') },
  todo:      { type: 'app',    load: () => import('../apps/todo/todo-app.js') },
};

export function registerModule(id, definition) {
  registry[id] = definition;
}

export async function loadModule(id) {
  const modDef = registry[id];
  if (!modDef) {
    return {
      success: false,
      id,
      error: new Error(`Module "${id}" not found in registry.`)
    };
  }

  try {
    const exports = await modDef.load();
    return {
      success: true,
      id,
      type: modDef.type,
      exports
    };
  } catch (err) {
    console.error(`[registry] Failed to load module "${id}":`, err);
    return {
      success: false,
      id,
      type: modDef.type,
      error: err
    };
  }
}
