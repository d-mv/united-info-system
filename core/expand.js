/**
 * Accessible Modal Expansion & Focus Management Controller
 * Handles hover-to-expand UI, view transitions, scroll locking, and Escape key dismissal.
 */
export function setupExpandController() {
  if (typeof document === 'undefined') return;

  document.addEventListener('click', (e) => {
    const zoomBtn = e.target.closest ? e.target.closest('.zoom-button') : null;
    if (!zoomBtn) return;

    const moduleEl = zoomBtn.closest('.module');
    if (!moduleEl) return;

    const toggle = () => {
      const isExpanded = moduleEl.classList.contains('expanded');
      if (isExpanded) {
        moduleEl.classList.remove('expanded');
        document.body.classList.remove('modal-open');
        const label = zoomBtn.getAttribute('aria-label');
        if (label) zoomBtn.setAttribute('aria-label', label.replace('Collapse', 'Expand'));
      } else {
        moduleEl.classList.add('expanded');
        document.body.classList.add('modal-open');
        const label = zoomBtn.getAttribute('aria-label');
        if (label) zoomBtn.setAttribute('aria-label', label.replace('Expand', 'Collapse'));
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
        const collapse = () => {
          expandedMod.classList.remove('expanded');
          document.body.classList.remove('modal-open');
          const zoomBtn = expandedMod.querySelector('.zoom-button');
          if (zoomBtn) {
            const label = zoomBtn.getAttribute('aria-label');
            if (label) zoomBtn.setAttribute('aria-label', label.replace('Collapse', 'Expand'));
          }
        };

        if (document.startViewTransition) {
          document.startViewTransition(collapse);
        } else {
          collapse();
        }
      }
    }
  });
}
