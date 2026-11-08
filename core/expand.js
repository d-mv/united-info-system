/**
 * Module expansion: one module at a time fills the page.
 *
 * The DOM is the only state: at most one `.module.expanded`. While a module is
 * expanded, `body.modal-open` shows the scrim and every other module is `inert`,
 * so neither the mouse nor the keyboard can reach (or expand) them.
 *
 * Toggles are buttons with `data-expand` and `aria-expanded`. Other buttons may
 * share the `.zoom-button` look (dialog Close) without toggling anything.
 */
const TOGGLE = '[data-expand]';

function setToggleState(btn, expanded) {
  if (!btn) return;
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  const label = btn.getAttribute('aria-label');
  if (label) {
    btn.setAttribute('aria-label', expanded ? label.replace('Expand', 'Collapse') : label.replace('Collapse', 'Expand'));
  }
}

/** Expand `target` (a `.module`), or collapse everything with `null`. */
export function setExpanded(target) {
  const current = document.querySelector('.module.expanded');
  if (current === target) return;

  if (current) {
    current.classList.remove('expanded');
    setToggleState(current.querySelector(TOGGLE), false);
  }
  for (const mod of document.querySelectorAll('.module')) {
    mod.inert = !!target && mod !== target;
  }
  document.body.classList.toggle('modal-open', !!target);

  if (target) {
    target.classList.add('expanded');
    const toggle = target.querySelector(TOGGLE);
    setToggleState(toggle, true);
    // Keep focus inside the expanded module (Safari doesn't focus clicked buttons).
    if (toggle && toggle.focus) toggle.focus();
  } else if (current) {
    const toggle = current.querySelector(TOGGLE);
    if (toggle && toggle.focus) toggle.focus();
  }
}

function withTransition(change) {
  if (document.startViewTransition) document.startViewTransition(change);
  else change();
}

export function setupExpandController() {
  if (typeof document === 'undefined') return;

  document.addEventListener('click', (e) => {
    const toggle = e.target && e.target.closest ? e.target.closest(TOGGLE) : null;
    if (!toggle) return;
    const moduleEl = toggle.closest('.module');
    if (!moduleEl) return;
    const expanded = moduleEl.classList.contains('expanded');
    withTransition(() => setExpanded(expanded ? null : moduleEl));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // An open dialog handles its own Escape; don't also collapse the module behind it.
    if (document.querySelector('dialog[open]')) return;
    if (!document.querySelector('.module.expanded')) return;
    withTransition(() => setExpanded(null));
  });
}
