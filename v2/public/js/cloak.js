// Tab cloak.
//
// A browser tab only reads two things: the document title and one icon link.
// Both are set here from a saved choice, so the tab at the top of the screen
// says "Clever" no matter what the page is showing. Nothing else changes, the
// page keeps working exactly as it did.
//
// The choice survives reloads, and the name and icon can both be changed, which
// is what lets a pasted link open under the same tab as everything else.

const KEY = 'astra.tabcloak';
export const CLOAK_ICON = '/clever-cloak/Clever_files/favicon-32.png';
export const CLOAK_TITLE = 'Clever';

const FALLBACK = { on: true, title: CLOAK_TITLE, icon: CLOAK_ICON, shield: true };

let cfg = Object.assign({}, FALLBACK);
let baseTitle = '';
let observer = null;
let shieldEl = null;
let shieldTimer = null;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return Object.assign({}, FALLBACK);
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return Object.assign({}, FALLBACK);
    return {
      on: j.on !== false,
      title: typeof j.title === 'string' && j.title.trim() ? j.title : CLOAK_TITLE,
      icon: typeof j.icon === 'string' && j.icon.trim() ? j.icon : CLOAK_ICON,
      shield: j.shield !== false
    };
  } catch {
    return Object.assign({}, FALLBACK);
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
}

function iconEl() {
  let el = document.getElementById('astra-cloak-icon');
  if (!el) {
    el = document.createElement('link');
    el.id = 'astra-cloak-icon';
    el.rel = 'icon';
    (document.head || document.documentElement).appendChild(el);
  }
  return el;
}

function dropIcon() {
  const el = document.getElementById('astra-cloak-icon');
  if (el) el.remove();
}

export function getCloak() {
  return Object.assign({}, cfg);
}

/* ------------------------------------------------------------------ */
/* Click-away cover                                                    */
/*                                                                     */
/* When the window loses focus the whole page turns into the Clever    */
/* page, and the first click anywhere brings the app back. The frame   */
/* is the real page served at /, so nothing about it looks faked.      */
/* ------------------------------------------------------------------ */

function buildShield() {
  if (shieldEl) return shieldEl;
  const el = document.createElement('div');
  el.id = 'astra-cloak-shield';
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;background:#fff;';

  const frame = document.createElement('iframe');
  frame.src = '/';
  frame.title = 'Clever';
  frame.setAttribute('tabindex', '-1');
  frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;';

  /* Sits above the frame so the click lands here, not on a Clever link. */
  const catcher = document.createElement('div');
  catcher.style.cssText = 'position:absolute;inset:0;cursor:default;';
  catcher.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropShield();
  }, true);

  el.appendChild(frame);
  el.appendChild(catcher);
  (document.body || document.documentElement).appendChild(el);
  shieldEl = el;
  return el;
}

export function raiseShield() {
  if (!cfg.on || !cfg.shield) return;
  if (!document.body) return;
  buildShield().style.display = 'block';
}

export function dropShield() {
  if (shieldEl) shieldEl.style.display = 'none';
}

// Put the saved name and icon back. Cheap enough to call on every render.
export function applyCloak() {
  if (!document.head) return;
  if (!cfg.on) return;
  const title = cfg.title || CLOAK_TITLE;
  const href = cfg.icon || CLOAK_ICON;
  if (document.title !== title) document.title = title;
  const el = iconEl();
  if (el.getAttribute('href') !== href) el.setAttribute('href', href);
  if (!el.getAttribute('type')) el.setAttribute('type', 'image/png');
}

// Change one or more parts of the cloak and apply it straight away.
export function setCloak(patch = {}) {
  cfg = Object.assign({}, cfg, patch);
  cfg.title = String(cfg.title || '').trim() || CLOAK_TITLE;
  cfg.icon = String(cfg.icon || '').trim() || CLOAK_ICON;
  cfg.shield = cfg.shield !== false;
  save();
  if (cfg.on) {
    applyCloak();
  } else {
    dropIcon();
    dropShield();
    if (baseTitle) document.title = baseTitle;
  }
  return getCloak();
}

// Some pages rewrite their own title while the app runs. The observer puts the
// cloak back. It writes only when the value is actually wrong, so it cannot
// loop on its own writes.
function watchTitle() {
  if (observer || !document.head || typeof MutationObserver !== 'function') return;
  observer = new MutationObserver(() => {
    if (!cfg.on) return;
    const title = cfg.title || CLOAK_TITLE;
    if (document.title !== title) document.title = title;
    const el = document.getElementById('astra-cloak-icon');
    if (!el) applyCloak();
    else if (el.getAttribute('href') !== (cfg.icon || CLOAK_ICON)) el.setAttribute('href', cfg.icon || CLOAK_ICON);
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
}

export function initTabCloak() {
  cfg = read();
  if (!baseTitle) baseTitle = document.title || 'Astra';
  if (cfg.on) applyCloak();
  watchTitle();
  watchFocus();
  /* Build the cover once, off screen, so the first click away shows it straight
   * away instead of a white box while the page loads. */
  if (cfg.on && cfg.shield) {
    setTimeout(() => { try { buildShield(); } catch {} }, 3000);
  }
  return getCloak();
}

/* Click away, get Clever. Come back, get the app.
 *
 * A click into one of Astra's own frames also blurs the window in some browsers,
 * so a frame that ends up focused means the person is still inside the app and
 * the cover stays down. */
function watchFocus() {
  if (watchFocus.done) return;
  watchFocus.done = true;

  window.addEventListener('blur', () => {
    clearTimeout(shieldTimer);
    shieldTimer = setTimeout(() => {
      if (!cfg.on || !cfg.shield) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'IFRAME' || ae.tagName === 'VIDEO')) return;
      if (typeof document.hasFocus === 'function' && document.hasFocus()) return;
      raiseShield();
    }, 300);
  });

  window.addEventListener('focus', () => {
    clearTimeout(shieldTimer);
    dropShield();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) raiseShield();
    else {
      clearTimeout(shieldTimer);
      dropShield();
    }
  });
}
