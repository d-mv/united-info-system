/**
 * Page switching for this tab, mirrored in the URL (#page=<id>) so a tab
 * keeps its page on reload and a page can be bookmarked.
 */
import { configManager as defaultConfigManager } from './config.js';

export function pageFromHash(hash) {
  const m = /^#page=([\w-]+)$/.exec(hash || '');
  return m ? m[1] : null;
}

export function goToPage(id, configManager = defaultConfigManager) {
  if (!configManager.switchPage(id)) return false;
  if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', `#page=${id}`);
  return true;
}

/** Call before the grid renders: the URL's page (if valid) becomes this tab's page. */
export function setupPages(configManager = defaultConfigManager) {
  const fromUrl = pageFromHash(location.hash);
  if (fromUrl && configManager.getPages().some(p => p.id === fromUrl)) configManager.pageId = fromUrl;
  window.addEventListener('hashchange', () => {
    const id = pageFromHash(location.hash);
    if (id && id !== configManager.currentPageId()) configManager.switchPage(id);
  });
}
