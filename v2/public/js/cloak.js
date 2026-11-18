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

const FALLBACK = { on: true, title: CLOAK_TITLE, icon: CLOAK_ICON };

let cfg = Object.assign({}, FALLBACK);
let baseTitle = '';
let observer = null;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return Object.assign({}, FALLBACK);
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return Object.assign({}, FALLBACK);
    return {
      on: j.on !== false,
      title: typeof j.title === 'string' && j.title.trim() ? j.title : CLOAK_TITLE,
      icon: typeof j.icon === 'string' && j.icon.trim() ? j.icon : CLOAK_ICON
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
  save();
  if (cfg.on) {
    applyCloak();
  } else {
    dropIcon();
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
  return getCloak();
}
