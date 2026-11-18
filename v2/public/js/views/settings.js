// Lazy-loaded Cherri-Style Settings View (/s): Appearance, Proxy/DNS 1.1.1.1, Device Spoofer & Cookie Sync
import {
  DEVICE_UA_PRESETS, switchTransport, syncIdentityToSw,
  restoreProxyCookiesFromAccount, scheduleProxyCookieUpload
} from '/js/proxy-engine.js';
import { getCloak, setCloak } from '/js/cloak.js';
import { guardOn, setGuard } from '/js/guard.js';

const THEMES = [
  { id: 'rose', name: 'Cherri', color: '#ff6b8b' },
  { id: 'midnight', name: 'Astra Midnight', color: '#7c8cff' },
  { id: 'void', name: 'Obsidian Void', color: '#f4f4f7' },
  { id: 'nord', name: 'Nord Frost', color: '#88c0d0' },
  { id: 'forest', name: 'Forest Emerald', color: '#4ade80' },
  { id: 'sunset', name: 'Sunset Ember', color: '#fb923c' }
];

const WALLPAPERS = [
  { id: 'dot-grid', label: 'Dot Grid (60fps)' },
  { id: 'lunar-moon', label: 'Lunar Moon' },
  { id: 'black-hole', label: 'Black Hole' },
  { id: 'solar-eclipse', label: 'Solar Eclipse' },
  { id: 'saturn-cosmos', label: 'Saturn Cosmos' },
  { id: 'milky-way', label: 'Milky Way' },
  { id: 'achromaon', label: 'ACH Campus' },
  { id: 'achromaon-hero', label: 'ACH Hero' },
  { id: 'achromaon-bg', label: 'ACH Background (video)' },
  { id: 'backrooms', label: 'Backrooms (video)' },
  { id: 'electric-space', label: 'Electric Space (video)' },
  { id: 'bw-topo', label: 'BW Topo (video)' }
];

let activeSection = 'appearance';

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/views.css');

  const isAdmin = ctx.appState.user?.role === 'admin';
  container.addEventListener('click', (e) => { if (e.target.closest('#replayTourBtn')) window.dispatchEvent(new Event('astra:start-tour')); });

  function render() {
    const cfg = ctx.appState.serverConfig || {};
    const cloak = getCloak();
    const guard = guardOn();
    container.innerHTML = `
      <div class="page-wrap">
        <div class="page-header">
          <div>
            <h1 class="page-title">Settings</h1>
            <div class="page-sub">Theme, wallpaper, speed and privacy</div>
          </div>
        </div>

        <div class="settings-grid">
          <div class="settings-nav">
            <button type="button" class="settings-nav-btn ${activeSection === 'appearance' ? 'active' : ''}" data-ssec="appearance">Appearance</button>
            <button type="button" class="settings-nav-btn ${activeSection === 'wallpaper' ? 'active' : ''}" data-ssec="wallpaper">Wallpaper</button>
            <button type="button" class="settings-nav-btn ${activeSection === 'proxy' ? 'active' : ''}" data-ssec="proxy">Speed</button>
            <button type="button" class="settings-nav-btn ${activeSection === 'spoof' ? 'active' : ''}" data-ssec="spoof">Privacy</button>
            <button type="button" class="settings-nav-btn ${activeSection === 'cloak' ? 'active' : ''}" data-ssec="cloak">Cloak</button>
            <button type="button" class="settings-nav-btn ${activeSection === 'cookies' ? 'active' : ''}" data-ssec="cookies">Logins</button>
          </div>

          <div class="settings-panel">
            ${activeSection === 'appearance' ? `
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Theme</div>
                <div class="theme-swatches">
                  ${THEMES.map((t) => `
                    <button type="button" class="theme-swatch ${ctx.appState.theme === t.id ? 'active' : ''}" data-pick-theme="${t.id}">
                      <span class="swatch-dot" style="background:${t.color};"></span>
                      <span>${t.name}</span>
                    </button>
                  `).join('')}
                </div>
              </div>
              <div class="surface-card"><div style="font-size:15px;font-weight:700;color:var(--bright-text);">Tutorial</div><div class="page-sub">Replay the interactive tour of Astra.</div><div class="seg-row"><button type="button" class="seg-btn" id="replayTourBtn">Replay tutorial</button></div></div>
            ` : ''}

            ${activeSection === 'wallpaper' ? `
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Built-in Styles</div>
                <div class="page-sub">Pick a background. Videos play muted and loop.</div>
                <div class="seg-row">
                  ${WALLPAPERS.map((w) => `
                    <button type="button" class="seg-btn ${ctx.appState.wallpaper === w.id ? 'active' : ''}" data-pick-wp="${w.id}">${w.label}</button>
                  `).join('')}
                  ${ctx.appState.wallpaperVideo && ctx.appState.wallpaperVideo.id ? `
                    <button type="button" class="seg-btn ${ctx.appState.wallpaper === 'yt-video' ? 'active' : ''}" data-pick-wp="yt-video" title="${ctx.escapeHtml(ctx.appState.wallpaperVideo.title || '')}">▶ ${ctx.escapeHtml(String(ctx.appState.wallpaperVideo.title || 'YouTube video').slice(0, 26))}</button>
                  ` : ''}
                </div>
                ${ctx.appState.wallpaper === 'yt-video' && ctx.appState.wallpaperVideo && ctx.appState.wallpaperVideo.id ? `
                  <div class="wp-active-row">
                    <img src="${ctx.escapeHtml(ctx.appState.wallpaperVideo.thumb || '')}" alt="" onerror="this.style.display='none'" />
                    <div style="min-width:0;flex:1;">
                      <div style="font-size:12.5px;font-weight:700;color:var(--bright-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ctx.escapeHtml(ctx.appState.wallpaperVideo.title || 'YouTube video')}</div>
                      <div style="font-size:11px;color:var(--text-muted);">No ads &bull; muted &amp; looped</div>
                    </div>
                    <button type="button" class="btn" id="wpStopVideoBtn">Stop video</button>
                  </div>
                ` : ''}
              </div>

              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">YouTube Video Background</div>
                <div class="page-sub">Search any YouTube video and set it as your animated background. No ads, no tracking, plays muted on a loop.</div>
                <form class="wp-search-row" id="wpSearchForm">
                  <input class="field-input" id="wpSearchInput" placeholder="e.g. falling snow loop, lofi rain window, neon city night..." autocomplete="off" />
                  <button class="btn btn-accent" type="submit">Search</button>
                </form>
                <div class="wp-video-grid" id="wpVideoGrid"></div>
              </div>
            ` : ''}

            ${activeSection === 'proxy' ? `
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">How websites load</div>
                <div class="page-sub">Scramjet is the fast way to load sites. If a site ever gets stuck or goes blank, Astra quietly switches to Ultraviolet on its own.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.engine === 'scramjet' ? 'active' : ''}" data-eng="scramjet">Scramjet (Recommended)</button>
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.engine === 'ultraviolet' ? 'active' : ''}" data-eng="ultraviolet">Ultraviolet</button>
                </div>
              </div>

              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Connection type</div>
                <div class="page-sub">Two ways to carry the connection. Only change this if a site refuses to load.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.transport === 'libcurl' ? 'active' : ''}" data-tr="libcurl">Type A</button>
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.transport === 'epoxy' ? 'active' : ''}" data-tr="epoxy">Type B</button>
                </div>
              </div>

              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Ad blocking</div>
                <div class="page-sub">Most ads are filtered out before they even load. Pick how strong you want it.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${cfg.dnsMode === 'cloudflare' ? 'active' : ''}" data-dns="cloudflare" ${!isAdmin ? 'title="Set by your admin"' : ''}>Standard</button>
                  <button type="button" class="seg-btn ${cfg.dnsMode === 'cloudflare-sec' ? 'active' : ''}" data-dns="cloudflare-sec">Blocks malware too</button>
                  <button type="button" class="seg-btn ${cfg.dnsMode === 'adguard' ? 'active' : ''}" data-dns="adguard">Blocks most ads</button>
                </div>
                <div class="seg-row" style="margin-top:4px;">
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.adblock ? 'active' : ''}" id="toggleSwAdblockBtn">Block ads in pages: ${ctx.proxyPrefs.adblock ? 'ON' : 'OFF'}</button>
                  <button type="button" class="seg-btn ${cfg.dnsAdFilter !== false ? 'active' : ''}" id="toggleDnsFilterBtn">Block ad domains: ${cfg.dnsAdFilter !== false ? 'ON' : 'OFF'}</button>
                </div>
              </div>
            ` : ''}

            ${activeSection === 'spoof' ? `
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">What websites see</div>
                <div class="page-sub">By default websites see your real device. Hide it and they see a different one instead.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.identityMode === 'mirror' ? 'active' : ''}" data-idmode="mirror">Real device</button>
                  <button type="button" class="seg-btn ${ctx.proxyPrefs.identityMode === 'disguise' ? 'active' : ''}" data-idmode="disguise">Hidden</button>
                </div>
              </div>
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Pretend to be</div>
                <div class="seg-row">
                  ${Object.entries(DEVICE_UA_PRESETS).map(([k, p]) => `
                    <button type="button" class="seg-btn ${ctx.proxyPrefs.devicePreset === k ? 'active' : ''}" data-preset="${k}">${p.label}</button>
                  `).join('')}
                </div>
                <div style="margin-top:8px;">
                  <input class="field-input" id="customUaInput" placeholder="Or type your own device string..." value="${ctx.escapeHtml(ctx.proxyPrefs.customUa || '')}" />
                </div>
              </div>
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Page guard</div>
                <div class="page-sub">Stops the shortcuts that open the developer tools or the page source, stops the right click menu, and covers the page with the cloak if the tools are opened anyway.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${guard ? 'active' : ''}" data-guard-on="1">On</button>
                  <button type="button" class="seg-btn ${!guard ? 'active' : ''}" data-guard-on="0">Off</button>
                </div>
              </div>
            ` : ''}

            ${activeSection === 'cloak' ? `
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Tab cloak</div>
                <div class="page-sub">The tab at the top of the browser shows this name and icon instead of whatever page you have open.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${cloak.on ? 'active' : ''}" data-cloak-on="1">On</button>
                  <button type="button" class="seg-btn ${!cloak.on ? 'active' : ''}" data-cloak-on="0">Off</button>
                </div>
              </div>
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">What the tab says</div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                  <input class="field-input" id="cloakTitleInput" placeholder="Clever" value="${ctx.escapeHtml(cloak.title)}" style="max-width:200px;" />
                  <input class="field-input" id="cloakIconInput" placeholder="Leave empty for the Clever icon" value="${ctx.escapeHtml(cloak.icon)}" style="max-width:320px;" />
                  <button type="button" class="btn" id="cloakSaveBtn">Save</button>
                </div>
              </div>
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">When you click away</div>
                <div class="page-sub">Click another window and the whole page turns into Clever. The first click back in returns you to the app.</div>
                <div class="seg-row">
                  <button type="button" class="seg-btn ${cloak.shield ? 'active' : ''}" data-shield-on="1">On</button>
                  <button type="button" class="seg-btn ${!cloak.shield ? 'active' : ''}" data-shield-on="0">Off</button>
                </div>
              </div>
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Open a link cloaked</div>
                <div class="page-sub">Paste any link. It opens in Astra with the tab above, not the site's own name.</div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                  <input class="field-input" id="cloakLinkInput" placeholder="Paste a link" />
                  <button type="button" class="btn btn-accent" id="cloakOpenBtn">Open it</button>
                </div>
              </div>
            ` : ''}

            ${activeSection === 'cookies' ? `
              <div class="surface-card">
                <div style="font-size:15px;font-weight:700;color:var(--bright-text);">Stay signed in everywhere</div>
                <div class="page-sub">Websites you sign into in Astra are saved to your account (${ctx.escapeHtml(ctx.appState.user?.username || 'user')}), so you're still signed in on any other computer.</div>
                <div class="seg-row">
                  <button type="button" class="btn btn-accent" id="syncCookiesNowBtn">Save my logins now</button>
                  <button type="button" class="btn" id="restoreCookiesNowBtn">Bring my logins here</button>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('[data-ssec]').forEach((b) => {
      b.onclick = () => { activeSection = b.dataset.ssec; render(); };
    });
    container.querySelectorAll('[data-pick-theme]').forEach((b) => {
      b.onclick = () => { ctx.applyTheme(b.dataset.pickTheme); ctx.saveUserState(); render(); };
    });
    container.querySelectorAll('[data-pick-wp]').forEach((b) => {
      b.onclick = () => { ctx.applyWallpaper(b.dataset.pickWp); ctx.saveUserState(); render(); };
    });

    // Tab cloak: name and icon in the browser tab, and a way to open a pasted link
    // under that tab.
    container.querySelectorAll('[data-cloak-on]').forEach((b) => {
      b.onclick = () => {
        const on = b.dataset.cloakOn === '1';
        setCloak({ on });
        ctx.showToast(on ? 'Tab cloak on' : 'Tab cloak off');
        render();
      };
    });
    container.querySelectorAll('[data-shield-on]').forEach((b) => {
      b.onclick = () => {
        const on = b.dataset.shieldOn === '1';
        setCloak({ shield: on });
        ctx.showToast(on ? 'Covers the page when you click away' : 'Cover off');
        render();
      };
    });
    container.querySelectorAll('[data-guard-on]').forEach((b) => {
      b.onclick = () => {
        const on = b.dataset.guardOn === '1';
        setGuard(on);
        ctx.showToast(on ? 'Page guard on' : 'Page guard off');
        render();
      };
    });
    const cloakSave = container.querySelector('#cloakSaveBtn');
    if (cloakSave) {
      cloakSave.onclick = () => {
        const title = container.querySelector('#cloakTitleInput').value;
        const icon = container.querySelector('#cloakIconInput').value;
        const saved = setCloak({ title, icon });
        container.querySelector('#cloakTitleInput').value = saved.title;
        container.querySelector('#cloakIconInput').value = saved.icon;
        ctx.showToast('Tab cloak saved');
      };
    }
    const cloakOpen = container.querySelector('#cloakOpenBtn');
    if (cloakOpen) {
      const openLink = () => {
        const input = container.querySelector('#cloakLinkInput');
        const val = input.value.trim();
        if (!val) { input.focus(); return ctx.showToast('Paste a link first'); }
        setCloak({ on: true });
        ctx.openExternalUrl(val);
      };
      cloakOpen.onclick = openLink;
      const linkInput = container.querySelector('#cloakLinkInput');
      if (linkInput) linkInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); openLink(); } };
    }

    // Wallpaper tab: YouTube video background search
    const renderVideoGrid = (results, activeId) => {
      const grid = container.querySelector('#wpVideoGrid');
      if (!grid) return;
      if (!Array.isArray(results) || !results.length) {
        grid.innerHTML = '<div class="page-sub" style="margin:2px 0 0;">Search above, then click a video to set it as your animated background.</div>';
        return;
      }
      grid.innerHTML = results.map((r) => {
        const active = activeId && r.id === activeId;
        return `
          <button type="button" class="wp-video-card spot ${active ? 'active' : ''}" data-wpvid="${ctx.escapeHtml(r.id)}" data-wptitle="${ctx.escapeHtml(r.title || '')}" data-wpartist="${ctx.escapeHtml(r.artist || '')}" data-wpthumb="${ctx.escapeHtml(r.thumbnail || '')}">
            <img src="${ctx.escapeHtml(r.thumbnail || '')}" alt="" loading="lazy" />
            <div class="wp-video-meta">
              <strong>${ctx.escapeHtml(r.title || 'Untitled')}</strong>
              <span>${ctx.escapeHtml(r.artist || 'YouTube')}${r.duration ? ' &bull; ' + ctx.escapeHtml(r.duration) : ''}</span>
            </div>
            <span class="wp-card-tag">${active ? 'Active ✓' : 'Set as background'}</span>
          </button>
        `;
      }).join('');
      grid.querySelectorAll('[data-wpvid]').forEach((b) => {
        b.onclick = () => {
          ctx.appState.wallpaperVideo = {
            id: b.dataset.wpvid,
            title: b.dataset.wptitle,
            channel: b.dataset.wpartist,
            thumb: b.dataset.wpthumb
          };
          ctx.applyWallpaper('yt-video');
          ctx.saveUserState();
          ctx.showToast('Background video set - no ads, no tracking');
          render();
        };
      });
    };
    renderVideoGrid([], null);
    container.querySelector('#wpSearchForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = container.querySelector('#wpSearchInput');
      const q = (input?.value || '').trim();
      if (!q) return ctx.showToast('Type something to search');
      const grid = container.querySelector('#wpVideoGrid');
      if (grid) grid.innerHTML = '<div class="page-sub" style="margin:2px 0 0;">Searching YouTube…</div>';
      try {
        const r = await fetch(`/api/wallpaper/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'search failed');
        renderVideoGrid(j.results, ctx.appState.wallpaper === 'yt-video' ? ctx.appState.wallpaperVideo?.id : null);
      } catch (err) {
        renderVideoGrid([], null);
        ctx.showToast(err.message || 'Wallpaper search failed');
      }
    });
    container.querySelector('#wpStopVideoBtn')?.addEventListener('click', () => {
      ctx.applyWallpaper('dot-grid');
      ctx.saveUserState();
      render();
      ctx.showToast('Video background stopped');
    });

    container.querySelectorAll('[data-eng]').forEach((b) => {
      b.onclick = () => { ctx.proxyPrefs.engine = b.dataset.eng; ctx.saveUserState(); render(); ctx.showToast('Saved'); };
    });
    container.querySelectorAll('[data-tr]').forEach((b) => {
      b.onclick = async () => {
        await switchTransport(b.dataset.tr);
        ctx.saveUserState();
        render();
        ctx.showToast('Saved');
      };
    });
    container.querySelectorAll('[data-dns]').forEach((b) => {
      b.onclick = async () => {
        if (!isAdmin) return ctx.showToast('Only the admin can change this');
        const r = await fetch('/api/admin/config', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dnsMode: b.dataset.dns })
        });
        const j = await r.json();
        if (r.ok && j.ok) {
          ctx.appState.serverConfig = { ...ctx.appState.serverConfig, ...j.serverConfig };
          render();
          ctx.showToast('Saved');
        }
      };
    });
    container.querySelector('#toggleSwAdblockBtn')?.addEventListener('click', () => {
      ctx.proxyPrefs.adblock = !ctx.proxyPrefs.adblock;
      syncIdentityToSw();
      ctx.saveUserState();
      render();
    });
    container.querySelector('#toggleDnsFilterBtn')?.addEventListener('click', async () => {
      if (!isAdmin) return ctx.showToast('Only the admin can change this');
      const next = cfg.dnsAdFilter === false;
      const r = await fetch('/api/admin/config', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dnsAdFilter: next })
      });
      const j = await r.json();
      if (r.ok && j.ok) {
        ctx.appState.serverConfig = { ...ctx.appState.serverConfig, ...j.serverConfig };
        render();
      }
    });
    container.querySelectorAll('[data-idmode]').forEach((b) => {
      b.onclick = () => {
        ctx.proxyPrefs.identityMode = b.dataset.idmode;
        syncIdentityToSw();
        ctx.saveUserState();
        render();
      };
    });
    container.querySelectorAll('[data-preset]').forEach((b) => {
      b.onclick = () => {
        ctx.proxyPrefs.devicePreset = b.dataset.preset;
        if (b.dataset.preset !== 'default') ctx.proxyPrefs.identityMode = 'disguise';
        syncIdentityToSw();
        ctx.saveUserState();
        render();
        ctx.showToast(`Device spoof: ${DEVICE_UA_PRESETS[b.dataset.preset]?.label || b.dataset.preset}`);
      };
    });
    container.querySelector('#customUaInput')?.addEventListener('change', (e) => {
      ctx.proxyPrefs.customUa = e.target.value.trim();
      if (ctx.proxyPrefs.customUa) {
        ctx.proxyPrefs.devicePreset = 'custom';
        ctx.proxyPrefs.identityMode = 'disguise';
      }
      syncIdentityToSw();
      ctx.saveUserState();
      ctx.showToast('Saved custom User-Agent');
    });
    container.querySelector('#syncCookiesNowBtn')?.addEventListener('click', () => {
      scheduleProxyCookieUpload();
      ctx.showToast('Logins saved to your account!');
    });
    container.querySelector('#restoreCookiesNowBtn')?.addEventListener('click', async () => {
      await restoreProxyCookiesFromAccount();
      ctx.showToast('Logins restored!');
    });
  }

  render();
}

