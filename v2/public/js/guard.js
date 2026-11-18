// Page guard.
//
// A browser always lets the person at the keyboard open their own developer
// tools, so this does not pretend to lock them out. What it does is make the
// usual routes awkward and get the page out of sight the moment they are used:
// the shortcuts that open the tools or the page source are stopped, the right
// click menu is stopped, and if a tools window is detected the Clever cover goes
// up over the app until it is closed again.

import { raiseShield } from '/js/cloak.js';

const KEY = 'astra.guard';

let on = true;
let watchTimer = null;
let strikes = 0;

export function guardOn() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? true : JSON.parse(raw) !== false;
  } catch {
    return true;
  }
}

export function setGuard(next) {
  on = !!next;
  try { localStorage.setItem(KEY, JSON.stringify(on)); } catch {}
  if (on) arm();
  else disarm();
  return on;
}

/* Every shortcut that leads to the code, the tools or a copy of the page. */
function blocked(e) {
  const k = String(e.key || '').toLowerCase();
  const meta = e.ctrlKey || e.metaKey;

  if (k === 'f12') return true;

  if (meta && e.shiftKey) {
    // Chrome, Edge and Firefox: tools, console, inspector, network.
    if (k === 'i' || k === 'j' || k === 'c' || k === 'k' || k === 'e') return true;
  }

  if (meta && !e.shiftKey) {
    // Page source, save page, and Firefox's own source window.
    if (k === 'u') return true;
    if (k === 's' && !e.altKey) return true;
  }

  return false;
}

let armed = false;
function onKeyDown(e) {
  if (!blocked(e)) return;
  e.preventDefault();
  e.stopPropagation();
  // Something in the page tried to be clever, so put the cover up as well.
  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey)) raiseShield();
}

function onContextMenu(e) {
  e.preventDefault();
  return false;
}

function toolsOpen() {
  // A window that reports no outer size has nothing to compare with, so it is
  // left alone. A docked tools window takes a real bite out of the viewport;
  // browser chrome alone never comes close to this.
  const ow = window.outerWidth || 0;
  const oh = window.outerHeight || 0;
  if (!ow || !oh) return false;
  const wGap = ow - window.innerWidth;
  const hGap = oh - window.innerHeight;
  return wGap > 220 || hGap > 220;
}

function tick() {
  if (toolsOpen()) {
    strikes += 1;
    if (strikes >= 2) raiseShield();
  } else {
    strikes = 0;
  }
}

export function arm() {
  if (armed) return;
  armed = true;
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  watchTimer = setInterval(tick, 900);
}

export function disarm() {
  if (!armed) return;
  armed = false;
  document.removeEventListener('keydown', onKeyDown, true);
  document.removeEventListener('contextmenu', onContextMenu, true);
  clearInterval(watchTimer);
  watchTimer = null;
  strikes = 0;
}

export function initGuard() {
  on = guardOn();
  if (on) arm();
  return on;
}
