// Lazy-loaded Anime Provider Selection Hub (/a) - opens providers THROUGH the proxy
const BUILTIN_PROVIDERS = [
  { id: 'animekai-1', name: 'AnimeKai 1', url: 'https://animekai.be', description: 'Current AnimeKai destination.', order: 1, enabled: true, hue: 335 },
  { id: 'animekai-2', name: 'AnimeKai 2', url: 'https://animekai.com.ro', description: 'Alternative AnimeKai destination.', order: 2, enabled: true, hue: 285 },
  { id: 'crunchyroll', name: 'Crunchyroll', url: 'https://www.crunchyroll.com', description: 'Official anime streaming platform.', order: 3, enabled: true, hue: 15 },
  { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com', description: 'Anime and other entertainment.', order: 4, enabled: true, hue: 355 }
];

const initialsFor = (name) => {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const one = String(name || '?').replace(/[^A-Za-z0-9]/g, '');
  return (one.slice(0, 2) || '?').toUpperCase();
};

// Brand banner art - the user's real reference assets (downloaded brand imagery),
// served from /assets/anime and cover-fitted into each banner.
const BRAND_ART = {
  'animekai-1': `<img class="prov-art" src="/assets/anime/animekai-ref.jpg" alt="AnimeKai" draggable="false" />`,
  'animekai-2': `<img class="prov-art" src="/assets/anime/animekai-ref.jpg" alt="AnimeKai" draggable="false" />`,
  'crunchyroll': `<img class="prov-art" src="/assets/anime/crunchyroll-ref.jpg" alt="Crunchyroll" draggable="false" />`,
  'netflix': `<img class="prov-art" src="/assets/anime/netflix-ref.jpg" alt="Netflix" draggable="false" />`
};

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/views.css');

  let rememberPref = false;
  let preferredId = '';
  let customProviders = [];

  try {
    const r = await fetch('/api/user/preferences', { credentials: 'same-origin' });
    if (r.ok) {
      const j = await r.json();
      const p = j?.preferences || {};
      rememberPref = !!p.rememberAnimeProvider;
      preferredId = String(p.preferredAnimeProvider || '');
      customProviders = Array.isArray(p.customAnimeProviders) ? p.customAnimeProviders : [];
    }
  } catch {}

  const allProviders = [...BUILTIN_PROVIDERS, ...customProviders].filter((p) => p.enabled !== false).sort((a, b) => (a.order || 99) - (b.order || 99));

  function openProvider(p) {
    if (!p || !/^https?:\/\//i.test(p.url)) return;
    if (rememberPref) {
      fetch('/api/user/preferences', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rememberAnimeProvider: true, preferredAnimeProvider: p.id })
      }).catch(() => {});
    }
    // Load INSIDE Astra's proxy browser (scramjet) - never a raw new tab
    ctx.openExternalUrl(p.url, { title: p.name, engineOverride: 'scramjet' });
  }

  const savedPick = rememberPref && preferredId ? allProviders.find((x) => x.id === preferredId) : null;

  container.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Anime</h1>
          <div class="page-sub">Watch anime right inside Astra, on any network</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text);cursor:pointer;">
            <input type="checkbox" id="rememberAnimeChk" ${rememberPref ? 'checked' : ''} style="accent-color:var(--accent);" />
            <span>Remember my default</span>
          </label>
          <button type="button" class="btn" id="addCustomProviderBtn">+ Add Provider</button>
        </div>
      </div>

      ${savedPick ? `
        <div class="prov-feature spot">
          <div class="prov-feature-glyph" style="background:linear-gradient(135deg, hsl(${savedPick.hue || 265} 70% 58%), hsl(${(savedPick.hue || 265) + 28} 70% 44%));">${ctx.escapeHtml(initialsFor(savedPick.name))}</div>
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:800;color:var(--bright-text);">Default: ${ctx.escapeHtml(savedPick.name)}</div>
            <div style="font-size:11.5px;color:var(--text-muted);">${ctx.escapeHtml(savedPick.url)} &bull; opens in Astra</div>
          </div>
          <button type="button" class="btn btn-accent" id="openSavedAnimeBtn">Open ${ctx.escapeHtml(savedPick.name)} &rarr;</button>
        </div>
      ` : ''}

      <div class="cards-grid prov-grid" id="animeProvidersGrid">
        ${allProviders.map((p) => {
          const isPreferred = savedPick && savedPick.id === p.id;
          const isCustom = String(p.id || '').startsWith('custom-');
          const hue = Number.isFinite(p.hue) ? p.hue : 265;
          const art = BRAND_ART[String(p.id || '')] || null;
          return `
            <div class="prov-card spot ${isPreferred ? 'preferred' : ''}">
              <div class="prov-banner ${art ? 'has-art' : ''}" style="--h:${hue};">
                ${art || `<span class="prov-banner-glyph">${ctx.escapeHtml(initialsFor(p.name))}</span>`}
                <span class="prov-live" data-check-url="${ctx.escapeHtml(p.url)}">
                  <span class="prov-status-dot checking"></span><span class="prov-status-text">checking</span>
                </span>
              </div>
              <div class="prov-body">
                <div class="prov-name">${ctx.escapeHtml(p.name)}${isPreferred ? ' <span class="prov-tag">Default</span>' : ''}</div>
                <div class="prov-desc">${ctx.escapeHtml(p.description || '')}</div>
                <div class="prov-url">${ctx.escapeHtml(p.url)}</div>
                <div class="prov-foot">
                  <button type="button" class="btn btn-accent" data-open-prov="${ctx.escapeHtml(p.id)}" style="flex:1;">Open</button>
                  ${isCustom ? `<button type="button" class="prov-remove-btn" data-remove-prov="${ctx.escapeHtml(p.id)}" title="Remove provider">&times;</button>` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  container.querySelector('#openSavedAnimeBtn')?.addEventListener('click', () => openProvider(savedPick));
  container.querySelectorAll('[data-open-prov]').forEach((b) => {
    b.onclick = () => {
      const hit = allProviders.find((x) => x.id === b.dataset.openProv);
      openProvider(hit);
    };
  });
  container.querySelectorAll('[data-remove-prov]').forEach((b) => {
    b.onclick = async () => {
      customProviders = customProviders.filter((x) => x.id !== b.dataset.removeProv);
      await fetch('/api/user/preferences', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customAnimeProviders: customProviders })
      });
      ctx.showToast('Provider removed');
      mount(container, ctx);
    };
  });
  container.querySelector('#rememberAnimeChk')?.addEventListener('change', async (e) => {
    rememberPref = !!e.target.checked;
    await fetch('/api/user/preferences', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rememberAnimeProvider: rememberPref, preferredAnimeProvider: rememberPref ? preferredId : '' })
    });
    if (rememberPref && !preferredId) ctx.showToast('Open a provider once to set it as your default');
    mount(container, ctx);
  });

  container.querySelector('#addCustomProviderBtn')?.addEventListener('click', () => {
    ctx.openModal(`
      <div class="modal-head"><span>Add Custom Anime Provider</span><button type="button" class="tb-icon-btn" id="mClose">&times;</button></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <input class="field-input" id="apName" placeholder="Provider name" />
        <input class="field-input" id="apUrl" placeholder="https://..." />
        <input class="field-input" id="apDesc" placeholder="Short description" />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" id="mCancel">Cancel</button>
        <button type="button" class="btn btn-accent" id="mAdd">Save</button>
      </div>
    `, (card) => {
      card.querySelector('#mClose').onclick = ctx.closeModal;
      card.querySelector('#mCancel').onclick = ctx.closeModal;
      card.querySelector('#mAdd').onclick = async () => {
        const name = card.querySelector('#apName').value.trim();
        const url = card.querySelector('#apUrl').value.trim();
        const description = card.querySelector('#apDesc').value.trim();
        if (!name || !/^https?:\/\//i.test(url)) return ctx.showToast('Valid http/https URL required');
        customProviders.push({ id: 'custom-' + Date.now(), name, url, description, enabled: true, order: 100, hue: Math.floor(Math.random() * 360) });
        await fetch('/api/user/preferences', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customAnimeProviders: customProviders })
        });
        ctx.closeModal();
        mount(container, ctx);
      };
    });
  });

  // Reachability checks -> live status pill on each banner
  container.querySelectorAll('[data-check-url]').forEach(async (el) => {
    const dot = el.querySelector('.prov-status-dot');
    const txt = el.querySelector('.prov-status-text');
    try {
      const r = await fetch(`/api/anime/check?url=${encodeURIComponent(el.dataset.checkUrl)}`, { credentials: 'same-origin' });
      const j = await r.json();
      if (dot) dot.className = `prov-status-dot ${j.reachable ? 'ok' : 'warn'}`;
      if (txt) txt.textContent = j.reachable ? 'live' : 'unverified';
    } catch {
      if (dot) dot.className = 'prov-status-dot warn';
      if (txt) txt.textContent = 'unverified';
    }
  });
}
