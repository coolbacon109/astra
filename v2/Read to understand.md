# AGENTS.md — Astra (v2)

Developer & AI-agent handbook for **Astra v2** (`astra-v2`). Read this before editing any file so the UI, themes, icons, tour, proxy engine, and backend stay fast and cohesive.

---

## 0. Ground Rules

- **Do NOT push to GitHub or deploy** unless the owner explicitly says so. `astra-github-ready` is the published repo and `astra-ui` is the legacy single-file baseline — treat both as read-only reference and make all edits in `astra-v2`.
- **Preview locally at `http://127.0.0.1:6740`** first so the owner can inspect changes in a real browser.
- **Never commit secrets or user stores**: no passwords, session secrets, API keys, or `data/*.json`.
- **Be strictly honest in reports**: only claim checks, UI visuals, or API results you actually ran and observed after your final edit.

---

## 1. Architecture at a Glance

Astra v2 is a modular **web-proxy "browser OS"** built on a single Node server with **zero build step** and **vanilla ES modules** on the client:
- **Shell (`public/index.html` + `public/js/app.js`)**: ~11.6 KB HTML shell — auth gate, left icon rail (`#sideRail`), top tab strip (`#tabStrip`), toolbar + omnibox (`#omniboxForm`), global mini music pill (`#topMiniMusic`), `#routeMount` (internal views), and `#browseStage` (`#browserFrame` proxy iframe).
- **Lazy Views (`public/js/views/*.js`)**: Each route (`/h`, `/music`, `/chat`, `/g`, `/a`, `/roblox`, `/s`, `/admin`) is dynamically `import()`-ed on demand and injects its own stylesheet via `ctx.ensureCssLoaded(...)`. That's why initial load stays fast instead of parsing a 758 KB monolith.
- **Engines**: `public/js/music-engine.js` (persistent `HTMLAudioElement` across routes) and `public/js/proxy-engine.js` (Scramjet primary + Ultraviolet auto-fallback, Wisp DNS/ad filtering, Device Spoofer, cross-device cookie sync).
- **Backend (`server.js`)**: CommonJS Node HTTP/WebSocket server serving static assets, SPA routes, REST APIs, Wisp (`/wisp/`), dynamic `/sw.js`, YouTube Music (`WEB_REMIX`) search/audio proxy, and atomic JSON stores under `data/`.

---

## 2. Run, Syntax-Check & Verify

```powershell
# Start server (http://127.0.0.1:6740)
npm start   # runs: node --max-http-header-size=131072 server.js

# Backend syntax check
node --check server.js

# Frontend syntax check (ES modules — plain `node --check` fails on import/export!)
Get-ChildItem public\js -Recurse -Filter *.js | ForEach-Object {
  Get-Content -Raw $_.FullName | node --input-type=module --check
}
```

- **Environment variables**: `PORT` (default `6740`), `HOST` (`0.0.0.0`), `ASTRA_DATA_DIR` / `DATA_DIR` (default `./data`).
- **Auth API**: `POST /api/auth/login` takes JSON `{ username, password, remember? }` (the field is **`password`**, not `passcode`). Owner/admin handle is **`coolbacon`**.
- **Headless browser testing**: Spawn `chrome.exe --headless=new --remote-debugging-port=9241 --user-data-dir=<tmp>` and drive via CDP using the `ws` package in `node_modules`. Sign in through `#authUser` / `#authPass` / `#authForm` so `astra_session` + Service Worker + IndexedDB behave identically to a real browser.

---

## 3. UI Design System & How to Build UI

Astra v2 follows a **dark glass + dot-grid + cursor-spotlight** aesthetic with smooth `@property` color transitions and zero inline hardcoded colors.

### 3.1 CSS Tokens (`public/css/tokens.css`)
Always style components using CSS variables from `tokens.css` — **never hardcode `#ff6b8b` or raw hex backgrounds**:
- **Surfaces (darkest -> lightest)**:
  - `--bg-base` (app canvas + dot-grid backdrop)
  - `--bg-1-base` (cards, rail, sidebars, tour card)
  - `--bg-2-base` (hover states, active nav items, secondary panels)
  - `--bg-3-base` (buttons, inputs, controls)
  - `--bg-4-base` (hover/elevated controls)
- **Accent & Text**:
  - `--accent`, `--accent-2`, `--accent-glow`, `--accent-contrast` (text color on `--accent` buttons)
  - `--bright-text` (headings/active), `--text` (body), `--text-muted` (subtitles/labels)
- **Borders, Radii & Motion**:
  - `--border` (strong/hover), `--border-2` (standard), `--border-3` (subtle card border), `--border-4` (hairline)
  - `--dot-color`, `--glass-alpha`, `--glass-blur`
  - `--radius-sm` (`6px`), `--radius-md` (`10px`), `--radius-lg` (`14px`), `--radius-xl` (`18px`), `--radius-pill` (`999px`)
  - `--ease-ui: cubic-bezier(0.2, 0, 0, 1)`, `--shadow-card`, `--shadow-modal`

### 3.2 Reusable UI Patterns & Classes
- **Spotlight hover (`.spot`)**: Add class `spot` to any card, tile, or pill. `app.js` updates `--sx` / `--sy` on `pointermove`, and `tokens.css` renders a radial `--accent` glow under the cursor with `isolation: isolate`.
- **Standard view layout (`public/css/views.css`)**:
  - Wrap page content in `<div class="page-wrap">` (max-width `1120px`, centered, `24px 26px 40px` padding).
  - Header: `<div class="page-header">` with `<h1 class="page-title">` + `<div class="page-sub">`.
  - Grids & cards: `<div class="cards-grid">` containing `<div class="surface-card spot">`.
  - Split settings-style layout: `.settings-grid` (`210px 1fr`), sticky `.settings-nav` + `.settings-nav-btn`, `.settings-panel`.
  - Segmented toggles: `.seg-row` + `.seg-btn` (`.active`).
- **Buttons, Inputs & Pills (`shell.css`)**:
  - `.btn` / `.btn.btn-accent` for primary actions; `.tb-icon-btn` for square icon buttons.
  - `.field-input` for text inputs/textareas.
  - `.badge-pill` for compact status indicators (e.g., WebSocket `live`).
- **Modals & Toasts (`app.js` / `ctx`)**:
  - `ctx.openModal(html, (cardEl) => { ... })` & `ctx.closeModal()` (backdrop click closes automatically).
  - `ctx.showToast(msg, ms)` for non-blocking bottom notifications.
  - Always sanitize dynamic user strings with `ctx.escapeHtml(...)` before inserting into `innerHTML`.

### 3.3 Themes (`tokens.css` + `views/settings.js` + `app.js`)
- **Default theme**: **`midnight`** (`:root`, indigo `#7c8cff`).
- **Available themes**: `midnight`, `rose` (`#ff6b8b`), `void` (`#f4f4f7`), `nord` (`#88c0d0`), `forest` (`#4ade80`), `sunset` (`#fb923c`).
- Note: `cherri` was retired as the default theme; `applyTheme('cherri')` in `app.js` automatically maps saved `'cherri'` preferences to `'midnight'`.
- **Add a new theme**:
  1. Add a `[data-theme="mytheme"] { ... }` block in `public/css/tokens.css` overriding `--bg-base`..`--bg-4-base`, `--accent`, `--accent-2`, `--accent-glow`, `--accent-contrast`, `--text`, `--text-muted`, `--bright-text`, `--border`..`--border-4`, and `--dot-color`.
  2. Add `{ id: 'mytheme', name: 'Display Name', color: '#hex' }` to `THEMES` in `public/js/views/settings.js`.

### 3.4 Icons (`public/js/icons.js`)
- **Single source of truth**: Every UI icon lives in `public/js/icons.js` (`24x24` viewBox, `1.75` rounded stroke, `currentColor`).
- Use `ICONS.<name>` or `svgIcon('<name>')` — **do not inline raw `<svg>` icons** inside views.
- At boot, `applyRailIcons()` replaces the static glyphs inside `#sideRail` using `RAIL_MAP`.
- **Anime = Gojo sticker**: `'anime'` renders `<img class="icon icon-anime" src="/assets/gojo.png" ... />` (`128x128` transparent sticker cutout from the owner's sketch). Size is controlled in `shell.css` (`.rail-btn img.icon-anime` = `21px`, `.app-tile-box img.icon-anime` = `26px`) and does not recolor with themes.
- **Add a new icon**: Add its SVG inner markup to `PATHS` in `public/js/icons.js` (and map its route in `RAIL_MAP` if it appears on `#sideRail`).

### 3.5 Home Hero & Cursive Animation (`public/js/views/home.js`)
- The `"astra"` hero uses `Alex Brush` text inside `#astraTraceSvg` revealed by 6 calligraphy `<path class="astra-mask-stroke">` strokes in `#astraTraceMask` animated via `runCursiveTraceAnimation()` (`~1.75s` `stroke-dashoffset` ease-out cubic), paired with the Crescent Moon SVG badge.
- Below it: Cherri-style rotating/fixed MOTD (`#heroMotd`), search omnibox (`#homeSearchForm`), custom/default app tiles (`#homeAppsRow` with `+ Add` & `All Apps`), live online count (`#homeOnlineCount`), community button, clock card (`#homeClockTime`), and bottom reviews marquee (`#reviewsMarqueeTrack`).

---

## 4. Routing & Adding a New Page

- **Server SPA routes (`SPA_APP_ROUTES` in `server.js`)**: `/`, `/index.html`, `/h`, `/b`, `/g`, `/m`, `/a`, `/music`, `/chat`, `/roblox`, `/ai`, `/s`, `/admin`, `/login` all serve `public/index.html`.
- **Client router (`app.js`)**: `navigateRoute(route)` + `ROUTE_TITLES`. Special external-proxy routes: `/m` opens `https://www.streamex.hn`, `/ai` opens `https://ivy.rest/a`.
- **View contract**: Each view module `public/js/views/<name>.js` exports:
  ```js
  export async function mount(container, ctx) {
    ctx.ensureCssLoaded('/css/<name>.css');
    container.innerHTML = `<div class="page-wrap">...</div>`;
    // attach listeners...
    return () => { /* optional cleanup: clearInterval, close sockets, etc. */ };
  }
  ```
  `ctx` provides `{ appState, escapeHtml, showToast, openModal, closeModal, ensureCssLoaded, navigateRoute, openExternalUrl, saveUserState, proxyPrefs }`.

### Step-by-Step: Add a New Page (`/newpage`)
1. Add `'/newpage'` to `SPA_APP_ROUTES` in `server.js`.
2. Add `'/newpage': 'New Page'` to `ROUTE_TITLES` in `public/js/app.js` and handle its lazy `import('/js/views/newpage.js')` in `syncActiveTabView()`.
3. Create `public/js/views/newpage.js` (exporting `mount(container, ctx)`) and optional `public/css/newpage.css`.
4. Add a rail button `<button type="button" class="rail-btn" data-route="/newpage" title="New Page">` in `public/index.html` and map `'/newpage': '<iconKey>'` in `RAIL_MAP` in `public/js/icons.js`.

---

## 5. Interactive Spotlight Tutorial (`tour.js` + `tour.css`)

- Lazy-loaded module (`public/js/tour.js` + `public/css/tour.css`) with spotlight ring, hotspot click-through, animated dashed SVG pointer arrow, step dots, `try it`, and `never show again`.
- **Triggers**: Automatically when login/`/api/auth/me` returns `needsTour: true`, via URL `?tour=1`, or from **Settings -> Appearance -> Replay tutorial** (`window.dispatchEvent(new Event('astra:start-tour'))`).
- **Persistence**: `POST /api/auth/tour-done` (`data/tour-prefs.json`). `coolbacon` is exempt from forced startup tour on the server.
- **Maintenance rule**: `STEPS` in `tour.js` targets DOM selectors (`#homeSearchForm`, `#homeAppsRow`, `.rail-btn[data-route=...]`, `#topMiniMusic`). If you rename those IDs/attributes, update `STEPS` too.

---

## 6. Feature Modules & APIs

- **Reviews (`/api/reviews`)**:
  - `GET /api/reviews` (public), `POST /api/reviews` (`{ text, roleBadge }`, login required, max 240 chars, max 80 stored), `DELETE /api/reviews/:id` (author or admin).
  - Stored in `data/reviews.json`. **Ships empty on purpose** (`SEED_REVIEWS = []`); the home marquee renders `.review-empty` until real users submit reviews.
- **Music (`music-engine.js` + `views/music.js`)**:
  - Single global `HTMLAudioElement` survives route switches and stays synced with `#topMiniMusic`.
  - Primary source is **YouTube Music (`WEB_REMIX`)** via `/api/music/home`, `/api/music/search?q=&source=ytmusic|youtube|soundcloud`, `/api/music/audio/:id`, `/api/music/lyrics`, `/api/music/playlists`, `/api/music/liked`.
  - Album artwork flows through `/api/img?url=`, which enforces `ALLOWED_IMG_HOSTS` in `server.js` (must include `googleusercontent.com`, `i.ytimg.com`, `yt3.ggpht.com`, `i1.sndcdn.com`, `i.scdn.co`, `resources.tidal.com`).
  - Always preserve: Pause, Stop/Exit (`✕ Exit`), Queue, and real `M:SS` / `H:MM:SS` playback timestamps.
- **Chat (`views/chat.js` + WebSocket)**:
  - Channels, replies, reactions, pins, and member list persisted in `data/chat-messages.json`.
  - Owner handle/display name is strictly **`coolbacon`** (`loadAuthStore()` and `readChatStore()` normalize any legacy `'Luis (coolbacon)'`).
- **Admin (`/admin`, `views/admin.js`)**:
  - Visible only when `user.role === 'admin'`. Controls MOTD pool/fixed MOTD, maintenance mode, default proxy engine, DNS resolver/ad filter, and user accounts.

---

## 7. Proxy Stack (`proxy-engine.js` + `server.js` `/sw.js`)

- **Transports & Wisp (`/wisp/`)**: `BareMux` + `libcurl` (default) or `epoxy`. `applyWispDnsAndFilters()` in `server.js` configures DNS (`cloudflare` `1.1.1.1`/`1.0.0.1`, `cloudflare-sec`, `adguard`, `system`), `ipv4first`, and `hostname_blacklist` from `ublock-domains.txt`.
- **Engines**: **Scramjet** (`/scramjet/`) is default primary; **Ultraviolet** (`/uv/service/`) is fallback (and per-URL hinted for `tiktok.com` without mutating user prefs). `navigateFrameWithFallback()` automatically retries with the alternate engine if a frame stalls (`8.5s`) or loads blank/broken.
- **Critical IndexedDB Rule (Scramjet Pre-Init)**:
  - In `proxy-engine.js`, `healStaleScramjetDb()` + `await scramjetController.init()` **must finish BEFORE `navigator.serviceWorker.register('/sw.js')`** and before `restoreProxyCookiesFromAccount()`.
  - Why: if `/sw.js` or `idbWriteStore` opens `$scramjet` first without its schema, the `config` object store is missing, `scramjet.loadConfig()` fails silently, and requests fall through to `server.js`'s HTTP `fetchAndProxy` fallback (identifiable by `script[data-astra-proxy]` / `x-astra-engine` header) instead of real Scramjet client-side WASM rewriting!
- **Service Worker (`/sw.js`)**: Built dynamically by `buildUnifiedServiceWorkerScript()` in `server.js` as a template literal (remember to double-escape `\\\\` in regexes and escape `\${...}`). Handles Scramjet/UV routing, `ASTRA_FRAME_FIX_SNIPPET` (`Document.prototype.domain` shim), cosmetic + uBlock adblocking, header cleanup (`Referer`/`Origin`/`Sec-Fetch-Site`), and Device Spoofer (`astra-identity`).
- **Device Spoofer & Per-User Cookie Sync**:
  - Settings -> Device Spoofer toggles `mirror` vs `disguise` (`DEVICE_UA_PRESETS` / custom UA) and notifies the SW via `syncIdentityToSw()`.
  - `proxy-engine.js` syncs `$scramjet` & `__op` IndexedDB cookies to/from `POST/GET /api/proxy/cookies` (`data/proxy-cookies.json`) per logged-in account.

---

## 8. Data Files (`data/`)

All persisted via `writeJsonStoreAtomic` (creating `.bak` backups):
`auth-store.json`, `user-profiles.json`, `chat-messages.json`, `chat-read-states.json`, `chat-roles.json`, `music-likes.json`, `music-playlists.json`, `proxy-cookies.json`, `reviews.json`, `tour-prefs.json`, `astra-server-config.json`.

---

## 9. Deploying to Oracle Cloud (Multi-Domain Plan)

1. Run `node --max-http-header-size=131072 server.js` behind **Caddy** on one Oracle Cloud VM (`ASTRA_DATA_DIR` set to a persistent directory).
2. Add one `Caddyfile` block per domain (`domain1.com { reverse_proxy 127.0.0.1:6740 }`, `domain2.com { reverse_proxy 127.0.0.1:6740 }`) — Caddy provisions HTTPS automatically and forwards WebSocket upgrades for `/wisp/` and `/chat`.
3. Open ports `80` and `443` in both the OCI VCN Security List and the VM firewall (`iptables`/`ufw`), and point each domain's `A` record to the VM's reserved public IP.
4. Keep `Host` / `X-Forwarded-Host` intact if adding an extra proxy hop, because `/wisp/` validates `Origin` against the request host.

---

## 10. Pre-Ship Checklist

- Run `node --check server.js` and `node --input-type=module --check` on every file in `public/js/`.
- Restart the server, sign in through the UI, test changed views + proxy targets in headless/real Chrome, inspect screenshots, and verify 0 console/page errors.
- Keep this `AGENTS.md` updated whenever you add routes, icons, themes, data files, or change proxy behavior.
