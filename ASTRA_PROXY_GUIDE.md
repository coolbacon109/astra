# Astra Proxy & Full-Stack Engineering Bible (for OpenCode / GLM-5.3 / Flash / Max)

> **Audience:** Coding agents (`OpenCode`, `GLM-5.3`, `Flash`, `Max`) and developers extending or debugging Astra.
> **Purpose:** Complete, implementation-accurate architectural manual explaining how Astra's 4-layer proxy, Unified Service Worker (`/sw.js`), Wisp multiplexer (`/wisp/`), Node fallback rewrite proxy, multi-layer adblocker, LucideBlox dual-mode Roblox proxy, Music waterfall, atomic `DATA_DIR` persistence, Auth/RBAC, AI Hub, and Discord-style Chat/WebRTC system work together—plus step-by-step rules and debugging playbooks so changes never break production.

---

## Table of Contents
1. [Non-Negotiable Production Invariants](#1-non-negotiable-production-invariants)
2. [Directory Layout, Dependencies & Persistent Stores](#2-directory-layout-dependencies--persistent-stores)
3. [Backend Request Routing & Route Precedence (`server.js`)](#3-backend-request-routing--route-precedence-serverjs)
4. [The 4-Layer Web Proxy Architecture](#4-the-4-layer-web-proxy-architecture)
5. [Frontend Engine Bootstrapping (`index.html`)](#5-frontend-engine-bootstrapping-indexhtml)
6. [Unified Service Worker Internals (`/sw.js`)](#6-unified-service-worker-internals-swjs)
7. [URL Codecs & Relative Path Recovery (`encodeXor`, `decodeXor`, `resolveRelativeViaReferer`)](#7-url-codecs--relative-path-recovery)
8. [Node Fallback Proxy (`fetchAndProxy`), Header Sanitization & Cookie Jar Isolation](#8-node-fallback-proxy-fetchandproxy-header-sanitization--cookie-jar-isolation)
9. [Content Rewriting Engine (`rewriteHtml`, `rewriteCss`, `rewriteJs`, `buildInjectedShim`)](#9-content-rewriting-engine)
10. [Multi-Layer Adblocker & YouTube Shield Architecture](#10-multi-layer-adblocker--youtube-shield-architecture)
11. [Wisp & Chat WebSocket Upgrade Pipeline (`server.on('upgrade')`)](#11-wisp--chat-websocket-upgrade-pipeline)
12. [LucideBlox / Roblox Dual-Mode Proxy (`/3to1s93ve/`, `/__nodeproxy__/`, `/robloxcookie=`)](#12-lucideblox--roblox-dual-mode-proxy)
13. [Astra Music Search, Extraction & Streaming Waterfall (`/api/music/*`)](#13-astra-music-search-extraction--streaming-waterfall)
14. [Auth, Sessions, RBAC, Admin & User State (`/api/auth/*`, `/api/admin/*`)](#14-auth-sessions-rbac-admin--user-state)
15. [Crash-Safe Atomic Persistence (`DATA_DIR`, `.tmp` + `renameSync` + `.bak`)](#15-crash-safe-atomic-persistence)
16. [Discord-Style Chat, `#updates`, `#roles`, GIFs, Stickers, Banners & WebRTC Voice](#16-discord-style-chat-updates-roles-gifs-stickers-banners--webrtc-voice)
17. [Complete API Endpoint Reference](#17-complete-api-endpoint-reference)
18. [Common Bugs, Anti-Patterns & Debugging Playbooks](#18-common-bugs-anti-patterns--debugging-playbooks)
19. [Mandatory Verification & Deployment Checklist](#19-mandatory-verification--deployment-checklist)

---

## 1. Non-Negotiable Production Invariants

Break any one of these and Astra breaks either locally or in cloud deployment (Render/VPS/Docker):

1. **Bind `0.0.0.0` ALWAYS (`server.js`):**
   ```js
   const PORT = Number(process.env.PORT) || 6740;
   const HOST = process.env.HOST || '0.0.0.0';
   server.listen(PORT, HOST, () => {
     console.log(`Astra server running at http://${HOST}:${PORT} (DATA_DIR=${DATA_DIR})`);
   });
   ```
   - Never hardcode `127.0.0.1` or `localhost` in `server.listen(...)`. Cloud health-checks, LAN clients, and reverse proxies require `0.0.0.0`.
   - Use loopback (`http://127.0.0.1:6740`) strictly inside temporary local test scripts.

2. **Raise Node's HTTP Header Size Limit (`--max-http-header-size=131072`):**
   - Defined in `package.json`: `"start": "node --max-http-header-size=131072 server.js"`.
   - Proxied logins and CDNs (YouTube, Google, Roblox, TikTok) routinely exceed Node's default 16 KB header ceiling. Outbound `client.request(...)` calls in `server.js` also pass `maxHeaderSize: 131072`.

3. **Persist ALL State in `DATA_DIR` Using Atomic Writes:**
   - Never construct mutable store paths with `path.join(ROOT_DIR, ...)`. Use `migrateLegacyStoreFile(filename)` -> `DATA_DIR`.
   - Never overwrite live JSON stores directly with `fs.writeFileSync(target, ...)`. Always call `writeJsonStoreAtomic(filePath, data)` and `readJsonStoreSafe(filePath, fallback)`.

4. **Strict Session Cookie Isolation (`astra_session`):**
   - `astra_session` is Astra's own HMAC-signed login cookie (`HttpOnly; Path=/`). Every outbound proxy fetch MUST strip `astra_session=...` from forwarded `Cookie` headers so third-party origins never receive Astra session tokens.

5. **Never Serve `/sw.js` From Cache & Always Send `Service-Worker-Allowed: /`:**
   - `/sw.js` MUST return `'Cache-Control': 'no-store'` and `'Service-Worker-Allowed': '/'` so browsers immediately adopt adblock, rewrite, and transport updates across refreshes.

6. **Validate Syntax of BOTH `server.js` AND `index.html` Before Restarting:**
   - `server.js`: `node -c server.js`
   - `index.html`: Parse `<script>([\s\S]*?)<\/script>\s*<\/body>` with `new vm.Script(code)`
   - `/sw.js`: Parse dynamically returned worker JS from `GET /sw.js` with `new vm.Script(swText)`!

7. **Sync Both Workspaces Carefully (`astra-ui` vs `astra-github-ready`):**
   - Active workspace: `C:\Users\cheli\.gemini\antigravity\scratch\astra-ui`
   - Git repo (`coolbacon109/astra`, branch `main`): `C:\Users\cheli\.gemini\antigravity\scratch\astra-github-ready`
   - Notice the panic-cloak path difference: if `astra-ui/index.html` uses `src="/clever-cloak/Clever.html"`, sync to `astra-github-ready/index.html` with `src="clever-cloak/Clever.html"` when required, and always mirror `server.js`, `package.json`, `index.html`, and `assets/` (`assets/chat/*`, etc.).

---

## 2. Directory Layout, Dependencies & Persistent Stores

### Filesystem Map

```
astra-ui/
├── server.js                      # Monolith HTTP/WS backend, proxy engines, SW generator, APIs
├── index.html                     # Monolith SPA shell (CSS + DOM + Client Controller)
├── ASTRA_PROXY_GUIDE.md           # This handbook
├── package.json                   # Node dependencies & `--max-http-header-size=131072` start script
├── package-lock.json
├── clever-cloak/                  # Offline Clever login cloak (`Clever.html` + `Clever_files/`)
├── assets/
│   ├── astra-logo.png / .jpg
│   ├── black-silk-waves.mp4
│   ├── themes/
│   ├── cloaks/
│   └── chat/
│       ├── astra-bot-pfp.png      # Custom cursive Astra Bot PFP
│       ├── lbp-sticker.jpg        # LittleBigPlanet Sackboy sticker + LBP Fans role icon
│       ├── lego-starwars-pfp.png  # Default PFP for mason & jase + Star Wars Fan icon
│       └── snoop-dogg-pfp.jpg     # Default PFP + Snoop Dogg Fan role icon for kingsley
└── Persistent JSON Stores (located in DATA_DIR):
    ├── auth-store.json (+ .bak)          # Users, scrypt hashes, avatars, banners, bios, decorations, visualRoles
    ├── chat-messages.json (+ .bak)       # `_channels` array + per-channel message arrays
    ├── chat-roles.json (+ .bak)          # Custom visual roles created in `#roles`
    ├── user-profiles.json (+ .bak)       # Per-user synced settings, tabs, recentGames, AI threads
    ├── astra-server-config.json          # `sessionSecret`, `motd`, `maintenanceMode`, `defaultEngine`, `adblockDefault`, `extraBlockedHosts`
    ├── tour-prefs.json                   # Per-user startup onboarding completion (`never show again`)
    ├── music-likes.json                  # Saved liked tracks
    └── music-playlists.json              # Imported/custom Spotify & YouTube playlists
```

### Key Packages (`package.json`)

| Package | Version | Role in Astra |
| :--- | :--- | :--- |
| `@mercuryworkshop/scramjet` | `^1.1.0` | Primary WASM-backed Service Worker proxy engine (`/scram/`, `/scramjet/`) |
| `@titaniumnetwork-dev/ultraviolet` | `^3.2.10` | Secondary Service Worker proxy engine (`/uv/`, `/uv/service/`) — auto-selected for TikTok |
| `@mercuryworkshop/bare-mux` | `^2.1.9` | Transport multiplexer worker (`/baremux/worker.js`) shared between SW & window |
| `@mercuryworkshop/libcurl-transport` | `1.5.2` | Primary BareMux HTTP/2 transport inside browser (`/libcurl/index.mjs`) |
| `@mercuryworkshop/epoxy-transport` | `2.1.29` | Fallback BareMux encrypted TLS transport (`/epoxy/index.mjs`) |
| `@mercuryworkshop/wisp-js` | `^0.5.3` | WebSocket tunnel server (`wisp.server.routeRequest`) mounted at `/wisp/` |
| `wisp-server-node` | `^1.1.8` | Node Wisp interoperability dependency |
| `@distube/ytdl-core` | `^5.2.1` | Server-side YouTube audio extraction fallback for Astra Music |
| `ws` | installed | Handles `/chat-ws` real-time chat, reactions, role broadcasts, and WebRTC signaling |

---

## 3. Backend Request Routing & Route Precedence (`server.js`)

`http.createServer` handles incoming requests strictly from top to bottom. **Route ordering is critical** so internal assets, proxy static runtimes, APIs, and catch-all proxy prefixes never collide:

1. **Worker & Link Entrypoints:**
   - `/sw.js` and `/astra-sw.js` -> `buildUnifiedServiceWorkerScript()` (`Cache-Control: no-store`, `Service-Worker-Allowed: /`)
   - `/robloxcookie...` -> Connects & verifies `.ROBLOSECURITY` directly into user session + LucideBlox localStorage -> redirects to `/?nocloak=1&roblox=1`
2. **LucideBlox Dual Proxy:**
   - `/__proxy__/*` -> `proxyWebbloxApiRequest()`
   - `/3to1s93ve` and `/3to1s93ve/*` -> `serveWebbloxAsset()` (which also routes `/3to1s93ve/__nodeproxy__/*` through `proxyWebbloxApiRequest`)
3. **Static Proxy Runtimes (from `node_modules`):**
   - `/uv/uv.config.js` -> dynamic `buildUvConfigScript()`
   - `/scram/*` -> `scramjetPath`
   - `/uv/*` (excluding `/uv/service/*`) -> `uvPath`
   - `/baremux/*` -> `baremuxPath`
   - `/epoxy/*` -> `EPOXY_PATH`
   - `/libcurl/index.mjs` (patched Libcurl transport wrapper) & `/libcurl/*` -> `LIBCURL_PATH`
4. **JSON API Endpoints (`/api/*`):**
   - Health, Auth, Roblox, Admin, Music, Chat (Avatars, Decorations, Roles, GIFs, Channels, Reorder, Reactions, Messages), AI, User State, Games.
5. **Auth-Gated Server Fallback Proxy Routes:**
   - Guarded by `if (!sessionUser) -> 401` and `maintenanceMode` check (`503` for non-admins):
   - `/proxy?url=...`
   - `/scramjet/<encoded-or-rel>`
   - `/uv/service/<xor-or-rel>`
6. **First-Party UI & Static Assets:**
   - `/` or `/index.html` -> `index.html`
   - `/clever-cloak/*` -> static Clever cloak assets
   - `/assets/*` -> logos, video wallpaper, themes, cloaks, `/assets/chat/*`
7. **HTTP Upgrade Handler (`server.on('upgrade')`):**
   - `/wisp` & `/wisp/` -> Origin check + maintenance check + `wisp.server.routeRequest(req, socket, head)`
   - `/chat-ws` -> Session auth check + `chatWss.handleUpgrade(...)`

---

## 4. The 4-Layer Web Proxy Architecture

Astra never relies on just one proxy mechanism because modern websites break single-layer proxies in predictable ways (WebGL games fail HTML regex rewriters; first-page loads before SW claim bypass SW hooks; some SPAs reject certain TLS signatures). Instead, Astra combines **four tightly coupled layers**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ LAYER 1: Frontend Frame & Controller (`index.html`)                     │
│  • `ScramjetController` registers WASM rewriter + tracks iframe URLs    │
│  • `BareMuxConnection` binds Libcurl (`/libcurl/index.mjs?v=astra3`)    │
│    or falls back to Epoxy (`/epoxy/index.mjs`) -> `wss://<host>/wisp/`  │
│  • `resolveEngineForUrl()` routes TikTok -> UV, default -> Scramjet     │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ loads `/scramjet/...` or `/uv/service/...`
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ LAYER 2: Unified Service Worker (`/sw.js`, scope `/`)                   │
│  • Runs `ScramjetServiceWorker` + `UVServiceWorker` side by side        │
│  • Interception: Adblock -> Leak Recovery -> Scramjet/UV -> BareClient  │
│  • `patchBareClientInstance()` strips ads, YT playerAds, & heals MIME   │
│  • `maybePatchProxiedHtml()` injects frame/Unity/cosmetic/YT scripts    │
└──────────────────┬───────────────────────────────────┬──────────────────┘
                   │ Client SW path (Bare -> Wisp WS)  │ Direct HTTP fallback
                   ▼                                   ▼
┌─────────────────────────────────────┐ ┌─────────────────────────────────┐
│ LAYER 3: Wisp Tunnel (`/wisp/`)     │ │ LAYER 4: Node Rewrite Proxy     │
│  • Multiplexes browser TLS streams  │ │  • `/proxy`, `/scramjet/*`,     │
│    over a single WebSocket          │ │    `/uv/service/*`              │
│  • `allow_private_ips = false`      │ │  • Used if SW not claimed yet,  │
│  • `allow_loopback_ips = false`     │ │    or external redirect/reload  │
│  • Verifies `origin` matches host   │ │  • `fetchAndProxy` + HTML/CSS/JS│
└─────────────────────────────────────┘ │    lexical rewriter + shim      │
                                        └─────────────────────────────────┘
```

### Why `/scramjet/` and `/uv/service/` URLs Work Both Client-Side & Server-Side
When the browser already has `/sw.js` controlling scope `/`, navigating the `<iframe>` to `/scramjet/<url>` or `/uv/service/<xor>` is intercepted cleanly inside the browser by Scramjet/UV without touching Node's HTTP proxy handler at all—streaming packets straight through BareMux -> Libcurl -> WebSocket `/wisp/`.
If `/sw.js` is NOT controlling the frame (first load after clearing storage, hard reload, or sub-navigation edge cases), Node receives the HTTP request at `/scramjet/...` or `/uv/service/...` and executes Layer 4 (`fetchAndProxy`), seamlessly proxying the page, stripping CSP headers, injecting `buildInjectedShim()`, AND triggering `navigator.serviceWorker.register('/sw.js', { scope: '/' })` so subsequent navigations promote cleanly back into Layers 2 & 3!

---

## 5. Frontend Engine Bootstrapping (`index.html`)

Inside `ensureProxyRuntimeReady()` (`index.html` lines `9103-9265`), **never rearrange these steps**—order prevents the `$scramjet` IndexedDB corruption bug and SW race conditions:

1. **Step 1 — Self-Heal `$scramjet` IDB & Init `ScramjetController`:**
   ```js
   // Check existing $scramjet IDB; if an older/corrupt DB lacks 'config' objectStore, delete & rebuild
   const req = indexedDB.open('$scramjet');
   ```
   Then construct `ScramjetController` pointing at `/scramjet/` and `/scram/scramjet.{wasm.wasm,all.js,sync.js}`, call `await scramjetController.init()`, create `scramjetFrame`, and bind its `urlchange` listener so browser tabs + URL bar stay updated.

2. **Step 2 — Unregister Conflicting SWs & Register Unified `/sw.js`:**
   - Iterate `navigator.serviceWorker.getRegistrations()`; unregister any rogue registration EXCEPT `/sw.js` and `/3to1s93ve/sw.js`.
   - Call `navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })`.
   - Wait for activation + controller (`controllerchange` with a safe timeout guard so UI never deadlocks) -> call `scramjetController.init()` again -> call `syncAdblockToServiceWorker()`.

3. **Step 3 — Initialize `BareMuxConnection` Transport:**
   - Instantiate `new BareMux.BareMuxConnection('/baremux/worker.js')`.
   - Derive `ws://` or `wss://` dynamically from `window.location.origin` (HTTPS -> `wss://`, HTTP -> `ws://`).
   - Connect `/libcurl/index.mjs?v=astra3` with `[{ wisp: wispUrl }]`, falling back automatically to `/epoxy/index.mjs` if Libcurl fails to initialize.

4. **Engine Auto-Routing (`resolveEngineForUrl` & `maybeAutoSwitchEngineForUrl`):**
   - `isTikTokUrl(url)` (`tiktok.com`, `tiktokv.com`) ALWAYS selects `'ultraviolet'` because Ultraviolet's DOM/hydration shims handle TikTok's SPA better than Scramjet.
   - All other sites use `astraSettings.engine` (`'scramjet'` default).

---

## 6. Unified Service Worker Internals (`/sw.js`)

`/sw.js` is generated dynamically by `buildUnifiedServiceWorkerScript()` in `server.js`. Key internals you must understand before touching it:

1. **Exact `importScripts` Sequence:**
   ```js
   importScripts('/baremux/index.js');
   importScripts('/scram/scramjet.all.js');
   importScripts('/uv/uv.bundle.js');
   importScripts('/uv/uv.config.js');
   importScripts('/uv/uv.sw.js');
   ```
   `uv.bundle.js` defines `Ultraviolet`; `uv.config.js` populates `self.__uv$config` using `Ultraviolet.codec.xor`; `uv.sw.js` reads `self.__uv$config`. Changing the order throws a synchronous SW boot failure.

2. **Patched BareClient Transport (`patchBareClientInstance`):**
   Both `scramjet.client` and `uv.bareClient` are wrapped via `patchBareClientInstance(client)`. Whenever ANY request leaves the browser over Wisp:
   - **Pre-flight Adblock Check:** Runs `isAdBlockedTarget(rawTargetStr)` BEFORE touching the network; returns MIME-matched benign stub (`createBlockedAdResponse`) and calls `notifyAstraAdBlocked()` to increment Astra's UI counter.
   - **Header Normalization (`getHeaderCI` / `setHeaderCI`):**
     - Case-insensitively replaces local origin leaks (`127.0.0.1` / `localhost` / Render host in `referer` or `origin`) using `decodeProxiedUrlStr()` and `pendingCtx`.
     - Computes accurate `sec-fetch-site` (`same-origin` vs `cross-site`) matching the spoofed `Referer`/`Origin` so CSRF/API gates (like Roblox or Cloudflare checks) don't reject requests.
   - **Roblox Cookie Capture:** Reads `.ROBLOSECURITY` from both outbound `cookie` and response `set-cookie` (`rawHeaders` & `headers.getSetCookie()`), saving it to IndexedDB (`$astra_rbx`) so `/3to1s93ve/` and `/__nodeproxy__/` share authentication seamlessly.
   - **YouTube Player Ad-Stripping:** Inspects JSON from `/youtubei/v1/player` when `astraAdblockEnabled` is true and deletes `adPlacements`, `playerAds`, and `adSlots` before the YouTube player consumes it.
   - **GitHub Raw MIME Repair:** Fixes `raw.githubusercontent.com` / `gist.githubusercontent.com` / `githack.com` files served with `text/plain` -> upgrades `.html`, `.css`, `.js`/`.mjs` to executable MIME types so HTML5 games from CDNs work inside proxied iframes.

3. **Leaked Root-Origin Request Recovery (`handleRequest` lines `3190-3350`):**
   When poorly behaved third-party scripts make direct `https://...` non-navigate fetches that bypassed URL rewriting (`!isScramjetReq && !isUvReq && !reqUrl.startsWith(location.origin)`):
   - First checks `isAdBlockedTarget(reqUrl)`.
   - Otherwise checks `getUpstreamContext(event)` for the invoking proxied page and proxies the request cleanly via `bare.fetch(...)` with relaxed CORS headers so third-party CDNs don't die on CORS preflights!

4. **HTML Post-Patching (`maybePatchProxiedHtml`):**
   Runs on `dest === 'iframe' || dest === 'document'` HTML responses:
   - Injects `ASTRA_FRAME_FIX_SNIPPET` (spoofs `outerWidth`, `outerHeight`, `frameElement = null` so frame-busting checks don't think the app is squished/embedded).
   - Conditionally injects `ASTRA_UNITY_FIX_SNIPPET` if WebGL Unity containers (`#gameContainer`, `UnityLoader`) are detected so canvas resize locks cleanly to full viewport.
   - Conditionally injects `ASTRA_COSMETIC_ADBLOCK_SNIPPET` on ALL sites when adblock is ON.
   - Conditionally injects `ASTRA_YT_ADBLOCK_SNIPPET` on YouTube origins when adblock is ON.

5. **Scramjet XOR Auto-Healing:**
   If a link encoded with Astra's XOR codec (`hvtrs8...` / `hvvr...`) hits `/scramjet/`, `/sw.js` decodes `astraXorDecode` and `302` redirects cleanly to Scramjet's native `%`-encoded path (`/scramjet/https%3A%2F%2F...`).

---

## 7. URL Codecs & Relative Path Recovery

### Codec Rules (`server.js` lines `797-828`)
- `encodeXor(str)`: Applies `charCode ^ 2` to odd character positions, then `encodeURIComponent`. Matches `Ultraviolet.codec.xor.encode`.
- `decodeXor(str)`: `decodeURIComponent`, then `charCode ^ 2` on odd indices. Matches `Ultraviolet.codec.xor.decode`.
- Example: `"https://"` -> `encodeXor` -> starts with `hvtrs8%2F%2F` (or decoded `hvtrs8//`), `"http://"` -> `hvvr`.
- **Fallback Acceptance:** `/scramjet/<tail>` on the Node side accepts BOTH plain `decodeURIComponent(tail)` AND `decodeXor(tail)`. Never assume only one format arrives at `/scramjet/`.

### Relative Path Recovery (`resolveRelativeViaReferer` + `resolvedBaseMap`)
Sites often execute hardcoded fetch paths like `fetch('/graphql')` or `<script src="/chunk-123.js">` that miss DOM shims and hit Astra at:
`GET /scramjet/graphql` or `GET /uv/service/chunk-123.js` (missing `https://`).

How `server.js` recovers cleanly:
1. Inspects `req.headers.referer`.
2. Extracts the underlying remote URL from `/proxy?url=...`, `/scramjet/...`, or `/uv/service/...`.
3. Looks up `resolvedBaseMap.get(refTarget) || refTarget` (LRU-bounded to 500 entries, so `<base href="...">` shifts are preserved!).
4. Resolves `new URL(relWithQuery, baseForRef)` (re-attaching any `reqUrl.searchParams` except internal `adblock=`) and delegates to `fetchAndProxy(...)`.

---

## 8. Node Fallback Proxy (`fetchAndProxy`), Header Sanitization & Cookie Jar Isolation

When editing `fetchAndProxy(targetUrl, adblock, req, res, redirectsLeft = 5, engine = 'scramjet')` (`server.js` lines `2450-2595`), maintain EVERY one of these safeguards:

1. **Pre-Flight Rules:**
   - Ad check -> `204` if `adblock && isBlockedAdHost(targetUrl)`.
   - `cdn.jsdelivr.net/gh/gn-math/<repo>@<tag>/<path>` -> rewritten automatically to `raw.githubusercontent.com/gn-math/<repo>/<branch>/<path>` so blocked CDN game assets still load.
   - `OPTIONS` preflight -> immediate `204` with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods`, and requested headers.

2. **Outbound Request Hygiene:**
   - Strip `HeadlessChrome` from `User-Agent`.
   - Set `'Accept-Encoding': /googlevideo\.com|videoplayback/i.test(targetUrl) ? 'identity' : 'gzip, deflate, br'` (prevents double-compressed/broken video streaming ranges).
   - Forward `Range` header for partial media playback (`206`).
   - Cookie isolation:
     ```js
     const cleanedCookie = req.headers.cookie
       .split(';').map((s) => s.trim())
       .filter((s) => s && !s.startsWith('astra_session='))
       .join('; ');
     ```
     Merge with server-side `getUserCookieHeader(username, parsed.hostname)` for per-user proxied domain jars.

3. **Redirects & Response Header Stripping:**
   - Server-side redirect following on `301/302/303/307/308` (`GET`/`HEAD`/`303`) ALWAYS drains unused body with `proxyRes.resume()` to avoid FD/socket exhaustion!
   - Strip headers that forbid iframe embedding or corrupt rewritten bodies:
     - `x-frame-options`
     - `content-security-policy`, `content-security-policy-report-only`, `x-content-security-policy`
     - `cross-origin-opener-policy`, `cross-origin-embedder-policy`, `cross-origin-resource-policy`
     - `content-length`, `transfer-encoding`, `content-encoding` *(before sending buffered/rewritten bodies)*
   - Rewrite any surviving `Location` header through `makeProxyUrl(absLoc, adblock, eng)`.
   - Persist upstream `Set-Cookie` per Astra user via `saveUserCookiesFromSetCookie()`, never mixing cookies between different logged-in Astra accounts!

4. **Stream Binary, Buffer Text Only:**
   - HTML (`text/html`), CSS (`text/css`), and JS (`javascript`) are buffered (using `decompressBuffer` for `gzip`/`br`/`deflate`) and passed through `rewriteHtml` / `rewriteCss` / `rewriteJs`.
   - Everything else (video, audio, images, fonts, `.wasm`, `.bin`, JSON, etc.) pipes directly via `proxyRes.pipe(res)` with CORS enabled (`Access-Control-Allow-Origin: *`). Never buffer gigabytes of media!

---

## 9. Content Rewriting Engine

### 1. `rewriteHtml(html, baseUrl, adblock, engine)` (`server.js` line `1786`)
- Resolves `<base href="...">` first (`effectiveBase`) and records `baseUrl -> effectiveBase` in `resolvedBaseMap`.
- Removes `integrity="..."` and `nonce="..."` from `<script>` and HTML tags so Subresource Integrity doesn't fail after Astra rewrites scripts.
- Rewrites `<script src>` (`about:blank` if blocked ad, otherwise `makeProxyUrl(...)`) and passes inline JS (`!type`, `*javascript*`, `*ecmascript*`, `module`) through `rewriteJs()`, leaving non-JS blocks (`application/ld+json`, `application/json`, importmaps) untouched!
- Passes `<style>` and inline `style="..."` through `rewriteCss()`.
- Strips `<meta http-equiv="Content-Security-Policy|X-Frame-Options">` and `<base>` tags, rewrites `<meta http-equiv="refresh" content="...;url=...">`, rewrites `src`/`href`/`action`/`poster` and comma-delimited `srcset` entries.
- Injects `buildInjectedShim(effectiveBase, adblock, eng, baseUrl)` immediately after `<head>`.

### 2. `rewriteCss(css, baseUrl, adblock, engine)` (`server.js` line `1846`)
- Rewrites `@import "..."` and `url(...)` via `resolveMaybeUrl` + `makeProxyUrl`, ignoring `data:`, `blob:`, `#`, and already-proxied prefixes.

### 3. `rewriteJs(code)` — Full Lexical State Machine (`server.js` line `1481`)
> **CRITICAL WARNING FOR CODING MODELS:** Never replace `rewriteJs()` with regexes like `.replace(/\blocation\b/g, ...)`! That destroys JSON keys, strings (`"location settings"`), regex literals (`/\/location\//`), comments, and local variable declarations (`const location = ...`), breaking complex apps immediately.

How `rewriteJs` safely scans JS:
- Maintains explicit lexer stack: `code`, `template_text`, `template_expr` (counting `{` `}` brace depth inside `${...}`!), plus `scanString` (`'`, `"`), `scanRegex` (gated by `canRegex` operator context and `[...]` character classes), single-line `//` and block `/* */` comments.
- Tracks `prevSigChar` (ignoring `.` property accesses except safe global containers `window`, `document`, `self`, `globalThis`, `top`, `parent`) and `prevIdent` (ignoring `function location`, `class location`, `var/let/const location`) before rewriting location accessors.

### 4. `buildInjectedShim(...)` (`server.js` line `970`)
Injected into fallback-proxied HTML responses:
- Registers `/sw.js` opportunistically so subsequent requests switch to Wisp/Service Worker mode.
- Overrides `window.fetch`, `navigator.sendBeacon`, `XMLHttpRequest.prototype.open`, `Element.prototype.setAttribute`, `history.pushState`/`replaceState`, property descriptors on `HTML{IFrame,Script,Image,Media,Source,Anchor,Link}Element`, `window.open`, click navigation, and form submissions cleanly.
- Posts `{ type: 'astra-nav', url, engine }` to `window.parent` so Astra's top omnibox stays synchronized.

---

## 10. Multi-Layer Adblocker & YouTube Shield Architecture

Ads slip past single-layer proxies because ad networks load via dynamically injected `<script>` tags, `fetch()` XHR calls inside Wisp, invisible full-screen click overlays, popunder scripts calling `window.open()`, and JSON ad slot payloads (`/youtubei/v1/player`). Astra blocks ads at **five coordinated layers**:

| Layer | Where | What It Blocks / How It Works |
| :--- | :--- | :--- |
| **1. Master Domain & Path Registry** | `AD_HOSTS` + `getMergedAdHosts()` (`server.js` L472, L902) | 110+ ad, popunder, redirect, DSP, analytics, and telemetry domains (DoubleClick, Google Ads/Syndication/TagManager/IMA, PopAds, PopCash, PropellerAds, Monetag, AdMaven, Adsterra/al5sm/dolohen/acscdn, ExoClick, HilltopAds, Clickadu, Taboola, Outbrain, MGID, Amazon AdSystem, Clarity, Hotjar, etc.) + dynamic admin `serverConfig.extraBlockedHosts` + high-confidence ad paths (`/pagead/`, `/prebid*.js`, `/popunder*.js`, `/gpt/pubads_impl`, `/vast.xml`, `/vpaid`, `/adserver/`, YouTube ad APIs). |
| **2. Service Worker Transport Choke (`BareClient`)** | `patchBareClientInstance()` in `/sw.js` (`server.js` L2949) | Intercepts **every** Scramjet and Ultraviolet outbound Wisp fetch (even internal subresources/redirects that skipped URL pre-checks) BEFORE `origFetch()`. Returns MIME-safe benign stubs via `createBlockedAdResponse()` (`/* blocked */` for JS/CSS so scripts don't throw `SyntaxError`, `{}` for JSON APIs so `r.json()` doesn't crash, `204` otherwise). |
| **3. YouTube Video Ad Eliminator** | `patchedBareFetch` + `ASTRA_YT_ADBLOCK_SNIPPET` (`server.js` L3090 & L2820) | Scrubs `adPlacements`, `playerAds`, and `adSlots` directly out of `/youtubei/v1/player` JSON responses + hides YouTube banner/feed ad renderers (`#masthead-ad`, `ytd-ad-slot-renderer`, etc.) + auto-clicks skip buttons + fast-forwards (`playbackRate = 16`, muted, jump to `duration - 0.1`) during `.ad-showing`. |
| **4. Universal Cosmetic & Popunder Shield** | `ASTRA_COSMETIC_ADBLOCK_SNIPPET` in `maybePatchProxiedHtml` (`server.js` L2813) | Injected into **all** proxied HTML documents/iframes when `adblock` is ON: hides Google AdSense/GPT/Taboola/Outbrain/MGID containers via CSS, intercepts ad `window.open` popups inside the proxied frame, and neutralizes full-viewport invisible `position: fixed` transparent popunder trap overlays on click. |
| **5. Outer UI & Live Telemetry Counter** | `AD_TRACKER_HOSTS`, `sanitizeUrl()`, SW listener (`index.html` L8474, L9100) | Sanitizes tracking query parameters (`utm_*`, `fbclid`, `gclid`, `yclid`, `mc_*`), blocks popups on the outer shell, calls `syncAdblockToServiceWorker()` (both `.controller` and `.ready`), and listens for `astra-ad-blocked` `postMessage`s from `/sw.js` to increment the footer shield badge live. |

**Important Adblock Rule:** Never break `sentry.io`, `googleapis.com`, `gstatic.com`, `jsdelivr.net`, or root `youtube.com`! Always return MIME-appropriate benign stubs (`200` JS/CSS/JSON) inside `BareClient` rather than hard network errors so anti-adblock scripts don't throw uncaught exceptions that halt page rendering.

---

## 11. Wisp & Chat WebSocket Upgrade Pipeline

Inspect `server.on('upgrade')` (`server.js` lines `5715+`):
- Only two WebSocket endpoints exist:
  1. **`/wisp` / `/wisp/`:**
     - Checks `req.headers.origin` against `req.headers['x-forwarded-host'] || req.headers.host` -> returns `403` on cross-site hijacks while respecting HTTPS reverse proxies (Render, Cloudflare, Nginx).
     - Enforces `maintenanceMode` (`503` if non-admin).
     - Configures `wisp.server.options.allow_direct_ip = true`, `allow_private_ips = false`, `allow_loopback_ips = false` (SSRF protection).
     - Hands off to `wisp.server.routeRequest(req, socket, head)`.
  2. **`/chat-ws`:**
     - Verifies `getSessionUser(req)` -> returns `401` and destroys socket if unauthenticated.
     - Upgrades via `chatWss.handleUpgrade(req, socket, head, (ws) => chatWss.emit('connection', ws, req, sessionUser))`.
- Unrecognized upgrade paths immediately `socket.destroy()`.

---

## 12. LucideBlox / Roblox Dual-Mode Proxy

- **Problem Solved:** Pure public Wisp relays frequently fail Roblox API CORS/auth handshakes, and Roblox authentication inside proxied iframes can fail silently.
- **How Astra Solves It (`serveWebbloxAsset` + `proxyWebbloxApiRequest`):**
  1. Serves bundled/upstream LucideBlox assets under `/3to1s93ve/` with in-memory caching (`webbloxMemCache`).
  2. Injects a lightweight bridge into `/3to1s93ve/launcher/index.html` setting `window.WEBLOX_SERVER = true` (unless `?mode=wisp`), mapping `/__proxy__/*` -> `/3to1s93ve/__nodeproxy__/*`, attaching `x-astra-roblox-cookie` from `localStorage['cobalt-cookies']`, rewriting `webblox.transport` away from legacy relays to `${wsProto}${host}/wisp/`, and showing an inline `robloxcookie=` recovery modal if `users.roblox.com/v1/users/authenticated` returns `401`.
  3. Patches `webblox/sw.js` so `/__nodeproxy__/` bypasses Service Worker interception cleanly.
  4. **Quick Connect URL (`/robloxcookie=<cookie>`):** Server validates the `.ROBLOSECURITY` cookie against Roblox, stores it server-side per user, writes `cobalt-cookies` across `roblox.com`, `rbxcdn.com`, `robloxlabs.com`, and reloads directly into `/g`/`roblox`.
  5. **New-Tab Play Launch:** Game Play button opens the Roblox experience in a **new isolated browser tab** synchronously on user click (with a fallback clickable `<a>` modal if popups are blocked), avoiding COOP/COEP/CSP protocol traps inside nested dashboard iframes.

---

## 13. Astra Music Search, Extraction & Streaming Waterfall

Endpoints `/api/music/home`, `/api/music/search`, `/api/music/audio/:id`, `/api/music/lyrics`, `/api/music/import-spotify`, `/api/music/playlists`, `/api/music/liked`:
- **Search Resilience:** Tries YouTube `WEB` Innertube -> `WEB_REMIX` -> YouTube HTML scrape -> live Invidious instances (`getLiveInvidiousHosts()`) -> SoundCloud (`getSoundCloudClientId()`).
- **Streaming Resilience:** Multi-client extraction + `@distube/ytdl-core` + SoundCloud + Invidious, passing HTTP `Range` requests through cleanly (`206`), with client `youtube-nocookie.com` iframe fallback in `index.html` when direct audio streams are throttled.
- **Persistence:** `music-likes.json` and `music-playlists.json` live inside `DATA_DIR`.

---

## 14. Auth, Sessions, RBAC, Admin & User State

- **Session Cookie (`astra_session`):** Signed with HMAC using `serverConfig.sessionSecret`, `HttpOnly; Path=/`, `SameSite=None; Secure` behind TLS proxies (`x-forwarded-proto === 'https'`), `SameSite=Lax` over plain HTTP localhost.
- **Passwords:** Scrypt hashes (`crypto.scryptSync` + 16-byte random salt) verified with `crypto.timingSafeEqual`. Legacy/secondary hashes supported via `extraHashes`.
- **Roles (`role` vs `visualRoles`):**
  - Authorization relies EXCLUSIVELY on `sessionUser.role` (`'admin'` vs `'user'`).
  - `coolbacon` is primary admin; other accounts (`kingsley`, `jase`, `mason`, `ledger`, etc.) have `role: 'user'`.
  - `visualRoles` (`Astra Owner`, `LBP Fans`, `Snoop Dogg Fan`, etc.) are **strictly cosmetic** (`visualOnly: true`), NEVER granting admin routes (`/api/admin/*`, `#announcements`, `/botupdate`).
  - `astra-owner` crown (`ownerOnly: true`) is server-enforced for `coolbacon` only (`403` otherwise).
- **Onboarding Tour Persistence (`tour-prefs.json`):** Stores per-username `neverShow` state in `DATA_DIR/tour-prefs.json` so non-`coolbacon` accounts continue seeing the interactive startup walkthrough on every login until explicitly clicking `never show again`.

---

## 15. Crash-Safe Atomic Persistence

Look closely at `server.js` lines `15-82` and `4759-4848` so you understand why Astra used to lose chat history and how it is protected now:

1. **`DATA_DIR` Resolution:**
   Tries in order: `process.env.ASTRA_DATA_DIR` -> `/data` -> `/var/data` -> `ROOT_DIR`, verifying directory creation & `fs.constants.W_OK` before selecting.
2. **Legacy Migration (`migrateLegacyStoreFile`):**
   On boot, if `DATA_DIR !== ROOT_DIR` and a store file exists in `ROOT_DIR` while missing in `DATA_DIR`, copies it cleanly once without overwriting existing persistent data.
3. **Atomic Writes (`writeJsonStoreAtomic`):**
   - Serializes JSON -> writes `${filePath}.tmp.${process.pid}` -> `fs.renameSync(tmp, filePath)` -> mirrors a clean backup `${filePath}.bak`.
   - Prevents truncated 0-byte or half-written JSON files if the server is force-killed mid-write during uploads of large animated GIF avatars/banners!
4. **Resilient Reads (`readJsonStoreSafe`):**
   - Reads primary `filePath`; if corrupted/truncated, falls back seamlessly to `${filePath}.bak` rather than resetting channels to `{ general: [] }`.
5. **In-Memory Singleton (`chatStoreCache`):**
   - Avoids race conditions where two concurrent requests (`POST /api/chat/messages` vs `/api/chat/decoration`) overwrite each other's changes.
   - `SIGINT` and `SIGTERM` shutdown listeners flush `chatStoreCache`, `authStore`, and `tourPrefs` before exiting.

---

## 16. Discord-Style Chat, `#updates`, `#roles`, GIFs, Stickers, Banners & WebRTC Voice

- **Built-In Channels (`DEFAULT_CHAT_CHANNELS`):**
  - `#announcements` (locked, `adminOnly: true`, server announcements — does NOT contain Astra Bot changelog clutter)
  - `#updates` (locked, `adminOnly: true`, dedicated Astra Bot update drops + `#chatBotUpdatesBtn` target)
  - `#roles` (locked, hosts `#chatRoleStudioCard` visual role picker/creator)
  - `#general`, `#off-topic`, `#roblox-squads`, and `#voice-lounge` (`type: 'voice'`, WebRTC mesh via `/chat-ws`)
- **Astra Bot (`astra-bot`):** Uses custom avatar `/assets/chat/astra-bot-pfp.png`, responds to `!updates`, `@astra bot`, and admin `/botupdate <msg>`.
- **Default Visual Identities:**
  - `coolbacon`: `Astra Owner` (`👑`)
  - `mason` & `jase`: `/assets/chat/lego-starwars-pfp.png` + `LBP Fans` (`/assets/chat/lbp-sticker.jpg`)
  - `kingsley`: `/assets/chat/snoop-dogg-pfp.jpg` + `Snoop Dogg Fan`
  - Hovering ANY role icon (`.chat-role-icon-badge[data-role-name]:hover::after`) shows the role title instantly; clicking any member/author/avatar opens `#chatUserProfilePopover` with banner, decoration, custom status bubble, role pills, and bio.
- **Media & Animated GIF PFPs Rule:**
  - `/api/chat/gifs?q=...` scrapes live Tenor search results (`media.tenor.com/.../*.gif`) without an API key, cached 10 min in `chatGifSearchCache`.
  - When a user uploads an animated `.gif` via `#chatAvatarInput`, `index.html` MUST bypass `<canvas>` (`openPfpCropModal`) and upload the raw DataURL straight to `/api/chat/avatar`—otherwise `<canvas>` freezes animated GIFs into 1 static JPEG frame!

---

## 17. Complete API Endpoint Reference

| Endpoint | Methods | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `/api/health` | `GET` | Public | Server readiness + public config |
| `/api/auth/login`, `/logout`, `/me` | `POST`/`GET` | Public / Session | Scrypt login, HMAC session cookie, current user profile (`avatar`, `banner`, `bio`, `decoration`, `visualRoles`) |
| `/api/auth/tour-done` | `POST` | Session | Persist `"never show again"` startup tour state in `tour-prefs.json` |
| `/api/roblox/status`, `/verify`, `/logout` | `GET`/`POST` | Session | Server-side `.ROBLOSECURITY` status & verification |
| `/api/admin/state`, `/config`, `/users` | `GET`/`POST` | Admin | Manage MOTD, maintenanceMode, defaultEngine, `extraBlockedHosts`, user accounts & passwords |
| `/api/music/home`, `/search`, `/lyrics`, `/audio/:id` | `GET` | Session | Multi-tier YouTube/Invidious/SoundCloud search, lyrics, and audio streaming |
| `/api/music/playlists`, `/liked`, `/import-spotify` | `GET`/`POST` | Session | Persistent user likes, playlists, Spotify playlist import |
| `/api/chat/messages` | `GET`/`POST`/`DELETE` | Session | Load/post/delete messages (supports `mediaUrl`, `mediaType`, `replyToId`, `!updates`, `/botupdate`) |
| `/api/chat/channels`, `/channels/reorder` | `POST`/`DELETE` | Session | Create, delete, and persist drag-and-drop / `↑↓` channel ordering |
| `/api/chat/react` | `POST` | Session | Toggle emoji reactions per message & broadcast WS update |
| `/api/chat/avatar` | `POST` | Session | Save cropped PFP, raw animated `.gif` data URI, or Tenor/Giphy/Discord CDN `.gif` URL (up to 4 MB) |
| `/api/chat/decoration` | `POST` | Session | Save avatar decoration, custom status, banner (image/GIF/gradient), bio, displayName, and username rename |
| `/api/chat/roles` | `GET`/`POST` | Session | List, toggle equip, create, or delete cosmetic `visualRoles` (`astra-owner` locked to `coolbacon`) |
| `/api/chat/gifs` | `GET` | Session | Live Tenor GIF/sticker URL search (cached) |
| `/api/ai/chat`, `/api/ai/gemini` | `POST` | Session | Built-in `/ai` screen-share & assistant model routing |
| `/api/user/state` | `GET`/`POST` | Session | Persist settings, adblock config/counter, recent games, tabs, AI threads |
| `/api/games` | `GET` | Session | Built-in `/g` gn-math HTML5 games catalog feed |

---

## 18. Common Bugs, Anti-Patterns & Debugging Playbooks

1. **Bug: "Site loads blank or breaks scripts when proxied in fallback mode"**
   - Check if `rewriteJs()` was replaced with regexes or if `integrity="..."` / `content-security-policy` survived `rewriteHtmlAttributesAndStyles()`.
2. **Bug: "Ads still appear inside Scramjet/Ultraviolet pages"**
   - Check `AD_HOSTS`, `patchBareClientInstance()` pre-flight `isAdBlockedTarget()`, `maybePatchProxiedHtml()`, and ensure the browser refreshed `/sw.js` (`Cache-Control: no-store`). Confirm `createBlockedAdResponse()` returns `200` valid JS/CSS/JSON stubs for scripts/APIs rather than breaking callers.
3. **Bug: "Entire Astra frontend clicks/views stop responding"**
   - Almost always a syntax error inside the monolith `<script>` block of `index.html`. Run `new vm.Script(...)` on the extracted `<script>` body immediately.
4. **Bug: "Service Worker failed / `$scramjet` IndexedDB error on startup"**
   - Verify `ensureProxyRuntimeReady()` IDB `'config'` self-heal check runs BEFORE `navigator.serviceWorker.register('/sw.js')`, and ensure `/sw.js` itself parses cleanly with `new vm.Script(...)`.
5. **Bug: "Chat history wiped after server restart"**
   - Verify `DATA_DIR` points to a writable persistent mount (`ASTRA_DATA_DIR`, `/data`, or `/var/data` on Render; `ROOT_DIR` locally), confirm `AUTH_FILE` / `CHAT_FILE` / `CHAT_ROLES_FILE` go through `writeJsonStoreAtomic`, and ensure `chat-messages.json.bak` exists. Note: on Render **free tier with no disk attached**, ephemeral container storage wipes on every deploy by platform design—use a persistent disk mounted at `/data` or `/var/data`!
6. **Bug: "Uploaded animated GIF PFP doesn't animate"**
   - Confirm `#chatAvatarInput` checks `file.type === 'image/gif'` and skips `openPfpCropModal` (canvas re-encoding strips animation frames).
7. **Bug: "Works locally on Windows, breaks on Render"**
   - Check: (a) `server.listen(PORT, '0.0.0.0')`, (b) WebSocket URL derives `wss://` on HTTPS pages, (c) `astra-github-ready` `clever-cloak` relative path (`src="clever-cloak/Clever.html"`), (d) no Linux path case-sensitivity mismatch (`assets/chat/...`).

---

## 19. Mandatory Verification & Deployment Checklist

Run these commands after EVERY edit before restarting or pushing:

```powershell
# 1. Backend syntax check
node -c C:\Users\cheli\.gemini\antigravity\scratch\astra-ui\server.js

# 2. Monolith frontend <script> syntax check
@'
const fs = require('fs'), vm = require('vm');
const h = fs.readFileSync('C:/Users/cheli/.gemini/antigravity/scratch/astra-ui/index.html', 'utf8');
const m = h.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) throw new Error('missing main script');
new vm.Script(m[1]);
console.log('index.html <script> OK');
'@ | node -

# 3. Restart cleanly on 0.0.0.0:6740 with 128 KB header limit
Get-NetTCPConnection -LocalPort 6740 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300
node --max-http-header-size=131072 C:\Users\cheli\.gemini\antigravity\scratch\astra-ui\server.js
```

After startup, verify:
1. `GET /api/health` -> `200`, console prints `Astra server running at http://0.0.0.0:6740`.
2. `GET /sw.js` -> `200`, `Cache-Control: no-store`, passes `new vm.Script(swText)`.
3. Adblock smoke check -> `GET /proxy?url=https://doubleclick.net/pixel` (with session) returns `204`, `isAdBlockedTarget` returns benign JS/JSON stubs inside SW.
4. No synthetic test records left behind in `chat-messages.json`, `chat-roles.json`, or `auth-store.json`.
5. Sync `astra-ui` -> `astra-github-ready`, check `node -c server.js`, commit, and `git push origin main`.
