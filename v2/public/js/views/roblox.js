// Roblox (/roblox): sign in with your Roblox account, then play.
//
// The sign in talks straight to Astra's own server, which passes it to Roblox
// and keeps the login on your Astra account. No frame from another site and no
// service worker of its own, so this works in Firefox and on networks that
// block outside login pages.
import { ICONS } from '/js/icons.js';
import { syncRobloxSession } from '/js/proxy-engine.js';

const STEP_NAMES = ['Welcome', 'Sign in', 'Play'];

const QUICK_LINKS = [
  { label: 'Games', url: 'https://www.roblox.com/games' },
  { label: 'Discover', url: 'https://www.roblox.com/discover' },
  { label: 'Avatar', url: 'https://www.roblox.com/my/avatar' },
  { label: 'Create', url: 'https://create.roblox.com/' }
];

// The player Astra hosts. Same origin, already running here, so it loads the
// same way in every browser.
const ENGINE_PATH = '/3to1s93ve/launcher/index.html';
const VISITED_KEY = 'astra.roblox.visited';

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/views.css');

  const state = {
    step: 1,
    returning: false,
    note: '',
    pending2fa: null,
    charts: null,
    activeChart: null
  };
  let serverStatus = null;

  function isSignedIn() {
    return !!(serverStatus && serverStatus.signedIn);
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
        <p class="rbx-body">Type your Roblox username and password. If Roblox asks for a code, type the newest code it sends you.</p>
        <div class="rbx-fields" id="rbxLoginForm">
          <input class="field-input" id="rbxUser" type="text" placeholder="Username" autocomplete="username" spellcheck="false" />
          <input class="field-input" id="rbxPass" type="password" placeholder="Password" autocomplete="current-password" />
          <button type="button" class="rbx-cta" id="rbxLoginBtn">Sign in</button>
        </div>
        <div class="rbx-fields" id="rbx2faForm" style="display:none;">
          <input class="field-input" id="rbx2faCode" type="text" inputmode="numeric" maxlength="8" placeholder="6-digit code" autocomplete="one-time-code" />
          <button type="button" class="rbx-cta" id="rbx2faBtn">Check code</button>
        </div>
        <p class="rbx-note" id="rbxLoginHint"></p>
        <div class="rbx-row">
          <button type="button" class="rbx-ghost" id="rbxHelpBtn">Sign-in help</button>
        </div>
        <details class="rbx-details">
          <summary>Paste a login instead</summary>
          <p class="rbx-note">Only if the form above won't work for you. Copy the value from a browser that is already signed in to Roblox.</p>
          <div class="rbx-fields">
            <input class="field-input" id="rbxCookieInput" type="password" placeholder="Paste your Roblox login" autocomplete="off" />
            <button type="button" class="rbx-ghost" id="rbxVerifyBtn">Use this login</button>
          </div>
        </details>
      `;
    }
    const name = serverStatus && serverStatus.signedIn && serverStatus.user ? serverStatus.user.name : '';
    if (!isSignedIn()) {
      return `
        <div class="rbx-icon-tile">${ICONS.roblox}</div>
        <h1 class="rbx-title">Sign in to play</h1>
        <p class="rbx-body">The player needs your Roblox account before it can load a game. It takes a minute and you only do it once.</p>
        <div class="rbx-row">
          <button type="button" class="rbx-cta" id="rbxGoSigninBtn">Sign in</button>
          <button type="button" class="rbx-ghost" id="rbxOpenHomeBtn">Open roblox.com</button>
        </div>
        <div class="rbx-chips">
          ${QUICK_LINKS.map((q) => `<button type="button" class="rbx-chip link" data-rbx-quick="${ctx.escapeHtml(q.url)}">${ctx.escapeHtml(q.label)}</button>`).join('')}
        </div>
      `;
    }
    return `
      <div class="rbx-icon-tile ok">${ICONS.roblox}</div>
      <h1 class="rbx-title">You're ready to play</h1>
      <p class="rbx-body">${name
        ? `Signed in as <strong>@${ctx.escapeHtml(name)}</strong>. Your login stays on your Astra account.`
        : 'Your login stays on your Astra account.'}</p>
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
          <li><div><strong>Username and password</strong><span>Use the same ones you use on roblox.com. Nothing is saved on this device until Roblox accepts them.</span></div></li>
          <li><div><strong>A code may pop up</strong><span>Roblox sometimes asks for a code. Type the newest one it sends and you land straight in.</span></div></li>
          <li><div><strong>If a puzzle blocks you</strong><span>Finish the puzzle and try again. If it keeps coming back, sign in on roblox.com and paste your login in the box at the bottom.</span></div></li>
          <li><div><strong>Shared computers</strong><span>Sign out when you're done so the next person doesn't land in your account.</span></div></li>
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

  // The player opens over the page. The login Astra saved for this account is
  // pushed into the browser first, so the player opens already signed in.
  async function openEngine(placeId) {
    if (document.querySelector('.rbx-app-overlay')) return;
    if (!isSignedIn()) {
      // Nothing to load with. Take them to the sign-in step instead of opening a
      // player that can only say it needs a session.
      state.returning = false;
      state.step = 2;
      render();
      return ctx.showToast('Sign in first - it takes a minute');
    }
    try { await syncRobloxSession({ force: true }); } catch {}
    const src = ENGINE_PATH + (placeId ? `?placeId=${encodeURIComponent(placeId)}` : '');
    const ov = document.createElement('div');
    ov.className = 'rbx-app-overlay';
    ov.innerHTML = `
      <div class="rbx-app-bar">
        <span class="rbx-app-title">Roblox</span>
        <button type="button" class="rbx-ghost" id="rbxAppExit">Exit</button>
      </div>
      <iframe class="rbx-app-frame" src="${ctx.escapeHtml(src)}" title="Roblox" allow="fullscreen; clipboard-write"></iframe>
    `;
    ov.querySelector('#rbxAppExit').onclick = () => ov.remove();
    document.body.appendChild(ov);
  }

  function setNote(msg) {
    state.note = msg;
    const el = container.querySelector('#rbxLoginHint');
    if (el) el.textContent = msg || '';
  }

  async function refreshServerStatus() {
    try {
      const r = await fetch('/api/roblox/status', { credentials: 'same-origin' });
      if (r.ok) serverStatus = await r.json();
    } catch {}
  }

  function signedIn(j) {
    serverStatus = { signedIn: true, user: (j && j.user) || null };
    syncRobloxSession({ force: true });
    ctx.showToast("You're signed in!");
    state.step = 3;
    render();
    loadCharts();
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
    tabs.innerHTML = state.charts.map((c) => {
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
      b.onclick = () => openEngine(b.dataset.chartPlace);
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

  async function signOut() {
    try { await fetch('/api/roblox/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    // Drop the copy this browser kept for the player too.
    try {
      const arr = JSON.parse(localStorage.getItem('cobalt-cookies') || '[]');
      const left = Array.isArray(arr) ? arr.filter((c) => !(c && (c.n === '.ROBLOSECURITY' || c.name === '.ROBLOSECURITY'))) : [];
      localStorage.setItem('cobalt-cookies', JSON.stringify(left));
    } catch {}
    serverStatus = { signedIn: false, user: null };
    state.returning = false;
    state.step = 1;
    ctx.showToast('Signed out');
    render();
  }

  function bind() {
    const back = container.querySelector('#rbxBackBtn');
    if (back) back.onclick = () => { if (state.step > 1) { state.step--; state.note = ''; render(); } };
    const next = container.querySelector('#rbxNextBtn');
    if (next) next.onclick = () => { if (state.step < 3) { state.step++; state.note = ''; render(); } };

    const startBtn = container.querySelector('#rbxStartBtn');
    if (startBtn) startBtn.onclick = () => { state.step = 2; state.note = ''; render(); };

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
    if (returnPlayBtn) returnPlayBtn.onclick = () => openEngine();
    const returnHomeBtn = container.querySelector('#rbxReturnHomeBtn');
    if (returnHomeBtn) returnHomeBtn.onclick = () => openSite('https://www.roblox.com/home', 'Roblox');
    const returnSigninBtn = container.querySelector('#rbxReturnSigninBtn');
    if (returnSigninBtn) returnSigninBtn.onclick = () => { state.returning = false; state.step = 2; render(); };
    const returnSignOutBtn = container.querySelector('#rbxReturnSignOutBtn');
    if (returnSignOutBtn) returnSignOutBtn.onclick = signOut;

    // username and password
    const loginBtn = container.querySelector('#rbxLoginBtn');
    if (loginBtn) {
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
            setNote('Roblox wants a security code. Type the newest one it sent you.');
            loginBtn.disabled = false;
            loginBtn.textContent = 'Sign in';
            return;
          }
          loginBtn.disabled = false;
          loginBtn.textContent = 'Sign in';
          if (!j || !j.ok || !j.signedIn) {
            const msg = (j && j.error) || 'Roblox said that username or password is wrong.';
            setNote(msg);
            return ctx.showToast(msg);
          }
          signedIn(j);
        } catch {
          loginBtn.disabled = false;
          loginBtn.textContent = 'Sign in';
          setNote("That didn't go through. Check your connection and try again.");
        }
      };
    }

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
          signedIn(j);
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
          signedIn(j);
        } catch {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Use this login';
          ctx.showToast("That didn't go through. Try again.");
        }
      };
    }

    // play step
    const playBtn = container.querySelector('#rbxPlayBtn');
    if (playBtn) playBtn.onclick = () => openEngine();
    const goSigninBtn = container.querySelector('#rbxGoSigninBtn');
    if (goSigninBtn) goSigninBtn.onclick = () => { state.returning = false; state.step = 2; render(); };
    const signOutBtn = container.querySelector('#rbxSignOutBtn');
    if (signOutBtn) signOutBtn.onclick = signOut;
  }

  // Boot: paint instantly, then sort everything out in the background.
  let returning = false;
  try { returning = localStorage.getItem(VISITED_KEY) === '1'; } catch {}
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
  if (state.step === 3) loadCharts();
}
