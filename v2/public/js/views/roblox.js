// Roblox (/roblox): sign in right here, then play.
// The sign-in frame is the real Roblox login hosted by a community relay,
// so the challenge is clickable and the email one-time code works.
// The frame loads immediately (saved server first), and a watchdog swaps
// to the next server if the current one is dead. Relays blocked on this
// network (api.spf50krem.com is a common one) ride our own scramjet proxy
// instead, which also keeps the sign-in box same-origin so the service
// worker it needs is allowed to start.
import { ICONS } from '/js/icons.js';
import { syncRobloxSession, buildProxyUrl, ensureProxyRuntimeReady } from '/js/proxy-engine.js';

const STEP_NAMES = ['Welcome', 'Sign in', 'Play'];

const QUICK_LINKS = [
  { label: 'Games', url: 'https://www.roblox.com/games' },
  { label: 'Discover', url: 'https://www.roblox.com/discover' },
  { label: 'Avatar', url: 'https://www.roblox.com/my/avatar' },
  { label: 'Create', url: 'https://create.roblox.com/' }
];

// Community relays that host the sign-in page and the player.
const JAR_HOSTS = [
  'https://api.spf50krem.com',
  'https://api.tuplantaforma.com',
  'https://api.fotograflar.com',
  'https://api.shor.ch',
  'https://api.tenspot.net',
  'https://api.rymconstrucciones.cl',
  'https://api.bsfa.info',
  'https://api.jurematoz.com',
  'https://api.whatastupididea.com',
  'https://api.alcrb.ru',
  'https://api.shredstreet.com',
  'https://api.garnier-audebourg.org',
  'https://api.fysiomotion.se',
  'https://api.sexualidadesrosario.com.ar',
  'https://api.vaizer.cl'
];
const JAR_KEY = 'astra-roblox-jar-host';
// Remember whether this browser opened the Roblox tab before, so the next
// visit can skip the intro and say "Ready to play again?" instead.
const VISITED_KEY = 'astra-roblox-visited';

// ---- relay plumbing ----
let jarHost = '';
let jarTried = new Set(); // hosts we believe are dead this visit
let jarBridgeFrame = null;
let jarBridgeReady = null;
const jarWaiters = new Map(); // id -> { resolve, reject, timer }

function jarOrigin() {
  try { return jarHost ? new URL(jarHost).origin : ''; } catch { return ''; }
}

// Relays can be unreachable straight out of this browser (api.spf50krem.com
// is blocked on some school and work networks). Every host is therefore
// reachable two ways: direct, or wrapped in our own scramjet proxy. alive()
// tries direct first and only flips a host onto the proxy when the direct
// route is dead here.
const proxiedHosts = new Set();

function jarFrameSrc(host, pathName) {
  return proxiedHosts.has(host) ? buildProxyUrl(host + pathName) : host + pathName;
}

// Where relay frames post their messages: same-origin under the proxy, the
// relay's own origin when loaded direct.
function frameOriginFor(host) {
  if (proxiedHosts.has(host)) return location.origin;
  try { return new URL(host).origin; } catch { return ''; }
}

function pingOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal })
    .then((r) => !!r.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

async function alive(host) {
  if (await pingOnce(host + '/_rbx/ping', 3500)) {
    proxiedHosts.delete(host);
    return true;
  }
  try { await ensureProxyRuntimeReady(); } catch {}
  if (await pingOnce(buildProxyUrl(host + '/_rbx/ping'), 6000)) {
    proxiedHosts.add(host);
    return true;
  }
  return false;
}

function savedHost() {
  try {
    const s = localStorage.getItem(JAR_KEY) || '';
    return JAR_HOSTS.find((h) => h === s) || '';
  } catch { return ''; }
}

// Pick the fastest starting point: saved server, else the first one we
// haven't already ruled out this visit. Never blocks - returns instantly.
function startingHost() {
  const saved = savedHost();
  if (saved && !jarTried.has(saved)) return saved;
  return JAR_HOSTS.find((h) => !jarTried.has(h)) || '';
}

// Move to the next server that answers a quick ping. Used only when the
// current one fails. Tries at most 4 servers before giving up.
async function nextHost() {
  if (jarHost) jarTried.add(jarHost);
  const pool = JAR_HOSTS.filter((h) => !jarTried.has(h));
  const saved = savedHost();
  const ordered = [saved, ...pool.filter((h) => h !== saved)].filter(Boolean);
  for (const h of ordered.slice(0, 4)) {
    if (await alive(h)) return h;
  }
  return '';
}

// { type: 'jar:set', token } | { type: 'jar:clear' } | { type: 'jar:status' }
// -> { type: 'jar:reply', id, ok, signedIn?, error? }
function jarRequest(payload, timeoutMs = 12000) {
  if (!jarHost) return Promise.reject(new Error('no relay'));
  const origin = jarOrigin();
  if (!jarBridgeFrame) {
    jarBridgeFrame = document.createElement('iframe');
    jarBridgeFrame.style.display = 'none';
    jarBridgeFrame.src = jarFrameSrc(jarHost, '/_jar');
    jarBridgeReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        jarBridgeFrame && jarBridgeFrame.remove();
        jarBridgeFrame = null;
        jarBridgeReady = null;
        reject(new Error('relay did not answer'));
      }, timeoutMs);
      window.addEventListener('message', function onReady(e) {
        if ((e.origin !== origin && e.origin !== location.origin) || !e.data || e.data.type !== 'jar:ready') return;
        clearTimeout(timer);
        window.removeEventListener('message', onReady);
        resolve();
      });
    });
    document.body.appendChild(jarBridgeFrame);
  }
  return jarBridgeReady.then(() => new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      jarWaiters.delete(id);
      reject(new Error('relay was too slow'));
    }, timeoutMs);
    jarWaiters.set(id, { resolve, reject, timer });
    jarBridgeFrame.contentWindow.postMessage({ ...payload, id }, frameOriginFor(jarHost));
  }));
}

window.addEventListener('message', (e) => {
  const w = jarWaiters.get(e.data && e.data.id);
  const trusted = e.origin === jarOrigin() || e.origin === location.origin;
  if (trusted && e.data && e.data.type === 'jar:reply' && w) {
    clearTimeout(w.timer);
    jarWaiters.delete(e.data.id);
    w.resolve(e.data);
  }
});

// The sign-in frame tells us when the player finishes signing in.
function watchSignin(onSignedIn, onSignedOut) {
  if (!jarOrigin()) return () => {};
  const handler = (e) => {
    if ((e.origin !== jarOrigin() && e.origin !== location.origin) || !e.data) return;
    if (e.data.type === 'webblox:signed-in') onSignedIn && onSignedIn();
    if (e.data.type === 'webblox:signed-out') onSignedOut && onSignedOut();
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

// ---- view ----
export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/views.css');

  const state = {
    step: 1,
    pending2fa: null,
    jarSignedIn: false,
    jarChecked: false,
    signinSrc: '',
    note: '',
    returning: false,
    charts: null,
    activeChart: ''
  };

  let serverStatus = null; // fetched in the background

  function isSignedIn() {
    return state.jarSignedIn || !!(serverStatus && serverStatus.signedIn);
  }

  function stepsHtml() {
    return `
      <div class="rbx-steps rbx-steps-3">
        ${STEP_NAMES.map((n, i) => {
          const num = i + 1;
          const cls = num === state.step ? 'current' : (num < state.step ? 'done' : '');
          return `<div class="rbx-step-pill ${cls}"><span class="rbx-step-num">${num < state.step ? '✓' : num}</span><span>${n}</span></div>`;
        }).join('')}
      </div>
      <div class="rbx-progress"><div class="rbx-progress-fill" style="width:${(state.step / 3) * 100}%"></div></div>
    `;
  }

  function bodyHtml() {
    if (state.step === 1) {
      const name = serverStatus && serverStatus.signedIn && serverStatus.user ? serverStatus.user.displayName || serverStatus.user.name : '';
      if (state.returning) {
        return `
          <div class="rbx-icon-tile ${isSignedIn() ? 'ok' : ''}">${ICONS.roblox}</div>
          <h1 class="rbx-title">Ready to play again?</h1>
          <p class="rbx-body">${isSignedIn()
            ? 'Your Roblox login is still here. Jump back in, look at what is trending, or open Roblox directly.'
            : 'Welcome back. Jump in, or sign in again below.'}</p>
          <div class="rbx-row">
            <button type="button" class="rbx-cta" id="rbxReturnPlayBtn">Play now</button>
            <button type="button" class="rbx-ghost" id="rbxReturnHomeBtn">Open roblox.com</button>
          </div>
          <div class="rbx-chips">
            ${QUICK_LINKS.map((q) => `<button type="button" class="rbx-chip link" data-rbx-quick="${ctx.escapeHtml(q.url)}">${ctx.escapeHtml(q.label)}</button>`).join('')}
          </div>
          <div class="rbx-row">
            ${isSignedIn()
              ? `<button type="button" class="rbx-ghost" id="rbxReturnSigninBtn">Use a different account</button>
                 <button type="button" class="rbx-ghost" id="rbxReturnSignOutBtn">Sign out</button>`
              : `<button type="button" class="rbx-ghost" id="rbxReturnSigninBtn">Sign in</button>`}
          </div>
        `;
      }
      return `
        <div class="rbx-icon-tile ${isSignedIn() ? 'ok' : ''}">${ICONS.roblox}</div>
        <h1 class="rbx-title">${name ? `Welcome back, ${ctx.escapeHtml(name)}` : 'Welcome to Roblox'}</h1>
        <p class="rbx-body">Play Roblox right here in your browser. Sign in once and it sticks, even on school Wi-Fi.</p>
        <div class="rbx-row">
          <button type="button" class="rbx-cta" id="rbxStartBtn">${name ? 'Continue' : 'Get started'}</button>
        </div>
      `;
    }
    if (state.step === 2) {
      return `
        <h1 class="rbx-title">Sign in to Roblox</h1>
        <p class="rbx-body">Sign in right in the box below. Use your email: pick <em>Email Me a One-Time Code</em> and type the code Roblox sends you. If a puzzle pops up, tap the headphones button and type what you hear.</p>
        ${state.signinSrc ? `
          <div class="rbx-jar-wrap">
            <div class="rbx-jar-loading" id="rbxJarLoading"><div class="rbx-mini-spin"></div><span>Loading…</span></div>
            <iframe class="rbx-jar-frame" id="rbxJarSigninFrame" title="Sign in to Roblox" src="${ctx.escapeHtml(state.signinSrc)}"></iframe>
          </div>
        ` : `
          <div class="rbx-note rbx-warn">Can't reach Roblox right now. Check your connection, then try again.</div>
          <div class="rbx-row"><button type="button" class="rbx-cta" id="rbxRetryBtn">Try again</button></div>
        `}
        <div class="rbx-row" id="rbxSigninMeta">
          ${state.signinSrc ? `<button type="button" class="rbx-ghost" id="rbxHelpBtn">Sign-in help</button>` : ''}
        </div>
        <details class="rbx-details">
          <summary>Other ways to sign in</summary>
          <p class="rbx-note">These only work if the box above won't load for you.</p>
          <div class="rbx-fields" id="rbxLoginForm">
            <input class="field-input" id="rbxUser" type="text" placeholder="Username" autocomplete="off" />
            <input class="field-input" id="rbxPass" type="password" placeholder="Password" autocomplete="off" />
            <button type="button" class="rbx-cta" id="rbxLoginBtn">Sign in</button>
          </div>
          <div class="rbx-fields" id="rbx2faForm" style="display:none;">
            <input class="field-input" id="rbx2faCode" type="text" inputmode="numeric" maxlength="8" placeholder="6-digit code" autocomplete="one-time-code" />
            <button type="button" class="rbx-cta" id="rbx2faBtn">Check code</button>
          </div>
          <p class="rbx-note" id="rbxLoginHint"></p>
          <div class="rbx-fields">
            <input class="field-input" id="rbxCookieInput" type="password" placeholder="Paste your Roblox login" autocomplete="off" />
            <button type="button" class="rbx-ghost" id="rbxVerifyBtn">Use this login</button>
          </div>
        </details>
      `;
    }
    const name = serverStatus && serverStatus.signedIn && serverStatus.user ? serverStatus.user.name : '';
    return `
      <div class="rbx-icon-tile ok">${ICONS.roblox}</div>
      <h1 class="rbx-title">You're ready to play</h1>
      <p class="rbx-body">${name
        ? `Signed in as <strong>@${ctx.escapeHtml(name)}</strong>. Your login stays on this device.`
        : 'Your login stays on this device.'}</p>
      <div class="rbx-row">
        <button type="button" class="rbx-cta" id="rbxPlayBtn">Play now</button>
        <button type="button" class="rbx-ghost" id="rbxOpenHomeBtn">Open roblox.com</button>
      </div>
      <div class="rbx-charts" id="rbxCharts">
        <div class="rbx-charts-head">
          <div class="rbx-charts-title">Trending on Roblox</div>
          <div class="rbx-charts-sub">Live charts from Roblox, updated all day</div>
        </div>
        <div class="rbx-chart-tabs" id="rbxChartTabs"></div>
        <div class="rbx-chart-grid" id="rbxChartGrid"></div>
      </div>
      <div class="rbx-chips">
        ${QUICK_LINKS.map((q) => `<button type="button" class="rbx-chip link" data-rbx-quick="${ctx.escapeHtml(q.url)}">${ctx.escapeHtml(q.label)}</button>`).join('')}
      </div>
      <div class="rbx-row"><button type="button" class="rbx-ghost" id="rbxSignOutBtn">Sign out</button></div>
    `;
  }

  function render() {
    container.innerHTML = `
      <div class="page-wrap">
        <div class="rbx-wizard spot">
          ${stepsHtml()}
          <div class="rbx-stage">${bodyHtml()}</div>
          <div class="rbx-nav">
            <button type="button" class="rbx-ghost" id="rbxBackBtn" ${state.step === 1 ? 'disabled' : ''}>&larr; Back</button>
            ${state.step < 3 ? `<button type="button" class="rbx-ghost" id="rbxNextBtn">Next &rarr;</button>` : ''}
          </div>
        </div>
      </div>
    `;
    bind();
  }

  function helpModal() {
    if (document.querySelector('.rbx-help-modal')) return;
    const el = document.createElement('div');
    el.className = 'rbx-help-modal';
    el.innerHTML = `
      <div class="rbx-help-card" role="dialog" aria-modal="true" aria-labelledby="rbxHelpTitle">
        <h2 id="rbxHelpTitle">Before you sign in</h2>
        <ul class="rbx-help-points">
          <li><div><strong>Use your email</strong><span>Pick <em>Email Me a One-Time Code</em> and type the code Roblox sends you. Other sign-in options don't work in the box.</span></div></li>
          <li><div><strong>If a puzzle shows up</strong><span>Tap the headphones button and type the answer you hear.</span></div></li>
          <li><div><strong>Your login stays on this device</strong><span>Astra's servers never see your password.</span></div></li>
          <li><div><strong>Each browser signs in separately</strong><span>On a new device you sign in again. On a shared computer, sign out when you're done.</span></div></li>
        </ul>
        <button type="button" class="rbx-cta" id="rbxHelpOk">Got it</button>
      </div>
    `;
    const close = () => {
      el.classList.add('closing');
      setTimeout(() => el.remove(), 140);
      document.removeEventListener('keydown', esc);
    };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    el.addEventListener('click', (e) => { if (e.target === el || e.target.id === 'rbxHelpOk') close(); });
    document.addEventListener('keydown', esc);
    document.body.appendChild(el);
    el.querySelector('#rbxHelpOk').focus();
  }

  function openAppOverlay() {
    if (!jarHost || document.querySelector('.rbx-app-overlay')) return;
    const ov = document.createElement('div');
    ov.className = 'rbx-app-overlay';
    ov.innerHTML = `
      <div class="rbx-app-bar">
        <span class="rbx-app-title">Roblox</span>
        <button type="button" class="rbx-ghost" id="rbxAppExit">Exit</button>
      </div>
      <iframe class="rbx-app-frame" src="${ctx.escapeHtml(jarFrameSrc(jarHost, '/_rbx/app/'))}" title="Roblox"></iframe>
    `;
    ov.querySelector('#rbxAppExit').onclick = () => { ov.remove(); checkJar(true); };
    document.body.appendChild(ov);
  }

  function setNote(msg) {
    state.note = msg;
    const el = container.querySelector('#rbxLoginHint');
    if (el) el.textContent = msg || '';
  }

  // Ask the relay whether someone is already signed in. Quiet, best effort.
  async function checkJar(pushSaved) {
    if (!jarHost) return;
    try {
      const r = await jarRequest({ type: 'jar:status' });
      state.jarSignedIn = !!(r && r.ok && r.signedIn);
      state.jarChecked = true;
      // If Astra already has a login saved on the account, hand it to this
      // browser so the player opens signed in without asking again.
      if (pushSaved && !state.jarSignedIn && serverStatus && serverStatus.signedIn) {
        const j = await fetch('/api/roblox/status', { credentials: 'same-origin' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        const token = j && j.cookie;
        if (token && token.length >= 100) {
          const set = await jarRequest({ type: 'jar:set', token }).catch(() => null);
          if (set && set.ok) state.jarSignedIn = true;
        }
      }
    } catch {
      state.jarChecked = false;
    }
    if (state.jarSignedIn && state.step < 3) {
      // A returning visitor still gets their "Ready to play again?" card first.
      if (!(state.step === 1 && state.returning)) {
        state.step = 3;
        render();
      }
    } else if (state.step === 1) {
      // just refresh the welcome line quietly
      const tile = container.querySelector('.rbx-icon-tile');
      if (tile && isSignedIn()) tile.classList.add('ok');
    }
  }

  // Record which server the sign-in box points at. The frame itself is drawn
  // by render() with this src, and bind() wires up loading + watchdog.
  let frameTimer = null;
  function loadSignin() {
    if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
    state.signinSrc = jarHost ? jarFrameSrc(jarHost, '/_rbx/signin') : '';
  }

  async function refreshServerStatus() {
    try {
      const r = await fetch('/api/roblox/status', { credentials: 'same-origin' });
      if (r.ok) serverStatus = await r.json();
    } catch {}
  }

  // ---- charts ----
  function pct(g) {
    const total = (g.up || 0) + (g.down || 0);
    return total ? Math.round(((g.up || 0) / total) * 100) : 0;
  }
  function fmtCount(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
    return String(n);
  }
  function renderChartTabs() {
    const tabs = container.querySelector('#rbxChartTabs');
    if (!tabs || !Array.isArray(state.charts)) return;
    tabs.innerHTML = state.charts.map((c, i) => {
      const active = (state.activeChart || state.charts[0].id) === c.id;
      return `<button type="button" class="rbx-chart-tab ${active ? 'active' : ''}" data-chart-tab="${ctx.escapeHtml(c.id)}" title="${ctx.escapeHtml(c.info || '')}">${ctx.escapeHtml(c.name)}</button>`;
    }).join('');
    tabs.querySelectorAll('[data-chart-tab]').forEach((b) => {
      b.onclick = () => { state.activeChart = b.dataset.chartTab; renderChartTabs(); renderChartGrid(); };
    });
  }
  function renderChartGrid() {
    const grid = container.querySelector('#rbxChartGrid');
    if (!grid) return;
    const chart = Array.isArray(state.charts)
      ? state.charts.find((c) => c.id === state.activeChart) || state.charts[0]
      : null;
    if (!chart) {
      grid.innerHTML = '<div class="rbx-chart-empty">Charts are resting right now. They come back on their own.</div>';
      return;
    }
    grid.innerHTML = chart.games.map((g) => `
      <button type="button" class="rbx-chart-card" data-chart-place="${g.placeId}" title="${ctx.escapeHtml(g.name)}">
        <div class="rbx-chart-thumb"><img loading="lazy" src="/api/roblox/chart-icon?universeId=${g.universeId}" alt="" onerror="this.parentNode.innerHTML='<span class=&quot;rbx-chart-fallback&quot;>R</span>'"/></div>
        <div class="rbx-chart-meta">
          <div class="rbx-chart-name">${ctx.escapeHtml(g.name)}</div>
          <div class="rbx-chart-stats">
            <span class="rbx-chart-players"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>${fmtCount(g.players)}</span>
            <span class="rbx-chart-like"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${pct(g)}%</span>
            ${g.genre ? `<span class="rbx-chart-genre">${ctx.escapeHtml(g.genre)}</span>` : ''}
          </div>
        </div>
      </button>
    `).join('');
    grid.querySelectorAll('[data-chart-place]').forEach((b) => {
      const place = b.dataset.chartPlace;
      const name = b.querySelector('.rbx-chart-name') ? b.querySelector('.rbx-chart-name').textContent : 'Roblox';
      b.onclick = () => ctx.openExternalUrl(`https://www.roblox.com/games/${place}`, name);
    });
  }
  async function loadCharts() {
    try {
      const r = await fetch('/api/roblox/charts', { credentials: 'same-origin' });
      const j = await r.json();
      if (j && j.ok && Array.isArray(j.charts) && j.charts.length) {
        state.charts = j.charts;
        state.activeChart = j.charts[0].id;
        renderChartTabs();
        renderChartGrid();
      }
    } catch {}
  }

  function bind() {
    const back = container.querySelector('#rbxBackBtn');
    if (back) back.onclick = () => { if (state.step > 1) { state.step--; state.note = ''; render(); } };
    const next = container.querySelector('#rbxNextBtn');
    if (next) next.onclick = () => { if (state.step < 3) { state.step++; loadSignin(); render(); } };

    // sign-in frame: hide the loading veil on load, swap servers if it stalls
    const frame = container.querySelector('#rbxJarSigninFrame');
    if (frame) {
      const loading = container.querySelector('#rbxJarLoading');
      if (loading) loading.classList.remove('done');
      frame.addEventListener('load', () => {
        if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
        if (loading) loading.classList.add('done');
      }, { once: true });
      if (frameTimer) clearTimeout(frameTimer);
      frameTimer = setTimeout(async () => {
        frameTimer = null;
        const h = await nextHost();
        if (h && h !== jarHost) {
          jarHost = h;
          try { localStorage.setItem(JAR_KEY, h); } catch {}
          loadSignin();
          render();
        } else if (h && proxiedHosts.has(h)) {
          // Same host, but alive() flipped it onto our proxy while the direct
          // frame was staring at a dead wall - reload the box through scramjet.
          loadSignin();
          render();
        }
      }, 15000);
    }

    const startBtn = container.querySelector('#rbxStartBtn');
    if (startBtn) startBtn.onclick = () => { state.step = 2; loadSignin(); render(); };

    const retryBtn = container.querySelector('#rbxRetryBtn');
    if (retryBtn) retryBtn.onclick = async () => {
      state.note = '';
      jarHost = await nextHost();
      if (jarHost) { try { localStorage.setItem(JAR_KEY, jarHost); } catch {} }
      loadSignin();
      render();
    };

    const helpBtn = container.querySelector('#rbxHelpBtn');
    if (helpBtn) helpBtn.onclick = helpModal;

    const openSite = (url, title) => ctx.openExternalUrl(url, { title });
    const homeBtn = container.querySelector('#rbxOpenHomeBtn');
    if (homeBtn) homeBtn.onclick = () => openSite('https://www.roblox.com/home', 'Roblox');
    container.querySelectorAll('[data-rbx-quick]').forEach((b) => {
      b.onclick = () => openSite(b.dataset.rbxQuick, `Roblox ${b.textContent.trim()}`);
    });

    // returning-visit card options
    const returnPlayBtn = container.querySelector('#rbxReturnPlayBtn');
    if (returnPlayBtn) returnPlayBtn.onclick = () => { state.returning = false; state.step = 3; render(); loadCharts(); };
    const returnHomeBtn = container.querySelector('#rbxReturnHomeBtn');
    if (returnHomeBtn) returnHomeBtn.onclick = () => openSite('https://www.roblox.com/home', 'Roblox');
    const returnSigninBtn = container.querySelector('#rbxReturnSigninBtn');
    if (returnSigninBtn) returnSigninBtn.onclick = () => { state.returning = false; state.step = 2; loadSignin(); render(); };
    const returnSignOutBtn = container.querySelector('#rbxReturnSignOutBtn');
    if (returnSignOutBtn) {
      returnSignOutBtn.onclick = async () => {
        try { await jarRequest({ type: 'jar:clear' }); } catch {}
        state.jarSignedIn = false;
        state.returning = false;
        ctx.showToast('Signed out on this device');
        render();
      };
    }

    // username + password fallback
    const loginBtn = container.querySelector('#rbxLoginBtn');
    if (loginBtn) {
      const hint = container.querySelector('#rbxLoginHint');
      loginBtn.onclick = async () => {
        const userEl = container.querySelector('#rbxUser');
        const passEl = container.querySelector('#rbxPass');
        const username = userEl.value.trim();
        const password = passEl.value;
        if (!username || !password) {
          (username ? passEl : userEl).focus();
          return ctx.showToast('Type your username and password first');
        }
        loginBtn.disabled = true;
        loginBtn.textContent = 'Signing in…';
        setNote('');
        try {
          const r = await fetch('/api/roblox/login', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const j = await r.json();
          if (j && j.needs2FA) {
            state.pending2fa = { challengeId: j.challengeId, fieldType: j.fieldType || 'TOTP' };
            container.querySelector('#rbxLoginForm').style.display = 'none';
            container.querySelector('#rbx2faForm').style.display = 'flex';
            container.querySelector('#rbx2faCode').focus();
            setNote('Roblox wants a security code. Type the 6-digit code to finish.');
            loginBtn.disabled = false;
            loginBtn.textContent = 'Sign in';
            return;
          }
          if (!j || !j.ok || !j.signedIn) {
            loginBtn.disabled = false;
            loginBtn.textContent = 'Sign in';
            const msg = (j && j.error) || 'Roblox said that username or password is wrong.';
            setNote(msg);
            return ctx.showToast(msg);
          }
          serverStatus = { signedIn: true, user: j.user };
          syncRobloxSession({ force: true });
          ctx.showToast("You're signed in!");
          state.step = 3;
          render();
          loadCharts();
        } catch {
          loginBtn.disabled = false;
          loginBtn.textContent = 'Sign in';
          setNote("That didn't go through. Check your connection and try again.");
        }
      };

      const twoFaBtn = container.querySelector('#rbx2faBtn');
      if (twoFaBtn) {
        twoFaBtn.onclick = async () => {
          const codeEl = container.querySelector('#rbx2faCode');
          const code = codeEl.value.replace(/\D/g, '');
          if (!code || !state.pending2fa) return ctx.showToast('Type the 6-digit code Roblox sent');
          twoFaBtn.disabled = true;
          twoFaBtn.textContent = 'Checking…';
          try {
            const r = await fetch('/api/roblox/login/2fa', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...state.pending2fa, code })
            });
            const j = await r.json();
            if (!j || !j.ok || !j.signedIn) {
              twoFaBtn.disabled = false;
              twoFaBtn.textContent = 'Check code';
              const msg = (j && j.error) || "That code didn't work. Try the newest one.";
              setNote(msg);
              return ctx.showToast(msg);
            }
            serverStatus = { signedIn: true, user: j.user };
            syncRobloxSession({ force: true });
            ctx.showToast("You're signed in!");
            state.step = 3;
            render();
            loadCharts();
          } catch {
            twoFaBtn.disabled = false;
            twoFaBtn.textContent = 'Check code';
            ctx.showToast("That didn't go through. Try again.");
          }
        };
      }

      const verifyBtn = container.querySelector('#rbxVerifyBtn');
      if (verifyBtn) {
        verifyBtn.onclick = async () => {
          const input = container.querySelector('#rbxCookieInput');
          const cookie = input.value.trim();
          if (!cookie) {
            input.focus();
            return ctx.showToast('Paste your Roblox login first');
          }
          verifyBtn.disabled = true;
          verifyBtn.textContent = 'Checking…';
          try {
            const r = await fetch('/api/roblox/verify', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cookie })
            });
            const j = await r.json();
            if (!j.signedIn) {
              verifyBtn.disabled = false;
              verifyBtn.textContent = 'Use this login';
              const msg = "That login didn't work. Copy it again from a signed-in Roblox tab.";
              setNote(msg);
              return ctx.showToast(msg);
            }
            serverStatus = { signedIn: true, user: j.user };
            ctx.showToast("You're signed in!");
            state.step = 3;
            render();
            loadCharts();
          } catch {
            verifyBtn.disabled = false;
            verifyBtn.textContent = 'Use this login';
            ctx.showToast("That didn't go through. Try again.");
          }
        };
      }
    }

    // play step
    const playBtn = container.querySelector('#rbxPlayBtn');
    if (playBtn) {
      playBtn.onclick = async () => {
        if (!jarHost) {
          jarHost = await nextHost();
          if (!jarHost) return ctx.showToast("Can't reach Roblox right now - try again in a bit");
        }
        if (!state.jarSignedIn && !(serverStatus && serverStatus.signedIn)) {
          state.step = 2;
          loadSignin();
          render();
          return ctx.showToast('Sign in first - it takes a minute');
        }
        openAppOverlay();
      };
    }
    const signOutBtn = container.querySelector('#rbxSignOutBtn');
    if (signOutBtn) {
      signOutBtn.onclick = async () => {
        try { await jarRequest({ type: 'jar:clear' }); } catch {}
        state.jarSignedIn = false;
        ctx.showToast('Signed out on this device');
        render();
      };
    }
  }

  // Boot: paint instantly, then sort everything out in the background.
  let returning = false;
  try { returning = localStorage.getItem(VISITED_KEY) === '1'; } catch {}
  state.returning = returning;
  jarHost = startingHost();
  render();

  await refreshServerStatus();
  if (serverStatus && serverStatus.signedIn && state.step === 1) {
    if (returning) {
      // Second time around: the "Ready to play again?" card replaces the intro
      // and keeps every option on one screen instead of skipping ahead.
      state.returning = true;
      render();
    } else {
      state.step = 3;
      render();
      loadCharts();
    }
  }
  try { localStorage.setItem(VISITED_KEY, '1'); } catch {}

  if (jarHost) {
    try { localStorage.setItem(JAR_KEY, jarHost); } catch {}
    // Quietly sort the relay route out in the background: when the saved host
    // is blocked on this network, alive() flips it onto our own proxy and the
    // sign-in box reloads through scramjet instead of a dead frame.
    (async () => {
      try { await ensureProxyRuntimeReady(); } catch {}
      if (!jarHost) return;
      const wasProxied = proxiedHosts.has(jarHost);
      const ok = await alive(jarHost);
      if (ok && proxiedHosts.has(jarHost) === wasProxied) return;
      jarBridgeFrame && jarBridgeFrame.remove();
      jarBridgeFrame = null;
      jarBridgeReady = null;
      if (!ok) {
        const h = await nextHost();
        if (h && h !== jarHost) {
          jarHost = h;
          try { localStorage.setItem(JAR_KEY, h); } catch {}
        }
      }
      loadSignin();
      render();
    })();
    checkJar(true);
    const unwatch = watchSignin(async () => {
      state.jarSignedIn = true;
      state.jarChecked = true;
      ctx.showToast("You're signed in!");
      state.step = 3;
      state.returning = false;
      render();
      loadCharts();
      checkJar(true);
    }, () => {
      state.jarSignedIn = false;
      if (state.step === 3) { state.step = 2; loadSignin(); }
      render();
    });
    const oldCleanup = container._rbxCleanup;
    container._rbxCleanup = () => { oldCleanup && oldCleanup(); unwatch(); if (frameTimer) clearTimeout(frameTimer); };
  }
}
