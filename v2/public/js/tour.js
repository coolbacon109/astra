// Interactive spotlight tour. Lazy-loaded by app.js (first login, `?tour=1`, or Settings → Replay tutorial).
// deps (from app.js): { appState, navigateRoute, ensureCssLoaded, showToast, escapeHtml }
let overlayEl = null;
let teardown = null;

function visible(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4;
}
function pick(sel) {
  const list = document.querySelectorAll(sel);
  for (const el of list) if (visible(el)) return el;
  return list[0] || null;
}

export function startTour(deps) {
  if (overlayEl) return;
  deps.ensureCssLoaded('/css/tour.css');
  const { appState, navigateRoute, showToast } = deps;
  let idx = 0;

  const goHome = () => { if (appState.tabs.find((t) => t.id === appState.activeTabId)?.route !== '/h') navigateRoute('/h'); };

  const STEPS = [
    {
      selector: '#homeSearchForm', ensureView: goHome,
      title: () => { const n = appState.user && (appState.user.displayName || appState.user.username); return n ? `welcome, ${String(n).toLowerCase()}` : 'welcome to astra'; },
      body: 'type any website or search here and astra opens it for you.',
      hint: 'click the highlighted bar to try typing', tryLabel: 'focus search',
      onTry: () => document.getElementById('homeSearchInput')?.focus()
    },
    {
      selector: '#homeAppsRow', ensureView: goHome,
      title: 'quick apps',
      body: 'your shortcuts live here. tap + to add any site, or all apps to see everything astra can open.',
      hint: 'click to open all apps', tryLabel: 'all apps',
      onTry: () => document.getElementById('homeAllAppsBtn')?.click()
    },
    {
      selector: '.rail-btn[data-route="/b"]',
      title: 'browse',
      body: 'open any website here. if a page ever gets stuck, astra fixes it by itself.',
      hint: 'click the globe to open the browser', tryLabel: 'open browse',
      onTry: () => navigateRoute('/b')
    },
    {
      selector: '.rail-btn[data-route="/g"]',
      title: 'games',
      body: '170+ games ready to play, no downloads.',
      hint: 'click the controller to play', tryLabel: 'open games',
      onTry: () => navigateRoute('/g')
    },
    {
      selector: '.rail-btn[data-route="/music"]',
      title: 'music',
      body: 'search any song, see the lyrics and keep the queue going.',
      hint: 'click the headphones to open music', tryLabel: 'open music',
      onTry: () => navigateRoute('/music')
    },
    {
      selector: '#topMiniMusic',
      title: 'mini player',
      body: 'whatever you play keeps going while you browse. control it from up here on any tab.',
      hint: 'prev, play / pause, next and ✕ to unload', tryLabel: null, onTry: null
    },
    {
      selector: '.rail-btn[data-route="/chat"]',
      title: 'chat',
      body: 'group chat with channels and voice. messages stay even after a restart.',
      hint: 'click the bubble to join', tryLabel: 'open chat',
      onTry: () => navigateRoute('/chat')
    },
    {
      selector: '.rail-btn[data-route="/a"]',
      title: 'anime',
      body: 'watch anime free, right inside astra.',
      hint: 'click to watch', tryLabel: 'open anime',
      onTry: () => navigateRoute('/a')
    },
    {
      selector: '.rail-btn[data-route="/roblox"]',
      title: 'roblox',
      body: 'sign in once with your email code and play roblox right in your browser.',
      hint: 'click to set up roblox', tryLabel: 'open roblox',
      onTry: () => navigateRoute('/roblox')
    },
    {
      selector: '.rail-btn[data-route="/s"]',
      title: 'settings',
      body: 'make astra yours: theme, wallpaper, speed and privacy.',
      hint: 'press finish to start using astra', tryLabel: 'open settings',
      onTry: () => navigateRoute('/s')
    }
  ];

  overlayEl = document.createElement('div');
  overlayEl.className = 'tour-backdrop visible';
  overlayEl.innerHTML = `
    <div class="tour-spotlight" id="tourSpot"></div>
    <div class="tour-hotspot" id="tourHot" title="click to interact & advance"></div>
    <svg class="tour-pointer-svg" aria-hidden="true">
      <defs><marker id="tourArrow" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto"><path d="M0 1 8 5 0 9z" fill="var(--accent)"/></marker></defs>
      <path class="tour-pointer-path" id="tourPath" d="" marker-end="url(#tourArrow)"/>
    </svg>
    <div class="tour-card-glow" id="tourCard"><div class="tour-card">
      <div class="tour-head"><span class="tour-badge" id="tourBadge"></span><div class="tour-dots" id="tourDots"></div><button type="button" class="tour-btn" id="tourClose" title="close for now - shows again next visit">close</button></div>
      <div class="tour-title" id="tourTitle"></div>
      <div class="tour-body" id="tourBody"></div>
      <div class="tour-hint" id="tourHint"></div>
      <div class="tour-foot">
        <div class="tour-foot-group"><button type="button" class="tour-btn" id="tourBack">← back</button><button type="button" class="tour-btn" id="tourNever" title="don't show this tutorial on startup">never show again</button></div>
        <div class="tour-foot-group"><button type="button" class="tour-btn" id="tourTry" style="display:none"></button><button type="button" class="tour-btn primary" id="tourNext">next →</button></div>
      </div>
    </div></div>`;
  document.body.appendChild(overlayEl);

  const $ = (id) => overlayEl.querySelector('#' + id);
  const spot = $('tourSpot'), hot = $('tourHot'), card = $('tourCard'), path = $('tourPath');

  const target = () => { const s = STEPS[idx].selector; return typeof s === 'function' ? s() : pick(s); };

  function position() {
    const el = target();
    const vw = innerWidth, vh = innerHeight;
    let tx, ty, tw, th;
    const ok = visible(el);
    if (ok) {
      const r = el.getBoundingClientRect(), pad = 6;
      tx = Math.max(4, r.left - pad); ty = Math.max(4, r.top - pad);
      tw = Math.min(vw - tx - 4, r.width + pad * 2); th = Math.min(vh - ty - 4, r.height + pad * 2);
      Object.assign(spot.style, { opacity: '1', left: tx + 'px', top: ty + 'px', width: tw + 'px', height: th + 'px' });
      Object.assign(hot.style, { display: 'block', left: tx + 'px', top: ty + 'px', width: tw + 'px', height: th + 'px' });
    } else {
      tx = vw / 2 - 40; ty = vh / 2 - 20; tw = 80; th = 40;
      spot.style.opacity = '0'; hot.style.display = 'none';
    }
    const cw = Math.min(440, vw - 24), ch = card.offsetHeight || 225, m = 26;
    let cx, cy;
    if (tx < vw * 0.32 && tx + tw + m + cw < vw - 12) { cx = tx + tw + m; cy = ty + th / 2 - ch / 2; }
    else if (ty + th + m + ch < vh - 12) { cx = tx + tw / 2 - cw / 2; cy = ty + th + m; }
    else if (ty - m - ch > 12) { cx = tx + tw / 2 - cw / 2; cy = ty - m - ch; }
    else { cx = Math.max(12, tx - m - cw); cy = vh / 2 - ch / 2; }
    cx = Math.max(12, Math.min(cx, vw - cw - 12)); cy = Math.max(12, Math.min(cy, vh - ch - 12));
    card.style.left = cx + 'px'; card.style.top = cy + 'px';

    if (ok) {
      const mx = tx + tw / 2, my = ty + th / 2, cmx = cx + cw / 2, cmy = cy + ch / 2;
      const dx = mx - cmx, dy = my - cmy;
      let sx, sy, ex, ey, d;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) { sx = cx + cw; sy = cmy; ex = tx - 5; ey = my; } else { sx = cx; sy = cmy; ex = tx + tw + 5; ey = my; }
        d = `M ${sx} ${sy} C ${sx + (ex - sx) * 0.55} ${sy - 18}, ${ex - (ex - sx) * 0.35} ${ey + 14}, ${ex} ${ey}`;
      } else {
        if (dy > 0) { sx = cmx; sy = cy + ch; ex = mx; ey = ty - 5; } else { sx = cmx; sy = cy; ex = mx; ey = ty + th + 5; }
        d = `M ${sx} ${sy} C ${sx - 18} ${sy + (ey - sy) * 0.55}, ${ex + 18} ${ey - (ey - sy) * 0.35}, ${ex} ${ey}`;
      }
      path.setAttribute('d', d); path.style.opacity = '1';
    } else path.style.opacity = '0';
  }

  function render() {
    const s = STEPS[idx];
    if (typeof s.ensureView === 'function') s.ensureView();
    $('tourBadge').textContent = `step ${idx + 1} of ${STEPS.length}`;
    $('tourTitle').textContent = typeof s.title === 'function' ? s.title() : s.title;
    $('tourBody').textContent = s.body;
    $('tourHint').textContent = s.hint || '';
    const tryBtn = $('tourTry');
    if (s.tryLabel && s.onTry) { tryBtn.style.display = 'inline-flex'; tryBtn.textContent = s.tryLabel; } else tryBtn.style.display = 'none';
    $('tourDots').innerHTML = STEPS.map((_, i) => `<span class="tour-dot ${i === idx ? 'active' : ''}"></span>`).join('');
    $('tourBack').disabled = idx === 0;
    $('tourNext').textContent = idx >= STEPS.length - 1 ? 'finish →' : 'next →';
    position(); requestAnimationFrame(position);
    // views are lazy-loaded; re-measure once they have had time to mount
    setTimeout(position, 120); setTimeout(position, 420);
  }

  async function finish(never) {
    overlayEl?.remove(); overlayEl = null;
    window.removeEventListener('resize', position);
    if (appState.user) appState.user.needsTour = false;
    if (never) {
      try {
        const r = await fetch('/api/auth/tour-done', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ neverShowAgain: true }) });
        if (r.ok) showToast("saved - the tutorial won't show again");
      } catch {}
    }
  }
  teardown = () => finish(false);

  $('tourTry').onclick = () => STEPS[idx].onTry && STEPS[idx].onTry();
  hot.onclick = () => {
    const s = STEPS[idx];
    if (s.onTry) s.onTry();
    if (idx < STEPS.length - 1) setTimeout(() => { if (overlayEl) { idx++; render(); } }, 350);
  };
  $('tourBack').onclick = () => { if (idx > 0) { idx--; render(); } };
  $('tourNext').onclick = () => { if (idx < STEPS.length - 1) { idx++; render(); } else finish(false); };
  $('tourClose').onclick = () => finish(false);
  $('tourNever').onclick = () => finish(true);
  window.addEventListener('resize', position);
  render();
}

export function stopTour() { if (teardown) teardown(); }
