// Lazy-loaded Home Stage View (/h & /): Achroma Cursive Write-Draw Logo + Cherri MOTD + Search + Apps + Clock + Reviews Marquee
import { ICONS } from '/js/icons.js';
const DEFAULT_SHORTCUTS = [
  { name: 'Browse', route: '/b', svg: ICONS.globe },
  { name: 'Games', route: '/g', svg: ICONS.games },
  { name: 'AI', route: '/ai', svg: ICONS.ai },
  { name: 'Music', route: '/music', svg: ICONS.music },
  { name: 'Chat', route: '/chat', svg: ICONS.chat },
  { name: 'Anime', route: '/a', svg: ICONS.anime },
  { name: 'Roblox', route: '/roblox', svg: ICONS.roblox }
];

const ALL_APPS_CATALOG = [
  { name: 'Browse', sub: 'Open any website', route: '/b' },
  { name: 'Games', sub: '170+ games to play', route: '/g' },
  { name: 'Music', sub: 'YouTube music player', route: '/music' },
  { name: 'AI', sub: 'Chat with an AI helper', route: '/ai' },
  { name: 'Chatrooms', sub: 'Group chat with voice', route: '/chat' },
  { name: 'Anime', sub: 'Watch anime free', route: '/a' },
  { name: 'Movies', sub: 'Watch movies & shows', route: '/m' },
  { name: 'Roblox', sub: 'Play Roblox in your browser', route: '/roblox' },
  { name: 'TikTok', sub: 'Watch TikTok', url: 'https://www.tiktok.com/' },
  { name: 'Settings', sub: 'Themes, wallpaper & privacy', route: '/s' }
];

// NOTE: the old stroke-mask trace hero was removed - the mask silently failed and
// rendered an invisible/ugly wordmark. The new hero below is plain visible SVG text
// (gradient + soft glow) with CSS-only entrance animations that can never hide the logo.

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/home.css');

  const cfg = ctx.appState.serverConfig || {};
  const motdPool = Array.isArray(cfg.motdList) && cfg.motdList.length ? cfg.motdList : ['fast. clean. unblocked.'];
  // A fixed admin note always wins. Otherwise the notes take turns cycling on screen.
  const pinnedMotd = (cfg.motd && cfg.motd.trim()) ? cfg.motd.trim() : '';
  let motdIndex = Math.floor(Math.random() * motdPool.length);

  container.innerHTML = `
    <div class="home-stage">
      <div class="home-center-stack">
        <div class="hero-logo-group">
          <div class="hero-clock" id="heroClock">
            <div class="hero-clock-time" id="heroClockTime">--:--</div>
            <div class="hero-clock-date" id="heroClockDate">...</div>
          </div>
          <div class="hero-brand-row">
            <svg class="astra-hero-svg" viewBox="180 53 280 85" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="astra">
              <defs>
                <!-- Wordmark tint: deep shade -> accent -> bright tint, all from the theme.
                     JS repaints the stops when the theme changes, the sweep loop keeps it moving -->
                <linearGradient id="astraHeroGrad" x1="0" y1="1" x2="0.85" y2="0">
                  <stop offset="0%" stop-color="#5c1d30" />
                  <stop offset="52%" stop-color="#ff6b8b" />
                  <stop offset="100%" stop-color="#ffc2cf" />
                  <animateTransform attributeName="gradientTransform" type="translate" values="-0.2 0.12; 0.2 -0.12; -0.2 0.12" keyTimes="0; 0.5; 1" calcMode="spline" keySplines="0.42 0 0.58 1; 0.42 0 0.58 1" dur="9s" repeatCount="indefinite" />
                </linearGradient>
              </defs>

              <!-- Wordmark: always visible, palette-aware gradient + CSS glow (no masks/filters that can silently fail) -->
              <g class="hero-word">
                <text x="320" y="132" text-anchor="middle" font-family="'Plus Jakarta Sans', Inter, sans-serif" font-size="112" font-weight="800" letter-spacing="-3" fill="url(#astraHeroGrad)">astra</text>
              </g>

            </svg>
          </div>
          <div class="hero-motd" id="heroMotd">${ctx.escapeHtml(pinnedMotd || motdPool[motdIndex])}</div>
        </div>

        <form class="home-search-form spot" id="homeSearchForm">
          <span class="home-search-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </span>
          <input class="home-search-input" id="homeSearchInput" type="text" placeholder="Search for anything!" autocomplete="off" autofocus />
          <button type="submit" class="home-search-go" title="Go">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </button>
        </form>

        <div class="apps-row" id="homeAppsRow"></div>

        <div class="status-pills-row">
          <div class="status-pill spot">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span id="homeOnlineCount">${ctx.appState.onlineCount || 1} online</span>
          </div>
          <button type="button" class="status-pill spot" id="homeCommunityBtn">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <span>Join Astra Community <span class="muted">for links &amp; updates</span></span>
          </button>
        </div>

      </div>
    </div>
  `;

  // Search form submit
  container.querySelector('#homeSearchForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = container.querySelector('#homeSearchInput')?.value || '';
    if (val.trim()) ctx.openExternalUrl(val);
  });

  // Render quick apps row + Add + All Apps
  const renderApps = () => {
    const row = container.querySelector('#homeAppsRow');
    if (!row) return;
    const custom = Array.isArray(ctx.appState.shortcuts) ? ctx.appState.shortcuts : [];
    const list = [...DEFAULT_SHORTCUTS, ...custom];
    row.innerHTML = list.map((app, i) => {
      let icon = app.svg || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
      if (app.url && !app.svg) {
        try {
          const dom = new URL(app.url).hostname;
          icon = `<img src="https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(dom)}" alt="" />`;
        } catch {}
      }
      return `
        <button type="button" class="app-tile" data-app-idx="${i}">
          <div class="app-tile-box spot">${icon}</div>
          <span>${ctx.escapeHtml(app.name)}</span>
        </button>
      `;
    }).join('') + `
      <button type="button" class="app-tile" id="homeAddShortcutBtn">
        <div class="app-tile-box dashed">+</div>
        <span>Add</span>
      </button>
      <button type="button" class="app-tile" id="homeAllAppsBtn">
        <div class="app-tile-box spot">
          ${ICONS.apps}
        </div>
        <span>All Apps</span>
      </button>
    `;

    row.querySelectorAll('[data-app-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = list[Number(btn.dataset.appIdx)];
        if (!item) return;
        if (item.route) ctx.navigateRoute(item.route);
        else if (item.url) ctx.openExternalUrl(item.url);
      });
    });

    row.querySelector('#homeAddShortcutBtn')?.addEventListener('click', () => {
      ctx.openModal(`
        <div class="modal-head">
          <span>Add Shortcut</span>
          <button type="button" class="tb-icon-btn" id="mClose">✕</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <label style="font-size:12px;color:var(--text-muted);">Label</label>
          <input class="field-input" id="scLabel" placeholder="e.g., YouTube" />
          <label style="font-size:12px;color:var(--text-muted);">URL or Internal Path</label>
          <input class="field-input" id="scTarget" placeholder="https://youtube.com or /g" />
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
          <button type="button" class="btn" id="mCancel">Cancel</button>
          <button type="button" class="btn btn-accent" id="mSave">Add</button>
        </div>
      `, (card) => {
        card.querySelector('#mClose').onclick = ctx.closeModal;
        card.querySelector('#mCancel').onclick = ctx.closeModal;
        card.querySelector('#mSave').onclick = () => {
          const name = card.querySelector('#scLabel').value.trim().slice(0, 20);
          const raw = card.querySelector('#scTarget').value.trim();
          if (!name || !raw) return ctx.showToast('Enter a label and URL/path');
          if (!Array.isArray(ctx.appState.shortcuts)) ctx.appState.shortcuts = [];
          if (raw.startsWith('/')) ctx.appState.shortcuts.push({ name, route: raw });
          else ctx.appState.shortcuts.push({ name, url: /^https?:\/\//i.test(raw) ? raw : 'https://' + raw });
          ctx.saveUserState();
          renderApps();
          ctx.closeModal();
        };
      });
    });

    row.querySelector('#homeAllAppsBtn')?.addEventListener('click', () => {
      ctx.openModal(`
        <div class="modal-head">
          <span>Apps</span>
          <button type="button" class="tb-icon-btn" id="mClose">✕</button>
        </div>
        <div class="all-apps-grid">
          ${ALL_APPS_CATALOG.map((a, idx) => `
            <button type="button" class="all-app-item" data-catalog-idx="${idx}">
              <div>
                <div style="font-size:13.5px;font-weight:700;">${ctx.escapeHtml(a.name)}</div>
                <div class="all-app-sub">${ctx.escapeHtml(a.sub)}</div>
              </div>
            </button>
          `).join('')}
        </div>
      `, (card) => {
        card.querySelector('#mClose').onclick = ctx.closeModal;
        card.querySelectorAll('[data-catalog-idx]').forEach((b) => {
          b.onclick = () => {
            const pick = ALL_APPS_CATALOG[Number(b.dataset.catalogIdx)];
            ctx.closeModal();
            if (pick.route) ctx.navigateRoute(pick.route);
            else if (pick.url) ctx.openExternalUrl(pick.url);
          };
        });
      });
    });
  };
  renderApps();

  container.querySelector('#homeCommunityBtn')?.addEventListener('click', () => ctx.navigateRoute('/chat'));

  // Live time + date, sitting in the gap between the wordmark and the notes
  const updateClock = () => {
    const timeEl = container.querySelector('#heroClockTime');
    const dateEl = container.querySelector('#heroClockDate');
    if (!timeEl || !dateEl) return;
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };
  updateClock();
  const clockTimer = setInterval(updateClock, 1000);

  // Notes cycle: fade out, swap text, fade back in, forever
  let motdTimer = null;
  if (!pinnedMotd && motdPool.length > 1) {
    const motdEl = container.querySelector('#heroMotd');
    motdTimer = setInterval(() => {
      if (!motdEl || !document.body.contains(motdEl)) { clearInterval(motdTimer); return; }
      motdIndex = (motdIndex + 1) % motdPool.length;
      motdEl.classList.add('motd-out');
      setTimeout(() => {
        if (!document.body.contains(motdEl)) return;
        motdEl.textContent = motdPool[motdIndex];
        motdEl.classList.remove('motd-out');
      }, 220);
    }, 9000);
  }

  // Wordmark tint comes straight from the theme accent, exactly like Cherri's logo.
  // No wallpaper sampling - the logo always matches the theme.
  const heroSvg = container.querySelector('.astra-hero-svg');
  const heroStops = heroSvg ? Array.from(heroSvg.querySelectorAll('#astraHeroGrad stop')) : [];
  if (heroSvg && heroStops.length >= 3) {
    const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const mixRgb = (a, b, t) => a.map((v, i) => clampByte(v + (b[i] - v) * t));
    // Static accent table keyed by theme id. Reading the live CSS custom property
    // mid-transition returned half-blended colors and made the wordmark lag behind.
    const THEME_ACCENTS = {
      rose: [255, 107, 139],
      midnight: [124, 140, 255],
      void: [244, 244, 247],
      nord: [136, 192, 208],
      forest: [74, 222, 128],
      sunset: [251, 146, 60]
    };
    const paintPalette = () => {
      const key = document.documentElement.getAttribute('data-theme') || 'void';
      const accent = THEME_ACCENTS[key] || THEME_ACCENTS.void;
      const darkStop = mixRgb(accent, [10, 4, 6], 0.62);
      const brightStop = mixRgb(accent, [255, 255, 255], 0.42);
      const midStop = mixRgb(darkStop, brightStop, 0.5);
      heroStops[0].setAttribute('stop-color', `rgb(${darkStop.join(',')})`);
      heroStops[1].setAttribute('stop-color', `rgb(${midStop.join(',')})`);
      heroStops[2].setAttribute('stop-color', `rgb(${brightStop.join(',')})`);
      heroSvg.style.setProperty('--hero-glow', `rgb(${brightStop.join(',')})`);
    };
    paintPalette();
    // Repaint when the user picks a different theme
    const themeWatch = new MutationObserver(paintPalette);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const unwatchPalette = () => themeWatch.disconnect();
  }

  return () => {
    clearInterval(clockTimer);
    if (motdTimer) clearInterval(motdTimer);
    if (typeof unwatchPalette === 'function') unwatchPalette();
  };
}
