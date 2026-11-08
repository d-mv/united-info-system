/**
 * Theme (auto / light / dark) and accent colour, kept in config.appearance and
 * applied as data-theme / data-accent on <html>. index.html applies the saved
 * values before first paint; this keeps them in sync afterwards (incl. other tabs).
 */
import { configManager as defaultConfigManager } from './config.js';

export const THEMES = ['auto', 'light', 'dark'];
export const ACCENTS = ['red', 'orange', 'green', 'blue', 'graphite'];

export function resolveAppearance(appearance) {
  const a = appearance || {};
  return {
    theme: THEMES.includes(a.theme) ? a.theme : 'auto',
    accent: ACCENTS.includes(a.accent) ? a.accent : 'red',
  };
}

export function applyAppearance(appearance, root = document.documentElement) {
  const { theme, accent } = resolveAppearance(appearance);
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (accent === 'red') delete root.dataset.accent;
  else root.dataset.accent = accent;
}

export function setupAppearance(configManager = defaultConfigManager) {
  applyAppearance(configManager.get().appearance);
  return configManager.subscribe((config) => applyAppearance(config && config.appearance));
}
