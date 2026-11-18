// Lazy-loaded Admin Panel (/admin - coolbacon only)
export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/views.css');
  if (!ctx.appState.user || ctx.appState.user.role !== 'admin') {
    ctx.navigateRoute('/h');
    return;
  }

  let st = null;
  let reviews = [];
  try {
    const [aRes, rRes] = await Promise.all([
      fetch('/api/admin/state', { credentials: 'same-origin' }),
      fetch('/api/reviews', { credentials: 'same-origin' })
    ]);
    if (aRes.ok) st = await aRes.json();
    if (rRes.ok) reviews = (await rRes.json()).reviews || [];
  } catch {}

  const cfg = (st && st.serverConfig) || ctx.appState.serverConfig || {};
  const users = (st && st.users) || [];

  container.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Admin Console</h1>
          <div class="page-sub">Message of the day, ad filters, users and reviews</div>
        </div>
      </div>

      <div class="surface-card">
        <strong style="font-size:15px;color:var(--bright-text);">Message of the Day &amp; Server Options</strong>
        <label style="font-size:12px;color:var(--text-muted);">Fixed Hero MOTD (leave blank to rotate witty Cherri-style MOTD pool)</label>
        <input class="field-input" id="admMotdInput" value="${ctx.escapeHtml(cfg.motd || '')}" placeholder="e.g., new youtube music ui is live!" />
        <label style="font-size:12px;color:var(--text-muted);">Rotating MOTD Lines (comma-separated)</label>
        <input class="field-input" id="admMotdListInput" value="${ctx.escapeHtml((cfg.motdList || []).join(', '))}" />
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
          <select class="music-source-select" id="admDnsSelect" style="height:36px;">
            <option value="cloudflare" ${cfg.dnsMode === 'cloudflare' ? 'selected' : ''}>DNS: Cloudflare 1.1.1.1</option>
            <option value="cloudflare-sec" ${cfg.dnsMode === 'cloudflare-sec' ? 'selected' : ''}>DNS: Cloudflare Malware 1.1.1.2</option>
            <option value="adguard" ${cfg.dnsMode === 'adguard' ? 'selected' : ''}>DNS: AdGuard Ad-Block</option>
            <option value="system" ${cfg.dnsMode === 'system' ? 'selected' : ''}>DNS: System Default</option>
          </select>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;">
            <input type="checkbox" id="admDnsFilterChk" ${cfg.dnsAdFilter !== false ? 'checked' : ''} style="accent-color:var(--accent);" />
            <span>Block ad domains server-wide</span>
          </label>
          <button type="button" class="btn btn-accent" id="admSaveCfgBtn">Save Server Config</button>
        </div>
      </div>

      <div class="surface-card">
        <strong style="font-size:15px;color:var(--bright-text);">Users (${users.length})</strong>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${users.map((u) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:8px;background:var(--bg-base);">
              <span><strong>${ctx.escapeHtml(u.displayName)}</strong> <span style="color:var(--text-muted);">@${ctx.escapeHtml(u.username)} &bull; ${ctx.escapeHtml(u.role)}</span></span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="surface-card">
        <strong style="font-size:15px;color:var(--bright-text);">Moderate Reviews (${reviews.length})</strong>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${reviews.map((r) => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:9px;background:var(--bg-base);">
              <div style="min-width:0;">
                <strong style="font-size:12.5px;">${ctx.escapeHtml(r.username)}</strong>
                <span style="font-size:11px;color:var(--text-muted);">(${ctx.escapeHtml(r.roleBadge || '')})</span>:
                <span style="font-size:12.5px;">${ctx.escapeHtml(r.text)}</span>
              </div>
              <button type="button" class="btn" data-del-rev="${ctx.escapeHtml(r.id)}" style="height:28px;padding:0 10px;font-size:11.5px;">Delete</button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  container.querySelector('#admSaveCfgBtn').onclick = async () => {
    const motd = container.querySelector('#admMotdInput').value.trim();
    const motdList = container.querySelector('#admMotdListInput').value.split(',').map((s) => s.trim()).filter(Boolean);
    const dnsMode = container.querySelector('#admDnsSelect').value;
    const dnsAdFilter = container.querySelector('#admDnsFilterChk').checked;
    const r = await fetch('/api/admin/config', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motd, motdList, dnsMode, dnsAdFilter })
    });
    const j = await r.json();
    if (r.ok && j.ok) {
      ctx.appState.serverConfig = { ...ctx.appState.serverConfig, ...j.serverConfig };
      ctx.showToast('Saved MOTD & Server Config!');
    }
  };

  container.querySelectorAll('[data-del-rev]').forEach((b) => {
    b.onclick = async () => {
      await fetch(`/api/reviews/${encodeURIComponent(b.dataset.delRev)}`, { method: 'DELETE', credentials: 'same-origin' });
      mount(container, ctx);
    };
  });
}
