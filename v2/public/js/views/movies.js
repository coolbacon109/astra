// Lazy-loaded Movies Provider Selection Hub (/m) - opens providers THROUGH the proxy
const BUILTIN_PROVIDERS = [
  { id: 'streamex', name: 'StreamEx', url: 'https://www.streamex.hn', description: 'The main movie site Astra has always opened.', order: 1, enabled: true, hue: 350 },
  { id: 'literaryhub', name: 'LiteraryHub', url: 'https://s3.amazonaws.com/angelfern/index.html?route=%2Fsearch%3Fquery%3DaHR0cHM6Ly9tLmZlcm4uYmVzdA%253D%253D%26v%3D%25221%2522', description: 'Opens the fern search with movies ready to browse.', order: 2, enabled: true, hue: 205 },
  { id: 'youshows', name: 'YouShows', url: 'https://youshows.org', description: 'Movies and shows, found inside the ACH site.', order: 3, enabled: true, hue: 24 }
];

const initialsFor = (name) => {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const one = String(name || '?').replace(/[^A-Za-z0-9]/g, '');
  return (one.slice(0, 2) || '?').toUpperCase();
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
      rememberPref = !!p.rememberMovieProvider;
      preferredId = String(p.preferredMovieProvider || '');
      customProviders = Array.isArray(p.customMovieProviders) ? p.customMovieProviders : [];
    }
  } catch {}

  const allProviders = [...BUILTIN_PROVIDERS, ...customProviders].filter((p) => p.enabled !== false).sort((a, b) => (a.order || 99) - (b.order || 99));

  function openProvider(p) {
    if (!p || !/^https?:\/\//i.test(p.url)) return;
    if (rememberPref) {
      fetch('/api/user/preferences', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rememberMovieProvider: true, preferredMovieProvider: p.id })
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
          <h1 class="page-title">Movies</h1>
          <div class="page-sub">Watch movies right inside Astra, on any network</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <label style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text);cursor:pointer;">
            <input type="checkbox" id="rememberMovieChk" ${rememberPref ? 'checked' : ''} style="accent-color:var(--accent);" />
            <span>Remember my default</span>
          </label>
          <button type="button" class="btn" id="addCustomMovieBtn">+ Add Provider</button>
        </div>
      </div>

      ${savedPick ? `
        <div class="prov-feature spot">
          <div class="prov-feature-glyph" style="background:linear-gradient(135deg, hsl(${savedPick.hue || 350} 70% 58%), hsl(${(savedPick.hue || 350) + 28} 70% 44%));">${ctx.escapeHtml(initialsFor(savedPick.name))}</div>
          <div style="min-width:0;flex:1;">
            <div style="font-size:13.5px;font-weight:800;color:var(--bright-text);">Default: ${ctx.escapeHtml(savedPick.name)}</div>
            <div style="font-size:11.5px;color:var(--text-muted);">${ctx.escapeHtml(savedPick.url)} &bull; opens in Astra</div>
          </div>
          <button type="button" class="btn btn-accent" id="openSavedMovieBtn">Open ${ctx.escapeHtml(savedPick.name)} &rarr;</button>
        </div>
      ` : ''}

      <div class="cards-grid prov-grid" id="movieProvidersGrid">
        ${allProviders.map((p) => {
          const isPreferred = savedPick && savedPick.id === p.id;
          const isCustom = String(p.id || '').startsWith('custom-');
          const hue = Number.isFinite(p.hue) ? p.hue : 350;
          return `
            <div class="prov-card spot ${isPreferred ? 'preferred' : ''}">
              <div class="prov-banner" style="--h:${hue};">
                <span class="prov-banner-glyph">${ctx.escapeHtml(initialsFor(p.name))}</span>
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

  container.querySelector('#openSavedMovieBtn')?.addEventListener('click', () => openProvider(savedPick));
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
        body: JSON.stringify({ customMovieProviders: customProviders })
      });
      ctx.showToast('Provider removed');
      mount(container, ctx);
    };
  });
  container.querySelector('#rememberMovieChk')?.addEventListener('change', async (e) => {
    rememberPref = !!e.target.checked;
    await fetch('/api/user/preferences', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rememberMovieProvider: rememberPref, preferredMovieProvider: rememberPref ? preferredId : '' })
    });
    if (rememberPref && !preferredId) ctx.showToast('Open a provider once to set it as your default');
    mount(container, ctx);
  });

  container.querySelector('#addCustomMovieBtn')?.addEventListener('click', () => {
    ctx.openModal(`
      <div class="modal-head"><span>Add Custom Movie Provider</span><button type="button" class="tb-icon-btn" id="mClose">&times;</button></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <input class="field-input" id="mvName" placeholder="Provider name" />
        <input class="field-input" id="mvUrl" placeholder="https://..." />
        <input class="field-input" id="mvDesc" placeholder="Short description" />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" id="mCancel">Cancel</button>
        <button type="button" class="btn btn-accent" id="mAdd">Save</button>
      </div>
    `, (card) => {
      card.querySelector('#mClose').onclick = ctx.closeModal;
      card.querySelector('#mCancel').onclick = ctx.closeModal;
      card.querySelector('#mAdd').onclick = async () => {
        const name = card.querySelector('#mvName').value.trim();
        const url = card.querySelector('#mvUrl').value.trim();
        const description = card.querySelector('#mvDesc').value.trim();
        if (!name || !/^https?:\/\//i.test(url)) return ctx.showToast('Valid http/https URL required');
        customProviders.push({ id: 'custom-' + Date.now(), name, url, description, enabled: true, order: 100, hue: Math.floor(Math.random() * 360) });
        await fetch('/api/user/preferences', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customMovieProviders: customProviders })
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
      const r = await fetch(`/api/movies/check?url=${encodeURIComponent(el.dataset.checkUrl)}`, { credentials: 'same-origin' });
      const j = await r.json();
      if (dot) dot.className = `prov-status-dot ${j.reachable ? 'ok' : 'warn'}`;
      if (txt) txt.textContent = j.reachable ? 'live' : 'unverified';
    } catch {
      if (dot) dot.className = 'prov-status-dot warn';
      if (txt) txt.textContent = 'unverified';
    }
  });
}
