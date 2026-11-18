// Pre-warmed Scramjet + Ultraviolet Proxy Runtime, Watchdog Fallback, Identity Spoof & Account Cookie Vault Sync
let scramjetController = null;
let scramjetFrame = null;
let bareMuxConn = null;
let runtimeReadyPromise = null;
let frameWatchdogTimer = null;

export const proxyPrefs = {
  engine: 'scramjet', // scramjet is always primary default
  transport: 'libcurl', // libcurl | epoxy
  adblock: true,
  identityMode: 'mirror', // mirror | disguise
  devicePreset: 'default',
  customUa: ''
};

export const DEVICE_UA_PRESETS = {
  default: { label: 'Browser Default (Mirror)', ua: '', platform: '', touch: 0 },
  'win-chrome': {
    label: 'Windows 11 Chrome',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    touch: 0
  },
  'mac-safari': {
    label: 'macOS Safari',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    platform: 'MacIntel',
    touch: 0
  },
  'iphone-ios': {
    label: 'iPhone (iOS 18)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    touch: 5
  },
  'android-chrome': {
    label: 'Android Mobile Chrome',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv81',
    touch: 5
  },
  'chromebook': {
    label: 'Chromebook ChromeOS',
    ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    touch: 0
  }
};

export function isTikTokUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === 'tiktok.com' || h.endsWith('.tiktok.com') || h === 'tiktokv.com' || h.endsWith('.tiktokv.com');
  } catch {
    return /(?:^|\/\/|\.)tiktokv?\.com/i.test(String(url || ''));
  }
}

export function isIvyUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === 'ivy.rest' || h.endsWith('.ivy.rest');
  } catch {
    return /(?:^|\/\/|\.)ivy\.rest/i.test(String(url || ''));
  }
}

// Per-URL hint WITHOUT mutating user's saved global engine preference!
export function resolveEngineForUrl(url, explicitOverride = null) {
  if (explicitOverride === 'scramjet' || explicitOverride === 'ultraviolet') return explicitOverride;
  if (isTikTokUrl(url)) return 'ultraviolet';
  if (isIvyUrl(url)) return 'scramjet';
  return proxyPrefs.engine === 'ultraviolet' ? 'ultraviolet' : 'scramjet';
}

export function encodeXor(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += i % 2 === 1 ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i];
  }
  return encodeURIComponent(out);
}

export function decodeProxyClientUrl(url) {
  const s = String(url || '').trim();
  if (!s) return s;
  try {
    if (/\/scramjet\//i.test(s) && scramjetController?.decodeUrl) {
      const dec = scramjetController.decodeUrl(s);
      if (/^https?:\/\//i.test(dec)) return dec;
    }
    if (/\/uv\/service\//i.test(s) && window.__uv$config?.decodeUrl) {
      const part = (s.split('/uv/service/')[1] || '').split('#')[0];
      const dec = window.__uv$config.decodeUrl(part);
      if (/^https?:\/\//i.test(dec)) return dec;
    }
  } catch {}
  return s;
}

export function syncIdentityToSw() {
  const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctrl) return;
  const preset = DEVICE_UA_PRESETS[proxyPrefs.devicePreset] || DEVICE_UA_PRESETS.default;
  const ua = (proxyPrefs.devicePreset === 'custom' ? proxyPrefs.customUa : preset.ua) || '';
  const active = proxyPrefs.identityMode === 'disguise' && ua;
  ctrl.postMessage({
    type: 'astra-identity',
    mode: active ? 'disguise' : 'mirror',
    userAgent: active ? ua : '',
    platform: preset.platform || 'Win32',
    touchPoints: Number(preset.touch || 0)
  });
  ctrl.postMessage({ type: 'astra-adblock', enabled: !!proxyPrefs.adblock });
}

// A $scramjet IndexedDB without its 'config' store means Scramjet can never hand its config to the SW (pages then fall to the server-side fallback).
function healStaleScramjetDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('$scramjet');
      let created = false;
      req.onupgradeneeded = () => { created = true; };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const db = req.result;
        const missing = created || !db.objectStoreNames.contains('config');
        db.close();
        if (!missing) return resolve();
        const del = indexedDB.deleteDatabase('$scramjet');
        del.onsuccess = del.onerror = del.onblocked = () => resolve();
      };
    } catch { resolve(); }
  });
}

export async function ensureProxyRuntimeReady(browserFrameEl = null) {
  if (!runtimeReadyPromise) {
    runtimeReadyPromise = (async () => {
      try {
        await healStaleScramjetDb();
        if (typeof $scramjetLoadController === 'function') {
          const { ScramjetController } = $scramjetLoadController();
          scramjetController = new ScramjetController({
            files: {
              wasm: '/scram/scramjet.wasm.wasm',
              all: '/scram/scramjet.all.js',
              sync: '/scram/scramjet.sync.js'
            },
            prefix: '/scramjet/'
          });
          window.__scramjet$controller = scramjetController;
          // init BEFORE the SW is registered: the SW opens the $scramjet DB without a schema, so if it wins the race the 'config' store never exists and init() throws forever.
          try { await scramjetController.init(); } catch (err) { console.warn('[astra] scramjet pre-init failed', err); }
        }
        if (navigator.serviceWorker?.register) {
          const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
          try { await reg.update(); } catch {}
          if (reg.waiting) {
            try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch {}
          }
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
            await new Promise((r) => {
              navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
              setTimeout(r, 2000);
            });
          }
          if (scramjetController) await scramjetController.init();
          syncIdentityToSw();
        }
        if (window.BareMux?.BareMuxConnection) {
          bareMuxConn = new window.BareMux.BareMuxConnection('/baremux/worker.js');
          const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
          const wispUrl = `${proto}${location.host}/wisp/`;
          const target = proxyPrefs.transport === 'epoxy' ? '/epoxy/index.mjs' : '/libcurl/index.mjs?v=astra3';
          try {
            await bareMuxConn.setTransport(target, [{ wisp: wispUrl }]);
          } catch {
            await bareMuxConn.setTransport('/epoxy/index.mjs', [{ wisp: wispUrl }]);
          }
        }
        return true;
      } catch {
        runtimeReadyPromise = null;
        return false;
      }
    })();
  }
  const ok = await runtimeReadyPromise;
  if (browserFrameEl && scramjetController && !scramjetFrame) {
    try { scramjetFrame = scramjetController.createFrame(browserFrameEl); } catch {}
  }
  return ok;
}

export async function switchTransport(mode) {
  proxyPrefs.transport = mode === 'epoxy' ? 'epoxy' : 'libcurl';
  if (!bareMuxConn) return;
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const wispUrl = `${proto}${location.host}/wisp/`;
  const target = proxyPrefs.transport === 'epoxy' ? '/epoxy/index.mjs' : '/libcurl/index.mjs?v=astra3';
  await bareMuxConn.setTransport(target, [{ wisp: wispUrl }]);
}

export function buildProxyUrl(cleanUrl, engineOverride = null) {
  const engine = resolveEngineForUrl(cleanUrl, engineOverride);
  if (engine === 'ultraviolet') {
    if (window.__uv$config?.encodeUrl) return `${location.origin}${window.__uv$config.prefix}${window.__uv$config.encodeUrl(cleanUrl)}`;
    return `${location.origin}/uv/service/${encodeXor(cleanUrl)}`;
  }
  if (scramjetController?.encodeUrl) return `${location.origin}${scramjetController.encodeUrl(cleanUrl)}`;
  return `${location.origin}/scramjet/${encodeURIComponent(cleanUrl)}`;
}

// Per-User Cross-Device Proxy Cookie Sync (IndexedDB <-> Backend /api/proxy/cookies)
function idbReadAll(dbName, storeName, key = null) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName);
      let upgraded = false;
      req.onupgradeneeded = () => { upgraded = true; };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (upgraded || !db.objectStoreNames.contains(storeName)) {
          try { db.close(); if (upgraded) indexedDB.deleteDatabase(dbName); } catch {}
          return resolve(null);
        }
        const tx = db.transaction(storeName, 'readonly').objectStore(storeName);
        const r = key !== null ? tx.get(key) : tx.getAll();
        r.onsuccess = () => { try { db.close(); } catch {} resolve(r.result || null); };
        r.onerror = () => { try { db.close(); } catch {} resolve(null); };
      };
    } catch { resolve(null); }
  });
}

function idbWriteStore(dbName, storeName, entries, singleKey = null) {
  return new Promise((resolve) => {
    try {
      let created = false;
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = () => { created = true; };
      req.onerror = () => resolve(false);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (created || !db.objectStoreNames.contains(storeName)) { db.close(); if (created) { try { indexedDB.deleteDatabase(dbName); } catch {} } return resolve(false); }
          const tx = db.transaction(storeName, 'readwrite');
          const os = tx.objectStore(storeName);
          if (singleKey !== null) {
            os.put(entries, singleKey);
          } else if (Array.isArray(entries)) {
            os.clear();
            entries.forEach((item) => { try { os.put(item); } catch {} });
          }
          tx.oncomplete = () => { try { db.close(); } catch {} resolve(true); };
          tx.onerror = () => { try { db.close(); } catch {} resolve(false); };
        } catch { resolve(false); }
      };
    } catch { resolve(false); }
  });
}

export async function restoreProxyCookiesFromAccount() {
  try {
    const r = await fetch('/api/proxy/cookies', { credentials: 'same-origin' });
    if (!r.ok) return;
    const j = await r.json();
    const c = j && j.cookies;
    if (!c) return;
    if (c.scramjet) await idbWriteStore('$scramjet', 'cookies', c.scramjet, 'cookies');
    if (Array.isArray(c.uv) && c.uv.length) await idbWriteStore('__op', 'cookies', c.uv, null);
    if (Array.isArray(c.cobalt) && c.cobalt.length) {
      localStorage.setItem('cobalt-cookies', JSON.stringify(c.cobalt));
    }
  } catch {}
}

let cookieSyncTimer = null;
export function scheduleProxyCookieUpload() {
  clearTimeout(cookieSyncTimer);
  cookieSyncTimer = setTimeout(async () => {
    try {
      const [sj, uv] = await Promise.all([
        idbReadAll('$scramjet', 'cookies', 'cookies'),
        idbReadAll('__op', 'cookies', null)
      ]);
      let cobalt = [];
      try { cobalt = JSON.parse(localStorage.getItem('cobalt-cookies') || '[]') || []; } catch {}
      await fetch('/api/proxy/cookies', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scramjet: sj || null, uv: Array.isArray(uv) ? uv : [], cobalt })
      });
    } catch {}
  }, 1500);
}

// --- Roblox session relay: per-user server jar <-> live Scramjet cookie store ---
// When a user signs in on roblox.com inside the proxy, the SW captures
// .ROBLOSECURITY but it never reaches the server-side per-user jar - and a
// session saved on another device never reaches this browser's proxy. Scramjet's
// service worker natively accepts {scramjet$type:'cookie'} messages and merges
// them into the cookie store it attaches to every proxied request, so the
// injection direction is just a postMessage; no library internals to patch.
let rbxSyncLastTs = 0;
let rbxSyncedToServer = ''; // cookie value last submitted to /api/roblox/verify
let rbxInjectedCookie = ''; // cookie value last checked against the server jar

function askSwForRobloxCookie() {
  return new Promise((resolve) => {
    try {
      const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!ctrl || !ctrl.postMessage) return resolve('');
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(String((e && e.data && e.data.cookie) || ''));
      ch.port1.onerror = () => resolve('');
      ctrl.postMessage({ type: 'astra-get-roblox-cookie' }, [ch.port2]);
      setTimeout(() => resolve(''), 2500);
    } catch { resolve(''); }
  });
}

function injectRobloxCookieIntoScramjet(cookieVal) {
  try {
    const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!ctrl || !cookieVal) return false;
    ctrl.postMessage({
      scramjet$type: 'cookie',
      cookie: `.ROBLOSECURITY=${cookieVal}; Domain=.roblox.com; Path=/; Secure; HttpOnly; SameSite=None`,
      url: 'https://www.roblox.com/'
    });
    return true;
  } catch { return false; }
}

export async function syncRobloxSession({ force = false, showToast = null } = {}) {
  const now = Date.now();
  if (!force && now - rbxSyncLastTs < 20000) return;
  rbxSyncLastTs = now;
  try {
    const swCookie = await askSwForRobloxCookie();

    // 1) A session captured inside the proxy that the server jar doesn't have yet
    //    → verify it with Roblox and save it to THIS user's account (per user, forever).
    if (swCookie && swCookie !== rbxSyncedToServer) {
      rbxSyncedToServer = swCookie;
      try {
        const j = await fetch('/api/roblox/verify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie: swCookie })
        }).then((r) => r.json());
        if (j && j.signedIn && showToast) showToast(`Roblox linked as @${(j.user && j.user.name) || 'you'} - you stay signed in`);
      } catch {}
    }

    // 2) The server jar has a valid session (signed in here or on another device)
    //    that this browser's proxy store doesn't → inject it so roblox.com opens
    //    already logged in. Checked once per session unless the SW side changes.
    if (rbxInjectedCookie === '' || (swCookie && swCookie !== rbxInjectedCookie)) {
      try {
        const j = await fetch('/api/roblox/status', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const serverCookie = (j && j.cookie) || '';
        if (serverCookie) {
          rbxInjectedCookie = serverCookie;
          if (serverCookie !== swCookie) injectRobloxCookieIntoScramjet(serverCookie);
          // Keep the webblox bridge's localStorage jar in sync too
          try {
            const arr = [];
            try { arr.push(...JSON.parse(localStorage.getItem('cobalt-cookies') || '[]')); } catch {}
            const cleaned = arr.filter((c) => !(c && (c.n === '.ROBLOSECURITY' || c.name === '.ROBLOSECURITY')));
            for (const d of ['roblox.com', 'rbxcdn.com', 'robloxlabs.com']) {
              cleaned.push({ n: '.ROBLOSECURITY', v: serverCookie, d, h: false, p: '/', s: true, o: true, e: 0, ss: 'none' });
            }
            localStorage.setItem('cobalt-cookies', JSON.stringify(cleaned));
          } catch {}
        } else {
          rbxInjectedCookie = swCookie || 'none'; // nothing valid server-side; don't re-check this session
        }
      } catch {}
    }
  } catch {}
}

export async function navigateFrameWithFallback(browserFrameEl, cleanUrl, options = {}) {
  const { forceReload = false, engineOverride = null, onStatus = () => {}, onLoaded = () => {} } = options;
  await ensureProxyRuntimeReady(browserFrameEl);
  syncIdentityToSw();

  const chosenEngine = resolveEngineForUrl(cleanUrl, engineOverride);
  if (!forceReload && browserFrameEl.dataset.loadedUrl === cleanUrl && browserFrameEl.dataset.loadedEngine === chosenEngine) {
    onLoaded({ url: cleanUrl, engine: chosenEngine });
    return;
  }

  clearTimeout(frameWatchdogTimer);
  browserFrameEl.dataset.loadedUrl = cleanUrl;
  browserFrameEl.dataset.loadedEngine = chosenEngine;
  onStatus({ loading: true, engine: chosenEngine, text: `Loading via ${chosenEngine}...` });

  const fallbackEngine = chosenEngine === 'scramjet' ? 'ultraviolet' : 'scramjet';
  const alreadyRetried = !!options._isFallback;

  const triggerFallback = (reason) => {
    if (alreadyRetried) return;
    onStatus({ loading: true, engine: fallbackEngine, text: `Retrying via ${fallbackEngine} (${reason})...` });
    navigateFrameWithFallback(browserFrameEl, cleanUrl, {
      forceReload: true,
      engineOverride: fallbackEngine,
      _isFallback: true,
      onStatus,
      onLoaded
    });
  };

  frameWatchdogTimer = setTimeout(() => {
    try {
      const doc = browserFrameEl.contentDocument;
      const htmlLen = doc?.documentElement?.innerHTML?.length || 0;
      const bodyLen = (doc?.body?.innerText || '').trim().length;
      if (!doc || browserFrameEl.contentWindow?.location?.href === 'about:blank' || (htmlLen < 180 && bodyLen === 0)) {
        triggerFallback('stalled');
      }
    } catch {
      triggerFallback('blocked');
    }
  }, 8500);

  const onLoadOnce = () => {
    clearTimeout(frameWatchdogTimer);
    try {
      const doc = browserFrameEl.contentDocument;
      const bodyText = (doc?.body?.innerText || '').trim();
      const brokenProxy =
        /Something went wrong\.\s*Refresh the page/i.test(bodyText) ||
        /could not reach site/i.test(bodyText);
      if (!alreadyRetried && (brokenProxy || (doc && doc.readyState === 'complete' && (doc.body?.innerHTML || '').trim().length < 40 && !bodyText))) {
        triggerFallback('blank/error');
        return;
      }
      const realLoc = decodeProxyClientUrl(browserFrameEl.contentWindow?.location?.href || '');
      scheduleProxyCookieUpload();
      syncRobloxSession();
      onStatus({ loading: false, engine: chosenEngine, text: '' });
      onLoaded({ url: /^https?:\/\//i.test(realLoc) ? realLoc : cleanUrl, engine: chosenEngine, title: doc?.title || '' });
    } catch {
      onStatus({ loading: false, engine: chosenEngine, text: '' });
      onLoaded({ url: cleanUrl, engine: chosenEngine, title: '' });
    }
  };
  browserFrameEl.addEventListener('load', onLoadOnce, { once: true });

  if (chosenEngine === 'scramjet' && scramjetFrame) {
    if (forceReload) browserFrameEl.src = 'about:blank';
    scramjetFrame.go(cleanUrl);
  } else {
    browserFrameEl.src = buildProxyUrl(cleanUrl, chosenEngine);
  }
}
