/**
 * Module Registry & Resilient Loader
 * Maps module IDs to dynamic loaders and isolates module load errors.
 */
export const registry = {
  clock:     { type: 'app',    name: 'Clock',     load: () => import('../apps/clock/clock-app.js') },
  weather:   { type: 'widget', name: 'Weather',   load: () => import('../widgets/weather/weather-widget.js') },
  bookmarks: { type: 'app',    name: 'Bookmarks', load: () => import('../apps/bookmarks/bookmarks-app.js') },
  todo:      { type: 'app',    name: 'Todo',      load: () => import('../apps/todo/todo-app.js') },
  notes: { type: 'app', name: 'Notes', load: () => import('../apps/notes/notes-app.js') },
};

/** Display name for a module id. */
export function moduleName(id) {
  return (registry[id] && registry[id].name) || id;
}

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
