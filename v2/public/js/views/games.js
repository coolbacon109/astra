// Lazy-loaded Games Hub (/g)
let cachedGames = [];

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/views.css');

  container.innerHTML = `
    <div class="page-wrap">
      <div class="page-header">
        <div>
          <h1 class="page-title">Games</h1>
          <div class="page-sub" id="gamesCountSub">Loading catalog...</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <input class="field-input" id="gamesSearchInput" style="width:230px;height:36px;" placeholder="Search games..." />
          <button type="button" class="btn btn-accent" id="gamesRandomBtn" style="height:36px;">Random</button>
        </div>
      </div>
      <div class="cards-grid" id="gamesGridMount"></div>
    </div>
  `;

  const grid = container.querySelector('#gamesGridMount');
  const sub = container.querySelector('#gamesCountSub');
  const searchEl = container.querySelector('#gamesSearchInput');

  function openGame(g) {
    if (!g || !g.url) return;
    let u = g.url;
    if (!/^https?:\/\//i.test(u)) {
      u = `https://cdn.jsdelivr.net/gh/gn-math/html@main/${String(u).replace(/^\{HTML_URL\}\/?/, '').replace(/^\/+/, '')}`;
    } else {
      u = u.replace(/\{HTML_URL\}/g, 'https://cdn.jsdelivr.net/gh/gn-math/html@main');
    }
    ctx.openExternalUrl(u, { title: g.name || 'Game' });
  }

  function renderGames() {
    const q = (searchEl.value || '').trim().toLowerCase();
    const list = q ? cachedGames.filter((g) => (g.name || '').toLowerCase().includes(q)) : cachedGames;
    sub.textContent = `${list.length} games ready`;
    grid.innerHTML = list.slice(0, 120).map((g, idx) => {
      const thumb = String(g.cover || '').replace(/\{COVER_URL\}/g, 'https://cdn.jsdelivr.net/gh/gn-math/covers@main');
      return `
        <div class="surface-card spot" style="cursor:pointer;" data-game-idx="${idx}">
          ${thumb ? `<img class="game-thumb" src="${ctx.escapeHtml(thumb)}" loading="lazy" alt="" />` : ''}
          <div style="font-size:14px;font-weight:700;color:var(--bright-text);">${ctx.escapeHtml(g.name || 'Game')}</div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('[data-game-idx]').forEach((card) => {
      card.onclick = () => openGame(list[Number(card.dataset.gameIdx)]);
    });
  }

  searchEl.oninput = renderGames;
  container.querySelector('#gamesRandomBtn').onclick = () => {
    if (!cachedGames.length) return;
    openGame(cachedGames[Math.floor(Math.random() * cachedGames.length)]);
  };

  if (!cachedGames.length) {
    try {
      const r = await fetch('/api/games', { credentials: 'same-origin' });
      const arr = await r.json();
      if (Array.isArray(arr)) cachedGames = arr.filter((x) => x && x.name && x.url);
    } catch {}
  }
  renderGames();
}
