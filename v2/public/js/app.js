// Astra v2 Core Shell & Lazy Route Orchestrator
import { applyRailIcons } from '/js/icons.js';
import { startSnowfall } from '/js/snow.js';
import {
  subscribeMusic, togglePlayPause, nextTrack, prevTrack, stopAndExitMusic, loadLibraryData
} from '/js/music-engine.js';
import {
  proxyPrefs, ensureProxyRuntimeReady, restoreProxyCookiesFromAccount,
  syncIdentityToSw, resolveEngineForUrl, decodeProxyClientUrl, syncRobloxSession
} from '/js/proxy-engine.js';
import { initTabCloak, applyCloak } from '/js/cloak.js';
import { initGuard } from '/js/guard.js';

// The tab reads as the saved cloak (Clever by default) from the first paint.
initTabCloak();
initGuard();

export const appState = {
  user: null,
  serverConfig: { motd: '', motdList: [], defaultEngine: 'scramjet', adblockDefault: true, dnsMode: 'cloudflare', dnsAdFilter: true, version: 'v2.0.0' },
  theme: 'void',
  wallpaper: 'achromaon-bg', // achromaon-bg | dot-grid | black-hole | lunar-moon | solar-eclipse | saturn-cosmos | milky-way | backrooms
  shortcuts: null,
  bookmarks: [],
  tabs: [{ id: 1, route: '/h', title: 'Home', url: null, loading: false, engine: null }],
  activeTabId: 1,
  nextTabId: 2,
  onlineCount: 1,
  bootStartMs: performance.now()
};

const ROUTE_TITLES = {
  '/h': 'Home',
  '/b': 'Browse',
  '/g': 'Games',
  '/m': 'Movies',
  '/a': 'Anime',
  '/music': 'Music',
  '/chat': 'Chat',
  '/roblox': 'Roblox',
  '/ai': 'AI',
  '/s': 'Settings',
  '/admin': 'Admin'
};

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function showToast(msg, ms = 2600) {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast-pill';
  el.textContent = String(msg || '');
  host.appendChild(el);
  setTimeout(() => { el.remove(); }, ms);
}

export function openModal(html, onMount) {
  const host = document.getElementById('modalHost');
  if (!host) return;
  host.innerHTML = `<div class="modal-card">${html}</div>`;
  host.classList.add('open');
  host.onclick = (e) => { if (e.target === host) closeModal(); };
  if (typeof onMount === 'function') onMount(host.firstElementChild);
}

export function closeModal() {
  const host = document.getElementById('modalHost');
  if (!host) return;
  host.classList.remove('open');
  host.innerHTML = '';
}

export function ensureCssLoaded(href) {
  if (document.querySelector(`link[data-lazy-css="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  l.dataset.lazyCss = href;
  document.head.appendChild(l);
}

export function applyTheme(themeId) {
  const clean = (!themeId || themeId === 'cherri') ? 'rose' : themeId; // cherri = old name for the rose look
  appState.theme = clean;
  document.documentElement.setAttribute('data-theme', clean);
}

export function applyWallpaper(mode) {
  const bgStage = document.getElementById('bgStage');
  const bgVideo = document.getElementById('bgVideoLayer');
  appState.wallpaper = mode || 'achromaon-bg';
  if (!bgStage) return;

  if (bgVideo) {
    try { bgVideo.pause(); } catch {}
    bgVideo.style.display = 'none';
    bgVideo.style.opacity = '';
    bgVideo.removeAttribute('src');
    try { bgVideo.load(); } catch {}
  }
  bgStage.classList.remove('custom-image');
  bgStage.style.backgroundImage = '';

  const imgMap = {
    'lunar-moon': '/assets/themes/lunar-moon.jpg',
    'black-hole': '/assets/themes/black-hole.jpg',
    'saturn-cosmos': '/assets/themes/saturn-cosmos.jpg',
    'solar-eclipse': '/assets/themes/solar-eclipse.jpg',
    'milky-way': '/assets/themes/milky-way.jpg'
  };
  const vidMap = {
    'backrooms': '/assets/themes/backrooms.mp4',
    'electric-space': '/assets/themes/electric-space.mp4',
    'bw-topo': '/assets/themes/bw-topo-lines.mp4',
    'achromaon-bg': '/assets/themes/achromaon-bg.mp4'
  };
  /* The ACH clip is mostly dark with a warm glow, so it needs more of itself on
   * screen than the brighter loops do. */
  const vidOpacity = {
    'achromaon-bg': '0.62'
  };
  if (appState.wallpaper === 'yt-video') {
    const vid = appState.wallpaperVideo;
    if (vid && vid.id && bgVideo) {
      // Streamed straight from Astra's server (raw progressive mp4) - no YouTube
      // player, so no ads, no tracking pixels, muted + looped.
      bgVideo.src = `/api/wallpaper/video/${encodeURIComponent(vid.id)}`;
      bgVideo.style.display = 'block';
      bgVideo.play().catch(() => {});
    } else {
      appState.wallpaper = 'dot-grid';
    }
  } else if (imgMap[appState.wallpaper]) {
    bgStage.classList.add('custom-image');
    bgStage.style.backgroundImage = `linear-gradient(rgba(8,6,10,0.45), rgba(8,6,10,0.65)), url("${imgMap[appState.wallpaper]}")`;
  } else if (vidMap[appState.wallpaper] && bgVideo) {
    bgVideo.src = vidMap[appState.wallpaper];
    bgVideo.style.opacity = vidOpacity[appState.wallpaper] || '';
    bgVideo.style.display = 'block';
    bgVideo.play().catch(() => {});
  } else if (appState.wallpaper !== 'dot-grid' && appState.wallpaper !== 'yt-video') {
    /* A saved wallpaper that is no longer shipped falls back to the default
     * instead of leaving the page with no active choice. */
    appState.wallpaper = 'dot-grid';
  }
}

let saveStateTimer = null;
export function saveUserState() {
  if (!appState.user) return;
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    fetch('/api/user/state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          theme: appState.theme,
          wallpaper: appState.wallpaper,
          wallpaperVideo: appState.wallpaperVideo || null,
          clockSize: appState.clockSize || 1,
          engine: proxyPrefs.engine,
          transport: proxyPrefs.transport,
          adblock: proxyPrefs.adblock,
          bookmarks: appState.bookmarks
        },
        shortcuts: appState.shortcuts,
        identity: {
          identityMode: proxyPrefs.identityMode,
          devicePreset: proxyPrefs.devicePreset,
          customUa: proxyPrefs.customUa
        }
      })
    }).catch(() => {});
  }, 500);
}

// Cherri .spot spotlight mouse tracker (minimal overhead)
document.addEventListener('pointermove', (e) => {
  const spot = e.target && e.target.closest ? e.target.closest('.spot') : null;
  if (!spot) return;
  const r = spot.getBoundingClientRect();
  spot.style.setProperty('--sx', `${e.clientX - r.left}px`);
  spot.style.setProperty('--sy', `${e.clientY - r.top}px`);
}, { passive: true });

const routeMount = document.getElementById('routeMount');
const browseStage = document.getElementById('browseStage');
const browserFrame = document.getElementById('browserFrame');
const omniboxInput = document.getElementById('omniboxInput');
const engineBadgeBtn = document.getElementById('engineBadgeBtn');
const tabListEl = document.getElementById('tabList');
const bookmarkBtn = document.getElementById('bookmarkBtn');

let currentViewCleanup = null;

export function getActiveTab() {
  return appState.tabs.find((t) => t.id === appState.activeTabId) || appState.tabs[0];
}

export function renderTabs() {
  if (!tabListEl) return;
  tabListEl.innerHTML = appState.tabs.map((t) => {
    const active = t.id === appState.activeTabId ? 'active' : '';
    let iconHtml = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
    if (t.loading) {
      iconHtml = `<span class="tab-pill-spinner"></span>`;
    } else if (t.url) {
      try {
        const host = new URL(t.url).hostname;
        iconHtml = `<img src="https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}" alt="" />`;
      } catch {}
    } else if (t.route === '/h') {
      iconHtml = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z"/></svg>`;
    }
    return `
      <div class="tab-pill ${active}" data-tab-id="${t.id}">
        <span class="tab-pill-icon">${iconHtml}</span>
        <span class="tab-pill-title">${escapeHtml(t.title || 'Tab')}</span>
        <span class="tab-pill-close" data-close-tab="${t.id}" title="Close">×</span>
      </div>
    `;
  }).join('');

  tabListEl.querySelectorAll('[data-tab-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close-tab]');
      if (closeBtn) {
        e.stopPropagation();
        closeTab(Number(closeBtn.dataset.closeTab));
        return;
      }
      switchTab(Number(el.dataset.tabId));
    });
  });
}

export function createNewTab(route = '/h') {
  const cleanRoute = ROUTE_TITLES[route] ? route : '/h';
  const t = { id: appState.nextTabId++, route: cleanRoute, title: ROUTE_TITLES[cleanRoute], url: null, loading: false };
  appState.tabs.push(t);
  appState.activeTabId = t.id;
  renderTabs();
  navigateRoute(cleanRoute, { skipPush: false });
}

export function switchTab(id) {
  const hit = appState.tabs.find((t) => t.id === id);
  if (!hit) return;
  appState.activeTabId = hit.id;
  renderTabs();
  syncActiveTabView();
}

export function closeTab(id) {
  if (appState.tabs.length <= 1) {
    const only = appState.tabs[0];
    only.route = '/h';
    only.url = null;
    only.title = 'Home';
    only.loading = false;
    renderTabs();
    syncActiveTabView();
    return;
  }
  const idx = appState.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  appState.tabs.splice(idx, 1);
  if (appState.activeTabId === id) {
    appState.activeTabId = appState.tabs[Math.max(0, idx - 1)].id;
  }
  renderTabs();
  syncActiveTabView();
}

export function updateOmniboxAndRail(tab) {
  document.querySelectorAll('.rail-btn[data-route]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === tab.route);
  });
  if (omniboxInput) {
    if (tab.url) omniboxInput.value = tab.url;
    else omniboxInput.value = `astra://${(tab.route || '/h').replace(/^\//, '') || 'home'}`;
  }
  if (engineBadgeBtn) {
    const eng = tab.url ? resolveEngineForUrl(tab.url, tab.engine) : proxyPrefs.engine;
    engineBadgeBtn.textContent = eng === 'ultraviolet' ? 'ultraviolet' : 'scramjet';
  }
  if (bookmarkBtn) {
    bookmarkBtn.classList.toggle('saved', !!(tab.url && appState.bookmarks.includes(tab.url)));
  }
}

export function navigateRoute(route, opts = {}) {
  let target = route === '/' ? '/h' : route;
  if (!ROUTE_TITLES[target]) target = '/h';

  const tab = getActiveTab();
  if (target === '/ai') {
    return openExternalUrl('https://ivy.rest/a', { routeTag: '/ai', title: 'Ivy AI' });
  }

  tab.route = target;
  if (target !== '/b') tab.url = null;
  tab.title = ROUTE_TITLES[target] || 'Home';
  tab.loading = false;

  if (!opts.skipPush) {
    // The browser path is the route itself. "/" belongs to the Clever page that
    // fronts the site, so the app never claims it, and a reload comes back here.
    const browserPath = target;
    if (location.pathname !== browserPath) {
      try { history.pushState({ route: target }, '', browserPath); } catch {}
    }
  }
  renderTabs();
  syncActiveTabView();
}

export function openExternalUrl(rawInput, opts = {}) {
  let clean = String(rawInput || '').trim();
  if (!clean) return;

  const lower = clean.toLowerCase();
  if (ROUTE_TITLES[lower]) return navigateRoute(lower);
  if (lower === 'home') return navigateRoute('/h');
  if (lower === 'browse') return navigateRoute('/b');
  if (lower === 'settings') return navigateRoute('/s');
  if (lower === 'music') return navigateRoute('/music');
  if (lower === 'chat') return navigateRoute('/chat');
  if (lower === 'games') return navigateRoute('/g');
  if (lower === 'anime') return navigateRoute('/a');

  if (!/^https?:\/\//i.test(clean)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(clean) && !clean.includes(' ')) {
      clean = 'https://' + clean;
    } else {
      clean = `https://duckduckgo.com/?q=${encodeURIComponent(clean)}`;
    }
  }

  const tab = getActiveTab();
  tab.route = opts.routeTag || '/b';
  tab.url = clean;
  tab.engine = opts.engineOverride || null;
  tab.title = opts.title || clean.replace(/^https?:\/\/(?:www\.)?/i, '').split('/')[0].slice(0, 20);
  tab.loading = true;
  if (!opts.skipPush) {
    try { history.pushState({ route: tab.route, url: clean }, '', tab.route); } catch {}
  }
  renderTabs();
  syncActiveTabView(!!opts.forceReload);
}

const loadedModules = new Map();
async function loadRouteModule(routeKey) {
  if (!loadedModules.has(routeKey)) {
    loadedModules.set(routeKey, import(`/js/views/${routeKey}.js`));
  }
  return await loadedModules.get(routeKey);
}

export async function syncActiveTabView(forceReload = false) {
  const tab = getActiveTab();
  updateOmniboxAndRail(tab);

  if (tab.url) {
    if (currentViewCleanup) { try { currentViewCleanup(); } catch {} currentViewCleanup = null; }
    routeMount.classList.add('hidden');
    routeMount.innerHTML = '';
    browseStage.classList.add('visible');
    const mod = await loadRouteModule('browse');
    currentViewCleanup = mod.mountBrowse({
      frame: browserFrame,
      url: tab.url,
      forceReload,
      engineOverride: tab.engine,
      onTabMeta: (meta) => {
        if (meta.url) tab.url = meta.url;
        if (meta.engine) tab.engine = meta.engine;
        if (meta.title) tab.title = meta.title.slice(0, 24);
        tab.loading = !!meta.loading;
        renderTabs();
        updateOmniboxAndRail(tab);
      }
    });
    return;
  }

  browseStage.classList.remove('visible');
  routeMount.classList.remove('hidden');

  if (currentViewCleanup) { try { currentViewCleanup(); } catch {} currentViewCleanup = null; }

  const routeToModule = {
    '/h': 'home',
    '/b': 'browse',
    '/g': 'games',
    '/a': 'anime',
    '/m': 'movies',
    '/music': 'music',
    '/chat': 'chat',
    '/roblox': 'roblox',
    '/s': 'settings',
    '/admin': 'admin'
  };
  const modName = routeToModule[tab.route] || 'home';
  if (modName === 'browse') {
    // Empty /b opens home search or quick starter cleanly
    if (currentViewCleanup) { try { currentViewCleanup(); } catch {} currentViewCleanup = null; }
    routeMount.classList.add('hidden');
    browseStage.classList.add('visible');
    const mod = await loadRouteModule('browse');
    currentViewCleanup = mod.mountBrowse({
      frame: browserFrame,
      url: 'https://duckduckgo.com/',
      forceReload: false,
      onTabMeta: (meta) => {
        if (meta.url) tab.url = meta.url;
        tab.loading = !!meta.loading;
        renderTabs();
        updateOmniboxAndRail(tab);
      }
    });
    return;
  }

  const mod = await loadRouteModule(modName);
  currentViewCleanup = (await mod.mount(routeMount, ctxApi())) || null;

  // Smooth fade-in on every view switch
  routeMount.classList.remove('view-enter');
  void routeMount.offsetWidth;
  routeMount.classList.add('view-enter');
}

function ctxApi() {
  return {
    appState,
    proxyPrefs,
    navigateRoute,
    openExternalUrl,
    saveUserState,
    applyTheme,
    applyWallpaper,
    showToast,
    openModal,
    closeModal,
    ensureCssLoaded,
    escapeHtml
  };
}

// Toolbar & Global Bindings
document.querySelectorAll('.rail-btn[data-route]').forEach((btn) => {
  btn.addEventListener('click', () => navigateRoute(btn.dataset.route));
});
document.getElementById('newTabBtn')?.addEventListener('click', () => createNewTab('/h'));
document.getElementById('omniboxForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  openExternalUrl(omniboxInput.value, { forceReload: true });
});
document.getElementById('navBackBtn')?.addEventListener('click', () => {
  const tab = getActiveTab();
  if (tab.url) {
    try { browserFrame.contentWindow.history.back(); } catch {}
  } else {
    try { history.back(); } catch {}
  }
});
document.getElementById('navFwdBtn')?.addEventListener('click', () => {
  const tab = getActiveTab();
  if (tab.url) {
    try { browserFrame.contentWindow.history.forward(); } catch {}
  } else {
    try { history.forward(); } catch {}
  }
});
document.getElementById('navReloadBtn')?.addEventListener('click', () => {
  const tab = getActiveTab();
  if (tab.url) {
    openExternalUrl(tab.url, { routeTag: tab.route, forceReload: true, engineOverride: tab.engine });
  } else {
    syncActiveTabView(true);
  }
});
engineBadgeBtn?.addEventListener('click', () => {
  const tab = getActiveTab();
  const next = (tab.url ? resolveEngineForUrl(tab.url, tab.engine) : proxyPrefs.engine) === 'scramjet' ? 'ultraviolet' : 'scramjet';
  proxyPrefs.engine = next;
  saveUserState();
  if (tab.url) {
    tab.engine = next;
    openExternalUrl(tab.url, { routeTag: tab.route, forceReload: true, engineOverride: next });
  } else {
    updateOmniboxAndRail(tab);
    showToast(next === 'ultraviolet' ? 'Now using Ultraviolet' : 'Now using Scramjet');
  }
});
document.getElementById('toggleRailBtn')?.addEventListener('click', () => {
  document.getElementById('astraShell')?.classList.toggle('rail-hidden');
});
bookmarkBtn?.addEventListener('click', () => {
  const tab = getActiveTab();
  if (!tab.url) return showToast('Open a website to bookmark it');
  const idx = appState.bookmarks.indexOf(tab.url);
  if (idx === -1) {
    appState.bookmarks.unshift(tab.url);
    showToast('Saved bookmark');
  } else {
    appState.bookmarks.splice(idx, 1);
    showToast('Removed bookmark');
  }
  updateOmniboxAndRail(tab);
  saveUserState();
});
document.getElementById('popoutBlankBtn')?.addEventListener('click', () => {
  const win = window.open('about:blank', '_blank');
  if (!win) return showToast('Allow popups to open about:blank cloak');
  const d = win.document;
  d.title = 'Dashboard | Coursera';
  const ifr = d.createElement('iframe');
  ifr.src = location.href;
  ifr.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;';
  d.body.style.margin = '0';
  d.body.appendChild(ifr);
});
document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
});
document.getElementById('railLogoutBtn')?.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  location.reload();
});

// Sync Top Mini Music Pill globally
subscribeMusic((st) => {
  const pill = document.getElementById('topMiniMusic');
  const label = document.getElementById('miniMusicLabel');
  const playBtn = document.getElementById('miniPlayBtn');
  if (!pill || !label || !playBtn) return;
  pill.classList.toggle('loaded', !!st.track);
  pill.classList.toggle('playing', !!st.track && !st.paused);
  label.textContent = st.track ? `${st.track.title} · ${st.track.artist}` : 'Nothing playing';
  playBtn.textContent = (!st.track || st.paused) ? '▶' : '⏸';
});
document.getElementById('miniMusicJumpBtn')?.addEventListener('click', () => navigateRoute('/music'));
document.getElementById('miniPrevBtn')?.addEventListener('click', () => prevTrack());
document.getElementById('miniPlayBtn')?.addEventListener('click', () => togglePlayPause());
document.getElementById('miniNextBtn')?.addEventListener('click', () => nextTrack());
document.getElementById('miniExitBtn')?.addEventListener('click', () => stopAndExitMusic());

// Auth & Boot Flow
const authGate = document.getElementById('authGate');
const authForm = document.getElementById('authForm');
const authError = document.getElementById('authError');

document.getElementById('openCloakBtn')?.addEventListener('click', () => {
  location.href = '/';
});

function startTourNow() {
  import('/js/tour.js').then((m) => m.startTour({ appState, navigateRoute, ensureCssLoaded, showToast })).catch(() => {});
}
window.addEventListener('astra:start-tour', startTourNow);

// The ACH background is the new default. The first load after this update puts
// it in place even if an older wallpaper was saved, so nobody is left on the old
// look by accident. From then on their own pick is kept.
function migrateDefaultWallpaper(saved) {
  try {
    if (localStorage.getItem('astra.wallpaper.default') === 'ach') return saved;
    localStorage.setItem('astra.wallpaper.default', 'ach');
  } catch {}
  return 'achromaon-bg';
}

async function onAuthenticated(userData, srvCfg) {
  appState.user = userData;
  if (srvCfg) appState.serverConfig = srvCfg;
  authGate?.classList.add('hidden');
  const adminBtn = document.getElementById('railAdminBtn');
  if (adminBtn) adminBtn.style.display = userData.role === 'admin' ? 'inline-flex' : 'none';

  // Restore user preferences + cookies + library
  try {
    const stRes = await fetch('/api/user/state', { credentials: 'same-origin' });
    if (stRes.ok) {
      const sj = await stRes.json();
      const s = sj?.state?.settings || {};
      if (s.theme) applyTheme(s.theme);
      if (s.clockSize) {
        appState.clockSize = Math.min(2.2, Math.max(0.55, Number(s.clockSize) || 1));
        document.documentElement.style.setProperty('--clockScale', String(appState.clockSize));
      }
      if (s.wallpaperVideo && typeof s.wallpaperVideo === 'object' && s.wallpaperVideo.id) {
        appState.wallpaperVideo = s.wallpaperVideo;
      }
      if (s.wallpaper) {
        const nextWallpaper = migrateDefaultWallpaper(s.wallpaper);
        applyWallpaper(nextWallpaper);
        // Keep the new default for next time instead of restoring the old one.
        if (nextWallpaper !== s.wallpaper) saveUserState();
      }
      if (s.engine === 'scramjet' || s.engine === 'ultraviolet') proxyPrefs.engine = s.engine;
      if (s.transport === 'epoxy' || s.transport === 'libcurl') proxyPrefs.transport = s.transport;
      if (typeof s.adblock === 'boolean') proxyPrefs.adblock = s.adblock;
      if (Array.isArray(s.bookmarks)) appState.bookmarks = s.bookmarks;
      if (Array.isArray(sj?.state?.shortcuts)) appState.shortcuts = sj.state.shortcuts;
      const idn = sj?.state?.identity || {};
      if (idn.identityMode) proxyPrefs.identityMode = idn.identityMode;
      if (idn.devicePreset) proxyPrefs.devicePreset = idn.devicePreset;
      if (idn.customUa) proxyPrefs.customUa = idn.customUa;
    }
  } catch {}

  loadLibraryData();
  // Pre-warm Scramjet SW & BareMux immediately in background!
  setTimeout(() => ensureProxyRuntimeReady(browserFrame).then(() => restoreProxyCookiesFromAccount()).then(() => syncRobloxSession()), 60);

  // Presence heartbeat
  const sendBeat = () => {
    fetch('/api/presence/heartbeat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((j) => {
        if (j && Number.isFinite(j.count)) {
          appState.onlineCount = j.count;
          const el = document.getElementById('homeOnlineCount');
          if (el) el.textContent = `${j.count} online`;
        }
      }).catch(() => {});
  };
  sendBeat();
  setInterval(sendBeat, 20000);

  // Deep links like /v2b (browse) or /v2a (ai) land on their real app
  const V2_PATH_ALIASES = {
    '/v2': '/h',
    '/v2a': '/ai', '/v2ai': '/ai',
    '/v2b': '/b', '/v2browse': '/b',
    '/v2g': '/g', '/v2games': '/g',
    '/v2c': '/chat', '/v2chat': '/chat',
    '/v2an': '/a', '/v2anime': '/a',
    '/v2r': '/roblox', '/v2roblox': '/roblox',
    '/v2m': '/m', '/v2movies': '/m',
    '/v2mu': '/music', '/v2music': '/music',
    '/v2s': '/s', '/v2settings': '/s'
  };
  const aliasRoute = V2_PATH_ALIASES[location.pathname];
  if (aliasRoute) history.replaceState({}, '', aliasRoute);
  const initPath = ROUTE_TITLES[location.pathname] ? location.pathname : '/h';
  navigateRoute(initPath, { skipPush: true });
  const forceTour = new URLSearchParams(location.search).get('tour') === '1';
  if (forceTour || userData.needsTour) {
    setTimeout(startTourNow, 700);
  } else {
    // Returning users get the hello card; brand new users get the tour above.
    setTimeout(() => {
      import('/js/welcome.js').then((m) => m.maybeShowWelcome({ appState, ensureCssLoaded })).catch(() => {});
    }, 450);
  }
}

if (authForm) {
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    const u = document.getElementById('authUser').value.trim();
    const p = document.getElementById('authPass').value;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p, remember: true })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        authError.textContent = j.error || 'Login failed';
        return;
      }
      await onAuthenticated(j.user, j.serverConfig);
    } catch {
      authError.textContent = 'Network error';
    }
  });
}

window.addEventListener('popstate', (e) => {
  const pathRoute = ROUTE_TITLES[location.pathname] ? location.pathname : '/h';
  const tab = getActiveTab();
  tab.route = pathRoute;
  tab.url = (e.state && e.state.url) || null;
  tab.title = tab.url ? tab.url.replace(/^https?:\/\//i, '').slice(0, 18) : (ROUTE_TITLES[pathRoute] || 'Home');
  renderTabs();
  syncActiveTabView();
});

(async function boot() {
  applyTheme('void');
  applyRailIcons();
  startSnowfall();
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.ok) {
      const j = await r.json();
      if (j && j.authenticated && j.user) {
        await onAuthenticated(j.user, j.serverConfig);
        return;
      }
    }
  } catch {}
  authGate?.classList.remove('hidden');
})();
