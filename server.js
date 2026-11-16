const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');
const { scramjetPath } = require('@mercuryworkshop/scramjet/path');
const { uvPath } = require('@titaniumnetwork-dev/ultraviolet');
const { baremuxPath } = require('@mercuryworkshop/bare-mux/node');
const wisp = require('@mercuryworkshop/wisp-js/server');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 6740;
const ROOT_DIR = __dirname;
const DATA_DIR = (() => {
  const candidates = [
    process.env.ASTRA_DATA_DIR,
    fs.existsSync('/data') ? '/data' : null,
    fs.existsSync('/var/data') ? '/var/data' : null,
    ROOT_DIR
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  return ROOT_DIR;
})();

function migrateLegacyStoreFile(filename) {
  const dest = path.join(DATA_DIR, filename);
  if (DATA_DIR !== ROOT_DIR && !fs.existsSync(dest)) {
    const legacy = path.join(ROOT_DIR, filename);
    try {
      if (fs.existsSync(legacy)) fs.copyFileSync(legacy, dest);
    } catch {}
  }
  return dest;
}

function readJsonStoreSafe(filePath, fallback = null) {
  for (const p of [filePath, filePath + '.bak']) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      if (!raw || !raw.trim()) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return fallback;
}

function writeJsonStoreAtomic(filePath, data) {
  const serialized = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, filePath);
    try {
      fs.writeFileSync(filePath + '.bak', serialized, 'utf8');
    } catch {}
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(filePath, serialized, 'utf8');
  }
}

const EPOXY_PATH = path.join(ROOT_DIR, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist');
const LIBCURL_PATH = path.join(ROOT_DIR, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist');
const SERVER_START_MS = Date.now();
const SERVER_BOOT_ID = String(Math.round((Date.now() - os.uptime() * 1000) / 300000));
const AUTH_FILE = migrateLegacyStoreFile('auth-store.json');
const CONFIG_FILE = migrateLegacyStoreFile('astra-server-config.json');
const CHAT_FILE = migrateLegacyStoreFile('chat-messages.json');
let chatStoreCache = null;

const musicStreamCache = new Map();
let ytdlInstancePromise = null;
let cachedSoundCloudClientId = { id: '', expiresAt: 0 };
let cachedInvidiousHosts = { hosts: [], expiresAt: 0 };

async function getYtdlInstance() {
  if (!ytdlInstancePromise) {
    ytdlInstancePromise = import('@distube/ytdl-core').then(({ Ytdl }) => new Ytdl()).catch((err) => {
      ytdlInstancePromise = null;
      throw err;
    });
  }
  return ytdlInstancePromise;
}

async function getSoundCloudClientId() {
  if (cachedSoundCloudClientId.id && Date.now() < cachedSoundCloudClientId.expiresAt) {
    return cachedSoundCloudClientId.id;
  }
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const html = await fetch('https://soundcloud.com', {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' }
    }).then((r) => r.text());
    clearTimeout(timer);
    const scriptUrls = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g)].map((m) => m[0]);
    for (const su of scriptUrls.slice(-4)) {
      const ac2 = new AbortController();
      const t2 = setTimeout(() => ac2.abort(), 4500);
      const js = await fetch(su, { signal: ac2.signal }).then((r) => r.text()).catch(() => '');
      clearTimeout(t2);
      const m = js.match(/client_id:"([A-Za-z0-9]{20,40})"/);
      if (m) {
        cachedSoundCloudClientId = { id: m[1], expiresAt: Date.now() + 6 * 3600 * 1000 };
        return m[1];
      }
    }
  } catch {}
  return '';
}

async function getLiveInvidiousHosts() {
  if (cachedInvidiousHosts.hosts.length && Date.now() < cachedInvidiousHosts.expiresAt) {
    return cachedInvidiousHosts.hosts;
  }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const dir = await fetch('https://api.invidious.io/instances.json?sort_by=health', { signal: ac.signal }).then((r) => r.json());
    clearTimeout(t);
    const hosts = [];
    if (Array.isArray(dir)) {
      for (const row of dir.slice(0, 16)) {
        const meta = row && row[1];
        if (meta && meta.api && meta.uri && /^https:\/\//i.test(meta.uri)) {
          hosts.push(meta.uri.replace(/\/+$/, ''));
        }
      }
    }
    if (hosts.length) {
      cachedInvidiousHosts = { hosts: hosts.slice(0, 8), expiresAt: Date.now() + 15 * 60 * 1000 };
      return cachedInvidiousHosts.hosts;
    }
  } catch {}
  return [];
}

async function resolveSoundCloudStreamByQuery(query, cid) {
  if (!cid || !query) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const sr = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&limit=8&client_id=${encodeURIComponent(cid)}`, { signal: ac.signal }).then((r) => r.json());
    clearTimeout(t);
    const items = Array.isArray(sr && sr.collection) ? sr.collection : [];
    for (const tr of items) {
      const prog = tr && tr.media && Array.isArray(tr.media.transcodings)
        ? tr.media.transcodings.find((x) => x && x.format && x.format.protocol === 'progressive' && x.url)
        : null;
      if (prog) {
        const sj = await fetch(`${prog.url}?client_id=${encodeURIComponent(cid)}`).then((r) => r.json()).catch(() => null);
        if (sj && sj.url) {
          return { url: sj.url, mime: 'audio/mpeg', contentLength: 0, expiresAt: Date.now() + 20 * 60 * 1000 };
        }
      }
    }
  } catch { clearTimeout(t); }
  return null;
}

async function resolveMusicAudioStreamUrl(videoId, forceRefresh = false, meta = {}) {
  const rawId = String(videoId || '').trim();
  const isSc = /^sc:[0-9]+$/i.test(rawId);
  const cleanId = isSc ? rawId : rawId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!cleanId) throw new Error('Invalid track id');
  const cached = !forceRefresh && musicStreamCache.get(cleanId);
  if (cached && cached.expiresAt > Date.now() && cached.url) {
    return cached;
  }

  let entry = null;
  if (isSc) {
    const cid = await getSoundCloudClientId();
    if (cid) {
      const scNum = cleanId.slice(3);
      const tr = await fetch(`https://api-v2.soundcloud.com/tracks/${scNum}?client_id=${encodeURIComponent(cid)}`).then((r) => r.json()).catch(() => null);
      const prog = tr && tr.media && Array.isArray(tr.media.transcodings)
        ? tr.media.transcodings.find((x) => x && x.format && x.format.protocol === 'progressive' && x.url)
        : null;
      if (prog) {
        const sj = await fetch(`${prog.url}?client_id=${encodeURIComponent(cid)}`).then((r) => r.json()).catch(() => null);
        if (sj && sj.url) entry = { url: sj.url, mime: 'audio/mpeg', contentLength: 0, expiresAt: Date.now() + 20 * 60 * 1000 };
      }
    }
  } else {
    // Tier 1: @distube/ytdl-core HTTP 206 stream (primary Achroma method)
    try {
      const ytdl = await getYtdlInstance();
      const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${cleanId}`);
      const audioFmts = (info.formats || []).filter((f) => f && f.hasAudio && !f.hasVideo && f.url);
      const mp4Fmts = audioFmts.filter((f) => /audio\/mp4/i.test(f.mimeType || '')).sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
      const chosen = mp4Fmts[0] || audioFmts.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0] || (info.formats || []).find((f) => f && f.hasAudio && f.url);
      if (chosen && chosen.url) {
        entry = {
          url: chosen.url,
          mime: String(chosen.mimeType || 'audio/mp4').split(';')[0].trim(),
          contentLength: chosen.contentLength ? Number(chosen.contentLength) : 0,
          expiresAt: Date.now() + 25 * 60 * 1000
        };
      }
    } catch {}

    // Tier 2: Live healthy Invidious audio fallback (when Railway datacenter IP is YouTube bot-blocked)
    if (!entry) {
      const hosts = await getLiveInvidiousHosts();
      for (const h of hosts.slice(0, 4)) {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 3500);
          const vr = await fetch(`${h}/api/v1/videos/${encodeURIComponent(cleanId)}`, { signal: ac.signal });
          clearTimeout(t);
          if (!vr.ok) continue;
          const vj = await vr.json();
          const fmts = (vj.adaptiveFormats || []).filter((f) => f && /audio/i.test(f.type || '') && f.url);
          const mp4 = fmts.find((f) => /audio\/mp4/i.test(f.type || '')) || fmts[0];
          if (mp4 && mp4.url) {
            entry = {
              url: mp4.url,
              mime: String(mp4.type || 'audio/mp4').split(';')[0].trim(),
              contentLength: mp4.clen ? Number(mp4.clen) : 0,
              expiresAt: Date.now() + 20 * 60 * 1000
            };
            break;
          }
        } catch {}
      }
    }

    // Tier 3: SoundCloud progressive MP3 match using song title + artist
    if (!entry && (meta.title || meta.artist)) {
      const cid = await getSoundCloudClientId();
      const q = `${meta.title || ''} ${meta.artist || ''}`.trim();
      entry = await resolveSoundCloudStreamByQuery(q, cid);
    }
  }

  if (!entry || !entry.url) {
    throw new Error('No playable audio format found');
  }
  if (musicStreamCache.size > 120) {
    const firstKey = musicStreamCache.keys().next().value;
    if (firstKey) musicStreamCache.delete(firstKey);
  }
  musicStreamCache.set(cleanId, entry);
  return entry;
}

const chatWss = new WebSocketServer({ noServer: true });
const chatClients = new Set();
const voicePeers = new Map();

function broadcastChatWs(payload, excludeWs = null) {
  const msgStr = JSON.stringify(payload);
  for (const client of chatClients) {
    if (client !== excludeWs && client.readyState === 1) {
      try { client.send(msgStr); } catch {}
    }
  }
}

function getVoicePeerList() {
  return Array.from(voicePeers.values()).map((p) => ({
    peerId: p.peerId,
    username: p.username,
    displayName: p.displayName,
    role: p.role,
    voiceChannel: p.voiceChannel || 'voice-lounge',
    muted: !!p.muted,
    deafened: !!p.deafened
  }));
}

const CHAT_ROLES_FILE = path.join(DATA_DIR, 'chat-roles.json');
const DEFAULT_VISUAL_ROLES = [
  { id: 'astra-owner', name: 'Astra Owner', iconType: 'emoji', icon: '👑', color: '#fbbf24', locked: true, ownerOnly: true },
  { id: 'lbp-fans', name: 'LBP Fans', iconType: 'image', icon: '/assets/chat/lbp-sticker.jpg', color: '#60a5fa', locked: true },
  { id: 'snoop-dogg-fan', name: 'Snoop Dogg Fan', iconType: 'image', icon: '/assets/chat/snoop-dogg-pfp.jpg', color: '#a855f7', locked: true },
  { id: 'star-wars-fan', name: 'Star Wars Fan', iconType: 'image', icon: '/assets/chat/lego-starwars-pfp.png', color: '#38bdf8', locked: true },
  { id: 'vip-vibes', name: 'Astra VIP', iconType: 'emoji', icon: '✨', color: '#c084fc', locked: true },
  { id: 'gamer', name: 'Gamer', iconType: 'emoji', icon: '🎮', color: '#4ade80', locked: true }
];

function readVisualRolesStore() {
  const parsed = readJsonStoreSafe(CHAT_ROLES_FILE, []);
  const custom = Array.isArray(parsed) ? parsed : [];
  const merged = DEFAULT_VISUAL_ROLES.map((r) => ({ ...r }));
  for (const r of custom) {
    if (r && r.id && !merged.some((x) => x.id === r.id)) merged.push(r);
  }
  return merged;
}

function writeCustomVisualRolesStore(allRoles) {
  const builtinIds = new Set(DEFAULT_VISUAL_ROLES.map((r) => r.id));
  const customOnly = (Array.isArray(allRoles) ? allRoles : []).filter((r) => r && r.id && !builtinIds.has(r.id));
  try {
    writeJsonStoreAtomic(CHAT_ROLES_FILE, customOnly);
  } catch {}
}

function resolveUserVisualRoles(u) {
  if (!u) return [];
  const all = readVisualRolesStore();
  const byId = new Map(all.map((r) => [r.id, r]));
  let ids = Array.isArray(u.visualRoles) ? u.visualRoles.slice() : [];
  if (u.username === 'coolbacon' && !ids.includes('astra-owner')) {
    ids = ['astra-owner', ...ids];
  }
  const resolved = [];
  for (const id of ids) {
    const found = byId.get(id);
    if (found) resolved.push(found);
  }
  return resolved;
}

const chatGifSearchCache = new Map();

function getChatMembersList() {
  const onlineNames = new Set();
  for (const c of chatClients) {
    if (c.readyState === 1 && c.astraSession && c.astraSession.username) {
      onlineNames.add(c.astraSession.username);
    }
  }
  for (const p of voicePeers.values()) {
    if (p.username) onlineNames.add(p.username);
  }
  const users = (typeof authStore !== 'undefined' && authStore && authStore.users) ? authStore.users : {};
  const list = Object.values(users).map((u) => ({
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role || 'user',
    avatar: u.avatar || '',
    banner: u.banner || '',
    bio: u.bio || '',
    decoration: u.decoration || '',
    customStatus: u.customStatus || '',
    visualRoles: resolveUserVisualRoles(u),
    online: onlineNames.has(u.username)
  }));
  list.push({
    username: 'astra-bot',
    displayName: 'Astra Bot',
    role: 'bot',
    isBot: true,
    avatar: '/assets/chat/astra-bot-pfp.png',
    banner: '',
    bio: 'Automated Astra update & changelog courier. Type !updates in any channel!',
    decoration: 'astra-halo',
    customStatus: 'type !updates anytime',
    visualRoles: [{ id: 'astra-bot-role', name: 'Verified Bot', iconType: 'emoji', icon: '🤖', color: '#5865f2' }],
    online: true
  });
  return list.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
}

chatWss.on('connection', (ws, req, sessionUser) => {
  const peerId = crypto.randomBytes(6).toString('hex');
  ws.astraSession = {
    peerId,
    username: sessionUser.username,
    displayName: sessionUser.displayName || sessionUser.username,
    role: sessionUser.role || 'user'
  };
  chatClients.add(ws);
  try {
    ws.send(JSON.stringify({ type: 'welcome', peerId, voicePeers: getVoicePeerList(), members: getChatMembersList() }));
    broadcastChatWs({ type: 'members-update', members: getChatMembersList() }, ws);
  } catch {}

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw || ''));
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'voice-join') {
        voicePeers.set(peerId, {
          peerId,
          ws,
          username: ws.astraSession.username,
          displayName: ws.astraSession.displayName,
          role: ws.astraSession.role,
          voiceChannel: String(msg.channel || 'voice-lounge').slice(0, 40),
          muted: !!msg.muted,
          deafened: !!msg.deafened
        });
        broadcastChatWs({ type: 'voice-peers', voicePeers: getVoicePeerList(), joinedPeerId: peerId });
      } else if (msg.type === 'typing') {
        broadcastChatWs({
          type: 'typing',
          channel: String(msg.channel || 'general').slice(0, 40),
          username: ws.astraSession.username,
          displayName: ws.astraSession.displayName
        }, ws);
      } else if (msg.type === 'voice-leave') {
        if (voicePeers.delete(peerId)) {
          broadcastChatWs({ type: 'voice-peers', voicePeers: getVoicePeerList(), leftPeerId: peerId });
        }
      } else if (msg.type === 'voice-state') {
        const cur = voicePeers.get(peerId);
        if (cur) {
          cur.muted = !!msg.muted;
          cur.deafened = !!msg.deafened;
          broadcastChatWs({ type: 'voice-peers', voicePeers: getVoicePeerList() });
        }
      } else if (msg.type === 'rtc-signal' && msg.to) {
        const target = voicePeers.get(String(msg.to));
        if (target && target.ws && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({
            type: 'rtc-signal',
            from: peerId,
            fromUser: ws.astraSession,
            signal: msg.signal
          }));
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    chatClients.delete(ws);
    if (voicePeers.delete(peerId)) {
      broadcastChatWs({ type: 'voice-peers', voicePeers: getVoicePeerList(), leftPeerId: peerId });
    }
    broadcastChatWs({ type: 'members-update', members: getChatMembersList() });
  });
});

try {
  wisp.logging.set_level(wisp.logging.WARN);
  wisp.server.options.allow_direct_ip = true;
  wisp.server.options.allow_private_ips = false;
  wisp.server.options.allow_loopback_ips = false;
} catch {}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'fundingchoicesmessages.google.com',
  'imasdk.googleapis.com',
  'ima3vpaid.appspot.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'propellerclick.com',
  'monetag.com',
  'onclickalgo.com',
  'onclickmax.com',
  'onclickperformance.com',
  'exoclick.com',
  'exosrv.com',
  'adsterra.com',
  'adsterratools.com',
  'al5sm.com',
  'dolohen.com',
  'thaudray.com',
  'acscdn.com',
  'admaven.com',
  'hilltopads.net',
  'juicyads.com',
  'trafficjunky.net',
  'trafficfactory.biz',
  'ero-advertising.com',
  'clickadu.com',
  'evadav.com',
  'rollerads.com',
  'galaksion.com',
  'richpush.co',
  'richads.com',
  'adspyglass.com',
  'pushground.com',
  'taboola.com',
  'outbrain.com',
  'mgid.com',
  'revcontent.com',
  'zergnet.com',
  'nativery.com',
  'ads.yahoo.com',
  'adnxs.com',
  'criteo.com',
  'criteo.net',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'openx.com',
  'casalemedia.com',
  'indexexchange.com',
  '33across.com',
  'sovrn.com',
  'lijit.com',
  'sonobi.com',
  'smartadserver.com',
  'adsrvr.org',
  'bidswitch.net',
  'contextweb.com',
  'rhythmone.com',
  'triplelift.com',
  'gumgum.com',
  'sharethrough.com',
  'yieldmo.com',
  'teads.tv',
  'spotxchange.com',
  'spotx.tv',
  'springserve.com',
  'connatix.com',
  'amazon-adsystem.com',
  'flashtalking.com',
  'sizmek.com',
  'serving-sys.com',
  'moatads.com',
  'doubleverify.com',
  'adsafeprotected.com',
  'iasds01.com',
  'mediavine.com',
  'cafemedia.com',
  'adthrive.com',
  'raptive.com',
  'ezoic.net',
  'ezodn.com',
  'nitropay.com',
  'snigelweb.com',
  'buysellads.com',
  'carbonads.net',
  'carbonads.com',
  'cpmstar.com',
  'playwire.com',
  'intergi.com',
  'adform.net',
  'mathtag.com',
  'bluekai.com',
  'demdex.net',
  'omtrdc.net',
  'krxd.net',
  'rlcdn.com',
  'quantserve.com',
  'scorecardresearch.com',
  'chartbeat.com',
  'hotjar.com',
  'mouseflow.com',
  'fullstory.com',
  'clarity.ms',
  'mc.yandex.ru',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'ads-twitter.com',
  'analytics.twitter.com',
  'bat.bing.com',
  'ads.linkedin.com',
  'mixpanel.com',
  'amplitude.com',
  'heapanalytics.com',
  'branch.io',
  'appsflyer.com',
  'adjust.com',
  'kochava.com',
  'singular.net',
  'ouo.io',
  'ouo.press',
  'adf.ly',
  'linkvertise.com'
];

function loadServerConfig() {
  const defaults = {
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    motd: '',
    maintenanceMode: false,
    defaultEngine: 'scramjet',
    adblockDefault: true,
    extraBlockedHosts: []
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const merged = { ...defaults, ...parsed };
      if (merged.defaultEngine !== 'scramjet' && merged.defaultEngine !== 'ultraviolet') {
        merged.defaultEngine = 'scramjet';
      }
      return merged;
    }
  } catch {}
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf8');
  } catch {}
  return defaults;
}

let serverConfig = loadServerConfig();

function saveServerConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(serverConfig, null, 2), 'utf8');
  } catch {}
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyHashPair(password, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const derived = crypto.scryptSync(String(password), salt, 64);
    const stored = Buffer.from(hash, 'hex');
    if (derived.length !== stored.length) return false;
    return crypto.timingSafeEqual(derived, stored);
  } catch {
    return false;
  }
}

function verifyPassword(password, record) {
  if (!record) return false;
  if (verifyHashPair(password, record.salt, record.hash)) return true;
  if (Array.isArray(record.extraHashes)) {
    return record.extraHashes.some((entry) => entry && verifyHashPair(password, entry.salt, entry.hash));
  }
  return false;
}

function loadAuthStore() {
  let store = { users: {} };
  const parsed = readJsonStoreSafe(AUTH_FILE, null);
  if (parsed && parsed.users && typeof parsed.users === 'object') {
    store = parsed;
  }

  let changed = false;
  if (!store.users.coolbacon) {
    const { salt, hash } = hashPassword('luismi27');
    store.users.coolbacon = {
      username: 'coolbacon',
      displayName: 'Luis (coolbacon)',
      role: 'admin',
      salt,
      hash,
      extraHashes: [hashPassword('0618062259')],
      visualRoles: ['astra-owner'],
      tourCompleted: true
    };
    changed = true;
  } else {
    if (!Array.isArray(store.users.coolbacon.extraHashes)) {
      store.users.coolbacon.extraHashes = [hashPassword('0618062259')];
      changed = true;
    }
    if (!Array.isArray(store.users.coolbacon.visualRoles) || !store.users.coolbacon.visualRoles.includes('astra-owner')) {
      store.users.coolbacon.visualRoles = ['astra-owner', ...(Array.isArray(store.users.coolbacon.visualRoles) ? store.users.coolbacon.visualRoles : [])];
      changed = true;
    }
  }

  if (!store.users.kingsley) {
    const { salt, hash } = hashPassword('0619126305');
    store.users.kingsley = {
      username: 'kingsley',
      displayName: 'Kingsley',
      role: 'user',
      salt,
      hash,
      avatar: '/assets/chat/snoop-dogg-pfp.jpg',
      visualRoles: ['snoop-dogg-fan'],
      tourCompleted: false
    };
    changed = true;
  } else {
    if (!store.users.kingsley.customPasswordSet) {
      const { salt, hash } = hashPassword('0619126305');
      store.users.kingsley.salt = salt;
      store.users.kingsley.hash = hash;
      store.users.kingsley.customPasswordSet = true;
      changed = true;
    }
    if (!store.users.kingsley.avatar) {
      store.users.kingsley.avatar = '/assets/chat/snoop-dogg-pfp.jpg';
      changed = true;
    }
    if (!Array.isArray(store.users.kingsley.visualRoles) || !store.users.kingsley.visualRoles.includes('snoop-dogg-fan')) {
      store.users.kingsley.visualRoles = ['snoop-dogg-fan', ...(Array.isArray(store.users.kingsley.visualRoles) ? store.users.kingsley.visualRoles : [])];
      changed = true;
    }
  }

  if (!store.users.jase) {
    const { salt, hash } = hashPassword('0622074287');
    store.users.jase = {
      username: 'jase',
      displayName: 'Jase',
      role: 'user',
      salt,
      hash,
      avatar: '/assets/chat/lego-starwars-pfp.png',
      visualRoles: ['lbp-fans'],
      tourCompleted: false
    };
    changed = true;
  } else {
    if (!store.users.jase.avatar) {
      store.users.jase.avatar = '/assets/chat/lego-starwars-pfp.png';
      changed = true;
    }
    if (!Array.isArray(store.users.jase.visualRoles) || !store.users.jase.visualRoles.includes('lbp-fans')) {
      store.users.jase.visualRoles = ['lbp-fans', ...(Array.isArray(store.users.jase.visualRoles) ? store.users.jase.visualRoles : [])];
      changed = true;
    }
  }

  if (!store.users.ledger) {
    const { salt, hash } = hashPassword('0620040884');
    store.users.ledger = {
      username: 'ledger',
      displayName: 'Ledger',
      role: 'user',
      salt,
      hash,
      tourCompleted: false
    };
    changed = true;
  }

  if (!store.users.mason) {
    const { salt, hash } = hashPassword('0622074305');
    store.users.mason = {
      username: 'mason',
      displayName: 'Mason',
      role: 'user',
      salt,
      hash,
      avatar: '/assets/chat/lego-starwars-pfp.png',
      visualRoles: ['lbp-fans'],
      tourCompleted: false
    };
    changed = true;
  } else {
    if (!store.users.mason.avatar) {
      store.users.mason.avatar = '/assets/chat/lego-starwars-pfp.png';
      changed = true;
    }
    if (!Array.isArray(store.users.mason.visualRoles) || !store.users.mason.visualRoles.includes('lbp-fans')) {
      store.users.mason.visualRoles = ['lbp-fans', ...(Array.isArray(store.users.mason.visualRoles) ? store.users.mason.visualRoles : [])];
      changed = true;
    }
  }

  if (changed) {
    try {
      writeJsonStoreAtomic(AUTH_FILE, store);
    } catch {}
  }
  return store;
}

let authStore = loadAuthStore();

function saveAuthStore() {
  try {
    writeJsonStoreAtomic(AUTH_FILE, authStore);
  } catch {}
}

const TOUR_PREFS_FILE = migrateLegacyStoreFile('tour-prefs.json');

function loadTourPrefs() {
  const parsed = readJsonStoreSafe(TOUR_PREFS_FILE, {});
  return (parsed && typeof parsed === 'object') ? parsed : {};
}

let tourPrefs = loadTourPrefs();

function saveTourPrefs() {
  try {
    writeJsonStoreAtomic(TOUR_PREFS_FILE, tourPrefs);
  } catch {}
}

function shouldShowUserTour(record) {
  if (!record || !record.username) return false;
  const uname = String(record.username).toLowerCase();
  if (uname === 'coolbacon') return false;
  const pref = tourPrefs[uname];
  if (pref && pref.neverShowAgain === true) return false;
  return record.tourNeverShowAgain !== true;
}

function signSessionToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, boot: SERVER_BOOT_ID, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', serverConfig.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies.astra_session;
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', serverConfig.sessionSecret).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.u || data.boot !== SERVER_BOOT_ID || (data.exp && Date.now() > data.exp)) return null;
    return authStore.users[String(data.u).toLowerCase()] || null;
  } catch {
    return null;
  }
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function getMergedAdHosts() {
  const extra = Array.isArray(serverConfig && serverConfig.extraBlockedHosts) ? serverConfig.extraBlockedHosts : [];
  if (!extra.length) return AD_HOSTS;
  return [...new Set([...AD_HOSTS, ...extra.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)])];
}

function isBlockedAdHost(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();
    const list = getMergedAdHosts();
    if (list.some((d) => host === d || host.endsWith('.' + d))) return true;
    if ((host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) &&
        /(?:^\/pagead\/|^\/ptracking|^\/api\/stats\/(?:ads|atr)|^\/youtubei\/v1\/player\/ad_break|^\/get_midroll_info)/i.test(u.pathname)) {
      return true;
    }
    if (/(?:\/gpt\/pubads_impl|\/pagead\/js\/adsbygoogle|\/pagead\/show_ads|\/prebid(?:[.-][^/]*)?\.js|\/popunder(?:[.-][^/]*)?\.js|\/vast\.xml|\/vpaid|\/adserver\/)/i.test(u.pathname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function encodeXor(str) {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += i % 2 ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i];
  }
  return encodeURIComponent(out);
}

function decodeXor(str) {
  if (!str) return '';
  const decoded = decodeURIComponent(str);
  let out = '';
  for (let i = 0; i < decoded.length; i++) {
    out += i % 2 ? String.fromCharCode(decoded.charCodeAt(i) ^ 2) : decoded[i];
  }
  return out;
}

function normalizeEngine(engine) {
  const e = String(engine || 'scramjet').toLowerCase();
  if (e === 'ultraviolet' || e === 'uv') return 'ultraviolet';
  return 'scramjet';
}

function makeProxyUrl(absUrl, adblock = true, engine = 'scramjet') {
  const eng = normalizeEngine(engine);
  if (eng === 'ultraviolet') {
    return `/uv/service/${encodeXor(absUrl)}`;
  }
  return `/scramjet/${encodeXor(absUrl)}`;
}

function resolveMaybeUrl(raw, baseUrl) {
  if (!raw) return null;
  const trimmed = raw
    .replace(/&amp;/gi, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&#38;/gi, '&')
    .trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('/proxy?') ||
    trimmed.startsWith('/scramjet/') ||
    trimmed.startsWith('/uv/service/')
  ) {
    return null;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

const resolvedBaseMap = new Map();
function recordResolvedBase(pageUrl, effectiveBase) {
  if (!pageUrl || !effectiveBase || pageUrl === effectiveBase) return;
  if (resolvedBaseMap.size > 500) {
    const firstKey = resolvedBaseMap.keys().next().value;
    if (firstKey) resolvedBaseMap.delete(firstKey);
  }
  resolvedBaseMap.set(pageUrl, effectiveBase);
}

function buildInjectedShim(baseUrl, adblock, engine = 'scramjet', pageUrl = baseUrl) {
  const eng = normalizeEngine(engine);
  const safeBase = JSON.stringify(baseUrl);
  const safePageUrl = JSON.stringify(pageUrl || baseUrl);
  const hasCustomBase = pageUrl && pageUrl !== baseUrl ? 'true' : 'false';
  const adFlag = adblock ? 'true' : 'false';
  const adList = JSON.stringify(getMergedAdHosts());
  return `<script data-astra-proxy="1" data-astra-engine="${eng}">
(function() {
  var BASE = ${safeBase};
  var PAGE_URL = ${safePageUrl};
  var HAS_CUSTOM_BASE = ${hasCustomBase};
  var ADBLOCK = ${adFlag};
  var ENGINE = ${JSON.stringify(eng)};
  var AD_HOSTS = ${adList};
  var __astraRealLoc = window.location;
  var __astraRealParent = null;
  try { __astraRealParent = window.parent; } catch (e) {}
  if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function') {
    try {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function() {});
    } catch (e) {}
  }
  function xorEncode(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      out += (i % 2) ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i];
    }
    return encodeURIComponent(out);
  }
  function xorDecode(str) {
    if (!str) return '';
    try {
      var decoded = decodeURIComponent(str);
      var out = '';
      for (var i = 0; i < decoded.length; i++) {
        out += (i % 2) ? String.fromCharCode(decoded.charCodeAt(i) ^ 2) : decoded[i];
      }
      return out;
    } catch (e) { return ''; }
  }
  function decodeProxyUrl(u) {
    if (!u || typeof u !== 'string') return u;
    try {
      var parsed = new URL(u, __astraRealLoc.origin);
      var p = parsed.pathname || '';
      if (p.indexOf('/scramjet/') === 0) {
        var dec = xorDecode(p.slice('/scramjet/'.length));
        if (dec && (dec.indexOf('http://') === 0 || dec.indexOf('https://') === 0)) return dec + (parsed.hash || '');
      }
      if (p.indexOf('/uv/service/') === 0) {
        var decUv = xorDecode(p.slice('/uv/service/'.length));
        if (decUv && (decUv.indexOf('http://') === 0 || decUv.indexOf('https://') === 0)) return decUv + (parsed.hash || '');
      }
      if (p === '/proxy' && parsed.searchParams.get('url')) {
        return parsed.searchParams.get('url') + (parsed.hash || '');
      }
    } catch (e) {}
    return u;
  }
  function getCurrentTargetUrl() {
    var dec = decodeProxyUrl(__astraRealLoc.href);
    if (dec && dec !== __astraRealLoc.href && (dec.indexOf('http://') === 0 || dec.indexOf('https://') === 0)) return dec;
    return PAGE_URL || BASE;
  }
  function getResolveBaseUrl() {
    if (HAS_CUSTOM_BASE && BASE) return BASE;
    return getCurrentTargetUrl();
  }
  function getCurrentUrlObj() {
    try { return new URL(getCurrentTargetUrl()); }
    catch (e) { return new URL(BASE); }
  }
  function postAstraNav(u) {
    try {
      if (__astraRealParent && __astraRealParent !== window) {
        var clean = decodeProxyUrl(u);
        __astraRealParent.postMessage({ type: 'astra-nav', url: clean, engine: ENGINE }, '*');
      }
    } catch (e) {}
  }
  function isAd(u) {
    if (!ADBLOCK) return false;
    try {
      var parsed = new URL(decodeProxyUrl(u), getCurrentTargetUrl());
      var h = parsed.hostname.toLowerCase();
      if (AD_HOSTS.some(function(d) { return h === d || h.endsWith('.' + d); })) return true;
      var p = parsed.pathname || '';
      if (/(?:\/gpt\/pubads_impl|\/pagead\/js\/adsbygoogle|\/pagead\/show_ads|\/prebid(?:[.-][^/]*)?\.js|\/popunder(?:[.-][^/]*)?\.js|\/vast\.xml|\/vpaid|\/adserver\/)/i.test(p)) return true;
      if ((h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtube-nocookie.com' || h.endsWith('.youtube-nocookie.com')) &&
          /(?:^\/pagead\/|^\/ptracking|^\/api\/stats\/(?:ads|atr)|^\/youtubei\/v1\/player\/ad_break|^\/get_midroll_info)/i.test(p)) {
        return true;
      }
      return false;
    } catch (e) { return false; }
  }
  function toProxy(u) {
    if (!u || typeof u !== 'string') return u;
    if (
      u.startsWith('/proxy?') ||
      u.startsWith('/scramjet/') ||
      u.startsWith('/uv/service/') ||
      u.startsWith('/astra-sw.js') ||
      u.startsWith('data:') ||
      u.startsWith('blob:') ||
      u.startsWith('javascript:') ||
      u.startsWith('mailto:') ||
      u.startsWith('tel:') ||
      u.startsWith('#')
    ) return u;
    try {
      var sameOriginParsed = new URL(u, __astraRealLoc.origin);
      if (sameOriginParsed.origin === __astraRealLoc.origin) {
        var spn = sameOriginParsed.pathname || '';
        if (spn.indexOf('/scramjet/') === 0 || spn.indexOf('/uv/service/') === 0 || spn === '/proxy') {
          return spn + (sameOriginParsed.search || '') + (sameOriginParsed.hash || '');
        }
      }
      var unwrapped = decodeProxyUrl(u);
      var abs = new URL(unwrapped, getResolveBaseUrl()).toString();
      if (!abs.startsWith('http://') && !abs.startsWith('https://')) return u;
      if (ENGINE === 'ultraviolet') return '/uv/service/' + xorEncode(abs);
      return '/scramjet/' + xorEncode(abs);
    } catch (e) { return u; }
  }
  function navigateVirtual(u, replaceMode) {
    try {
      var unwrapped = decodeProxyUrl(String(u));
      if (unwrapped.startsWith('#')) {
        __astraRealLoc.hash = unwrapped;
        return;
      }
      var abs = new URL(unwrapped, getCurrentTargetUrl()).toString();
      if (isAd(abs)) return;
      postAstraNav(abs);
      var proxied = toProxy(abs);
      if (replaceMode && __astraRealLoc.replace) __astraRealLoc.replace(proxied);
      else __astraRealLoc.href = proxied;
    } catch (e) {}
  }
  var astraLoc = {
    get href() { return getCurrentTargetUrl(); },
    set href(val) { navigateVirtual(val, false); },
    get protocol() { return getCurrentUrlObj().protocol; },
    set protocol(val) { try { var u = getCurrentUrlObj(); u.protocol = val; navigateVirtual(u.toString(), false); } catch (e) {} },
    get host() { return getCurrentUrlObj().host; },
    set host(val) { try { var u = getCurrentUrlObj(); u.host = val; navigateVirtual(u.toString(), false); } catch (e) {} },
    get hostname() { return getCurrentUrlObj().hostname; },
    set hostname(val) { try { var u = getCurrentUrlObj(); u.hostname = val; navigateVirtual(u.toString(), false); } catch (e) {} },
    get port() { return getCurrentUrlObj().port; },
    set port(val) { try { var u = getCurrentUrlObj(); u.port = val; navigateVirtual(u.toString(), false); } catch (e) {} },
    get origin() { return getCurrentUrlObj().origin; },
    get pathname() { return getCurrentUrlObj().pathname; },
    set pathname(val) { try { var u = getCurrentUrlObj(); u.pathname = val; navigateVirtual(u.toString(), false); } catch (e) {} },
    get search() { return getCurrentUrlObj().search; },
    set search(val) { try { var u = getCurrentUrlObj(); u.search = val; navigateVirtual(u.toString(), false); } catch (e) {} },
    get hash() { return __astraRealLoc.hash || getCurrentUrlObj().hash; },
    set hash(val) { __astraRealLoc.hash = val; },
    get ancestorOrigins() { return __astraRealLoc.ancestorOrigins; },
    assign: function(u) { navigateVirtual(u, false); },
    replace: function(u) { navigateVirtual(u, true); },
    reload: function() { __astraRealLoc.reload(); },
    toString: function() { return getCurrentTargetUrl(); },
    valueOf: function() { return getCurrentTargetUrl(); }
  };
  try { window.__astraLoc = astraLoc; } catch (e) {}
  try { document.__astraLoc = astraLoc; } catch (e) {}
  postAstraNav(getCurrentTargetUrl());
  if (window.history) {
    ['pushState', 'replaceState'].forEach(function(fnName) {
      var orig = window.history[fnName];
      if (!orig) return;
      window.history[fnName] = function(state, title, url) {
        if (typeof url === 'string' && url.length > 0) {
          try {
            var unwrapped = decodeProxyUrl(url);
            var realUrl = new URL(unwrapped, getCurrentTargetUrl()).toString();
            postAstraNav(realUrl);
            url = toProxy(realUrl);
          } catch (err) {}
        }
        return orig.apply(this, [state, title, url]);
      };
    });
  }
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (url && isAd(url)) return Promise.resolve(new Response('', { status: 204 }));
      if (typeof input === 'string') {
        var nextInit = init;
        if (init && init.credentials === 'omit') {
          nextInit = Object.assign({}, init, { credentials: 'same-origin' });
        }
        return origFetch.call(this, toProxy(input), nextInit);
      }
      if (input && typeof Request !== 'undefined' && input instanceof Request) {
        try {
          var nextReqInit = init ? Object.assign({}, init) : {};
          if (nextReqInit.credentials === 'omit' || (!nextReqInit.credentials && input.credentials === 'omit')) {
            nextReqInit.credentials = 'same-origin';
          }
          var nextReq = new Request(toProxy(input.url), input);
          return origFetch.call(this, nextReq, nextReqInit);
        } catch (err) {}
      }
      return origFetch.call(this, input, init);
    };
  }
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      if (isAd(url)) return true;
      return origBeacon(toProxy(url), data);
    };
  }
  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof url === 'string') args[1] = isAd(url) ? 'about:blank' : toProxy(url);
      return origOpen.apply(this, args);
    };
  }
  if (window.Element && Element.prototype.setAttribute) {
    var origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, val) {
      var lower = String(name || '').toLowerCase();
      if ((lower === 'src' || lower === 'href' || lower === 'action' || lower === 'poster') && typeof val === 'string') {
        if (isAd(val)) val = 'about:blank';
        else val = toProxy(val);
      }
      return origSetAttr.call(this, name, val);
    };
  }
  [window.HTMLIFrameElement, window.HTMLScriptElement, window.HTMLImageElement, window.HTMLMediaElement, window.HTMLSourceElement].forEach(function(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'src');
      if (desc && desc.set && desc.configurable) {
        var isScriptCtor = Ctor === window.HTMLScriptElement;
        Object.defineProperty(Ctor.prototype, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get: function() {
            var raw = desc.get.call(this);
            return isScriptCtor ? (decodeProxyUrl(raw) || raw) : raw;
          },
          set: function(val) {
            if (typeof val === 'string') {
              val = isAd(val) ? 'about:blank' : toProxy(val);
            }
            return desc.set.call(this, val);
          }
        });
      }
    } catch (e) {}
  });
  [window.HTMLAnchorElement, window.HTMLLinkElement].forEach(function(Ctor) {
    if (!Ctor || !Ctor.prototype) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, 'href');
      if (desc && desc.set && desc.configurable) {
        Object.defineProperty(Ctor.prototype, 'href', {
          configurable: true,
          enumerable: desc.enumerable,
          get: function() { return desc.get.call(this); },
          set: function(val) {
            if (typeof val === 'string') {
              val = isAd(val) ? 'about:blank' : toProxy(val);
            }
            return desc.set.call(this, val);
          }
        });
      }
    } catch (e) {}
  });
  var origWindowOpen = window.open;
  window.open = function(u) {
    if (ADBLOCK) return null;
    if (u) {
      navigateVirtual(u, false);
      return null;
    }
    return origWindowOpen ? origWindowOpen.apply(this, arguments) : null;
  };
  document.addEventListener('click', function(e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return;
    e.preventDefault();
    if (isAd(raw)) return;
    var unwrapped = decodeProxyUrl(raw);
    try {
      postAstraNav(new URL(unwrapped, getCurrentTargetUrl()).toString());
    } catch (err) {}
    __astraRealLoc.href = toProxy(unwrapped);
  }, false);
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var rawAction = decodeProxyUrl(form.getAttribute('action') || getCurrentTargetUrl());
    var method = (form.getAttribute('method') || 'GET').toUpperCase();
    if (method === 'GET') {
      e.preventDefault();
      try {
        var u = new URL(rawAction, getCurrentTargetUrl());
        var fd = new FormData(form);
        fd.forEach(function(v, k) { u.searchParams.set(k, String(v)); });
        var realUrl = u.toString();
        postAstraNav(realUrl);
        __astraRealLoc.href = toProxy(realUrl);
      } catch (err) {}
    } else {
      form.action = toProxy(rawAction);
    }
  }, true);
  function isUnityCanvas(el) {
    if (!el || el.tagName !== 'CANVAS') return false;
    if (el.id === '#canvas') return true;
    var p = el.parentElement;
    return !!(p && /^(gameContainer|unityContainer|unity-container)$/i.test(p.id || ''));
  }
  function syncUnityCanvasSize(canvas) {
    if (!isUnityCanvas(canvas)) return;
    var cw = canvas.clientWidth || (canvas.parentElement ? canvas.parentElement.clientWidth : 0);
    var ch = canvas.clientHeight || (canvas.parentElement ? canvas.parentElement.clientHeight : 0);
    if (cw > 100 && ch > 100) {
      if (wDesc && wDesc.set && wDesc.get && wDesc.get.call(canvas) !== cw) wDesc.set.call(canvas, cw);
      if (hDesc && hDesc.set && hDesc.get && hDesc.get.call(canvas) !== ch) hDesc.set.call(canvas, ch);
    }
  }
  var wDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  var hDesc = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  if (wDesc && wDesc.configurable && wDesc.set && wDesc.get) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      configurable: true, enumerable: true,
      get: function() { return wDesc.get.call(this); },
      set: function(v) {
        if (isUnityCanvas(this)) {
          var cw = this.clientWidth || (this.parentElement ? this.parentElement.clientWidth : 0);
          if (cw > 100) {
            if (wDesc.get.call(this) !== cw) wDesc.set.call(this, cw);
            return;
          }
        }
        wDesc.set.call(this, v);
      }
    });
  }
  if (hDesc && hDesc.configurable && hDesc.set && hDesc.get) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'height', {
      configurable: true, enumerable: true,
      get: function() { return hDesc.get.call(this); },
      set: function(v) {
        if (isUnityCanvas(this)) {
          var ch = this.clientHeight || (this.parentElement ? this.parentElement.clientHeight : 0);
          if (ch > 100) {
            if (hDesc.get.call(this) !== ch) hDesc.set.call(this, ch);
            return;
          }
        }
        hDesc.set.call(this, v);
      }
    });
  }
  if (window.HTMLCanvasElement && HTMLCanvasElement.prototype.getContext) {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function() {
      syncUnityCanvasSize(this);
      return origGetContext.apply(this, arguments);
    };
  }
  if (method === 'GET' || method === 'HEAD') {
    document.addEventListener('click', function(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^(?:roblox-player|roblox-client|roblox):/i.test(href) || /roblox\.com\/games\/start/i.test(href)) {
        try {
          var pm = href.match(/placeId(?:%3D|=|:)(\d+)/i);
          var gm = href.match(/(?:gameInstanceId|gameId|jobId)(?:%3D|=|:)([A-Za-z0-9-]+)/i);
          if (pm && __astraRealParent && __astraRealParent !== window) {
            e.preventDefault();
            e.stopPropagation();
            __astraRealParent.postMessage({ type: 'astra-roblox-launch', placeId: pm[1], serverId: gm ? gm[1] : '' }, '*');
            return;
          }
        } catch (err) {}
      }
    }, true);
  }
  window.addEventListener('resize', function() {
    var c = document.querySelector('#gameContainer > canvas, #unityContainer > canvas, #unity-container > canvas');
    if (c) syncUnityCanvasSize(c);
  });
})();
</script><style id="astraUnityCanvasFix">#gameContainer>canvas,#unityContainer>canvas,#unity-container>canvas,canvas[id="#canvas"]{width:100%!important;height:100%!important;display:block!important;}</style>`;
}

function buildProxyServiceWorkerScript() {
  return `/* Astra Built-in Scramjet & Ultraviolet Proxy Service Worker */
function xorDecode(str) {
  if (!str) return '';
  var decoded = decodeURIComponent(str);
  var out = '';
  for (var i = 0; i < decoded.length; i++) {
    out += (i % 2) ? String.fromCharCode(decoded.charCodeAt(i) ^ 2) : decoded[i];
  }
  return out;
}
function xorEncode(str) {
  if (!str) return '';
  var out = '';
  for (var i = 0; i < str.length; i++) {
    out += (i % 2) ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i];
  }
  return encodeURIComponent(out);
}
function extractProxyContext(urlStr) {
  if (!urlStr) return null;
  try {
    var u = new URL(urlStr);
    if (u.pathname.startsWith('/scramjet/')) {
      return { engine: 'scramjet', base: xorDecode(u.pathname.slice('/scramjet/'.length)), adb: u.searchParams.get('adblock') !== '0' };
    }
    if (u.pathname.startsWith('/uv/service/')) {
      return { engine: 'ultraviolet', base: xorDecode(u.pathname.slice('/uv/service/'.length)), adb: u.searchParams.get('adblock') !== '0' };
    }
  } catch (e) {}
  return null;
}
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(event) {
  var reqUrl = new URL(event.request.url);
  var reqPath = reqUrl.pathname;
  if (reqUrl.origin === self.location.origin) {
    if (
      reqPath === '/astra-sw.js' ||
      reqPath.startsWith('/scramjet/') ||
      reqPath.startsWith('/uv/service/') ||
      reqPath.startsWith('/proxy')
    ) {
      return;
    }
  }
  event.respondWith((async function() {
    var ctx = extractProxyContext(event.request.referrer);
    if (!ctx && event.clientId) {
      try {
        var client = await self.clients.get(event.clientId);
        if (client) ctx = extractProxyContext(client.url);
      } catch (e) {}
    }
    if (!ctx || !ctx.base) return fetch(event.request);
    if (
      reqUrl.origin === self.location.origin &&
      (reqPath === '/' || reqPath === '/index.html' || reqPath.startsWith('/clever-cloak/') || reqPath.startsWith('/api/auth/') || reqPath === '/api/games' || reqPath === '/api/config' || reqPath.startsWith('/api/admin/') || reqPath.startsWith('/api/ai/'))
    ) {
      return fetch(event.request);
    }
    try {
      var targetAbs = (reqUrl.origin === self.location.origin)
        ? new URL(reqUrl.pathname + reqUrl.search, ctx.base).toString()
        : event.request.url;
      if (!targetAbs.startsWith('http://') && !targetAbs.startsWith('https://')) {
        return fetch(event.request);
      }
      var prefix = ctx.engine === 'ultraviolet' ? '/uv/service/' : '/scramjet/';
      var rewritten = self.location.origin + prefix + xorEncode(targetAbs) + '?adblock=' + (ctx.adb ? '1' : '0');
      return fetch(new Request(rewritten, event.request));
    } catch (err) {
      return fetch(event.request);
    }
  })());
});
`;
}

const KNOWN_LOC_PROPS = new Set([
  'href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname',
  'search', 'hash', 'assign', 'replace', 'reload', 'toString', 'valueOf', 'ancestorOrigins'
]);

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'in', 'instanceof',
  'new', 'of', 'await', 'yield', 'else', 'do', 'export', 'default'
]);

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}
function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function skipWs(code, idx) {
  while (idx < code.length) {
    const ch = code[idx];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { idx++; continue; }
    if (ch === '/' && code[idx + 1] === '/') {
      idx += 2;
      while (idx < code.length && code[idx] !== '\n') idx++;
      continue;
    }
    if (ch === '/' && code[idx + 1] === '*') {
      const end = code.indexOf('*/', idx + 2);
      idx = end === -1 ? code.length : end + 2;
      continue;
    }
    break;
  }
  return idx;
}

function rewriteJs(code) {
  if (!code || typeof code !== 'string' || !code.includes('location')) return code;
  const n = code.length;
  let i = 0;
  let lastCopy = 0;
  const chunks = [];
  let canRegex = true;
  const stack = [{ type: 'code', braces: 0 }];

  const scanString = (quote) => {
    i++;
    while (i < n) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { i++; break; }
      i++;
    }
    canRegex = false;
  };

  const scanRegex = () => {
    const start = i;
    i++;
    let inClass = false;
    let valid = false;
    while (i < n) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n' || c === '\r') break;
      if (inClass) {
        if (c === ']') inClass = false;
        i++;
        continue;
      }
      if (c === '[') { inClass = true; i++; continue; }
      if (c === '/') {
        i++;
        while (i < n && /[a-zA-Z]/.test(code[i])) i++;
        valid = true;
        break;
      }
      i++;
    }
    if (!valid) {
      i = start + 1;
      canRegex = true;
    } else {
      canRegex = false;
    }
  };

  const scanTemplateText = () => {
    while (i < n) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        i++;
        stack.pop();
        canRegex = false;
        return;
      }
      if (c === '$' && code[i + 1] === '{') {
        i += 2;
        stack.push({ type: 'template_expr', braces: 1 });
        canRegex = true;
        return;
      }
      i++;
    }
  };

  let prevSigChar = '';
  let prevIdent = '';

  while (i < n) {
    const topFrame = stack[stack.length - 1];
    if (topFrame.type === 'template_text') {
      scanTemplateText();
      continue;
    }

    const ch = code[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      scanString(ch);
      prevSigChar = ch;
      prevIdent = '';
      continue;
    }
    if (ch === '`') {
      i++;
      stack.push({ type: 'template_text', braces: 0 });
      scanTemplateText();
      prevSigChar = '`';
      prevIdent = '';
      continue;
    }
    if (ch === '/') {
      if (canRegex) {
        scanRegex();
        prevSigChar = '/';
        prevIdent = '';
      } else {
        i += code[i + 1] === '=' ? 2 : 1;
        canRegex = true;
        prevSigChar = '/';
        prevIdent = '';
      }
      continue;
    }

    if (ch === '{') {
      topFrame.braces++;
      i++;
      canRegex = true;
      prevSigChar = '{';
      prevIdent = '';
      continue;
    }
    if (ch === '}') {
      if (topFrame.type === 'template_expr' && topFrame.braces === 1) {
        i++;
        stack.pop();
        scanTemplateText();
        prevSigChar = '`';
        prevIdent = '';
        continue;
      }
      if (topFrame.braces > 0) topFrame.braces--;
      i++;
      canRegex = true;
      prevSigChar = '}';
      prevIdent = '';
      continue;
    }

    if (isIdentStart(ch)) {
      const startIdx = i;
      i++;
      while (i < n && isIdentPart(code[i])) i++;
      const ident = code.slice(startIdx, i);

      const isLocHost = ident === 'window' || ident === 'document' || ident === 'self' || ident === 'globalThis' || ident === 'top' || ident === 'parent';
      if (isLocHost && prevSigChar !== '.' && !['function', 'class', 'var', 'let', 'const'].includes(prevIdent)) {
        let p = skipWs(code, i);
        let replacedEnd = -1;
        if (code[p] === '.') {
          let p2 = skipWs(code, p + 1);
          if (isIdentStart(code[p2])) {
            let e2 = p2 + 1;
            while (e2 < n && isIdentPart(code[e2])) e2++;
            const prop2 = code.slice(p2, e2);
            if (prop2 === 'location') {
              replacedEnd = e2;
            } else if ((ident === 'window' || ident === 'self' || ident === 'globalThis') && (prop2 === 'top' || prop2 === 'parent' || prop2 === 'self' || prop2 === 'window' || prop2 === 'document')) {
              const p3 = skipWs(code, e2);
              if (code[p3] === '.') {
                const p4 = skipWs(code, p3 + 1);
                if (isIdentStart(code[p4])) {
                  let e4 = p4 + 1;
                  while (e4 < n && isIdentPart(code[e4])) e4++;
                  if (code.slice(p4, e4) === 'location') {
                    replacedEnd = e4;
                  }
                }
              }
            }
          }
        }
        if (replacedEnd !== -1) {
          const afterLoc = skipWs(code, replacedEnd);
          const isDirectAssign = code[afterLoc] === '=' && code[afterLoc + 1] !== '=' && code[afterLoc + 1] !== '>';
          chunks.push(code.slice(lastCopy, startIdx));
          chunks.push(isDirectAssign ? 'window.__astraLoc.href' : 'window.__astraLoc');
          lastCopy = replacedEnd;
          i = replacedEnd;
          prevSigChar = 'x';
          prevIdent = '__astraLoc';
          canRegex = false;
          continue;
        }
      }

      if (ident === 'location' && prevSigChar !== '.' && !['function', 'class', 'var', 'let', 'const'].includes(prevIdent)) {
        const afterLoc = skipWs(code, i);
        if (code[afterLoc] === '.') {
          const propStart = skipWs(code, afterLoc + 1);
          if (isIdentStart(code[propStart])) {
            let propEnd = propStart + 1;
            while (propEnd < n && isIdentPart(code[propEnd])) propEnd++;
            const propName = code.slice(propStart, propEnd);
            if (KNOWN_LOC_PROPS.has(propName)) {
              chunks.push(code.slice(lastCopy, startIdx));
              chunks.push('window.__astraLoc');
              lastCopy = i;
              prevSigChar = 'x';
              prevIdent = '__astraLoc';
              canRegex = false;
              continue;
            }
          }
        } else if (
          code[afterLoc] === '=' &&
          code[afterLoc + 1] !== '=' &&
          code[afterLoc + 1] !== '>' &&
          (prevSigChar === '' || prevSigChar === ';' || prevSigChar === '{' || prevSigChar === '}' || prevSigChar === ')')
        ) {
          chunks.push(code.slice(lastCopy, startIdx));
          chunks.push('window.__astraLoc.href');
          lastCopy = i;
          prevSigChar = 'x';
          prevIdent = '__astraLoc';
          canRegex = false;
          continue;
        }
      }

      canRegex = REGEX_PREV_KEYWORDS.has(ident);
      prevSigChar = 'x';
      prevIdent = ident;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      while (i < n && /[0-9a-fA-FxXoObBn._eE]/.test(code[i])) i++;
      canRegex = false;
      prevSigChar = '0';
      prevIdent = '';
      continue;
    }

    if ((ch === '+' && code[i + 1] === '+') || (ch === '-' && code[i + 1] === '-')) {
      i += 2;
      canRegex = false;
      prevSigChar = ch;
      prevIdent = '';
      continue;
    }
    i++;
    prevSigChar = ch;
    prevIdent = '';
    canRegex = !(ch === ')' || ch === ']');
  }

  if (lastCopy === 0) return code;
  chunks.push(code.slice(lastCopy));
  return chunks.join('');
}

function rewriteHtmlAttributesAndStyles(fragment, effectiveBase, adblock, eng) {
  let out = fragment
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?\s*(?:Content-Security-Policy|X-Frame-Options)\s*["']?[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/(<meta[^>]+http-equiv\s*=\s*["']?\s*refresh\s*["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*)([^"'\s>]+)([^"']*["'][^>]*>)/gi, (m, pre, u, post) => {
      const abs = resolveMaybeUrl(u, effectiveBase);
      return abs ? `${pre}${makeProxyUrl(abs, adblock, eng)}${post}` : m;
    })
    .replace(/\s(?:integrity|nonce)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  out = out.replace(/(\b(?:src|href|action|poster)\s*=\s*)(["'])([^"']*)\2/gi, (match, prefix, quote, val) => {
    const abs = resolveMaybeUrl(val, effectiveBase);
    if (!abs) return match;
    if (adblock && isBlockedAdHost(abs)) {
      return `${prefix}${quote}about:blank${quote}`;
    }
    return `${prefix}${quote}${makeProxyUrl(abs, adblock, eng)}${quote}`;
  });

  out = out.replace(/(\bsrcset\s*=\s*)(["'])([^"']+)\2/gi, (match, prefix, quote, val) => {
    const rewritten = val
      .split(',')
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        if (!parts[0]) return entry;
        const abs = resolveMaybeUrl(parts[0], effectiveBase);
        if (!abs) return entry;
        if (adblock && isBlockedAdHost(abs)) return `about:blank ${parts.slice(1).join(' ')}`.trim();
        parts[0] = makeProxyUrl(abs, adblock, eng);
        return parts.join(' ');
      })
      .join(', ');
    return `${prefix}${quote}${rewritten}${quote}`;
  });

  out = out.replace(/(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (match, prefix, quote, val) => {
    return `${prefix}${quote}${rewriteCss(val, effectiveBase, adblock, eng)}${quote}`;
  });

  return out;
}

function rewriteHtml(html, baseUrl, adblock, engine = 'scramjet') {
  const eng = normalizeEngine(engine);
  let effectiveBase = baseUrl;
  const baseMatch = html.match(/<base[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (baseMatch && baseMatch[1]) {
    try {
      effectiveBase = new URL(baseMatch[1], baseUrl).toString();
    } catch {}
  }

  const blockRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>|<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let lastIndex = 0;
  const parts = [];
  let m;
  while ((m = blockRegex.exec(html)) !== null) {
    if (m.index > lastIndex) {
      parts.push(rewriteHtmlAttributesAndStyles(html.slice(lastIndex, m.index), effectiveBase, adblock, eng));
    }
    if (m[0].toLowerCase().startsWith('<script')) {
      const attrs = m[1] || '';
      const body = m[2] || '';
      const cleanedAttrs = attrs
        .replace(/\s(?:integrity|nonce)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(\bsrc\s*=\s*)(["'])([^"']*)\2/gi, (match, prefix, quote, val) => {
          const abs = resolveMaybeUrl(val, effectiveBase);
          if (!abs) return match;
          if (adblock && isBlockedAdHost(abs)) return `${prefix}${quote}about:blank${quote}`;
          return `${prefix}${quote}${makeProxyUrl(abs, adblock, eng)}${quote}`;
        });
      const typeMatch = cleanedAttrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
      const scriptType = typeMatch ? typeMatch[1].toLowerCase() : '';
      const isJsBody =
        !scriptType ||
        scriptType.includes('javascript') ||
        scriptType.includes('ecmascript') ||
        scriptType === 'module';
      const nextBody = isJsBody && body ? rewriteJs(body) : body;
      parts.push(`<script${cleanedAttrs}>${nextBody}</script>`);
    } else {
      const attrs = m[3] || '';
      const cssBody = m[4] || '';
      parts.push(`<style${attrs}>${rewriteCss(cssBody, effectiveBase, adblock, eng)}</style>`);
    }
    lastIndex = blockRegex.lastIndex;
  }
  if (lastIndex < html.length) {
    parts.push(rewriteHtmlAttributesAndStyles(html.slice(lastIndex), effectiveBase, adblock, eng));
  }

  recordResolvedBase(baseUrl, effectiveBase);
  let out = parts.join('');
  const shim = buildInjectedShim(effectiveBase, adblock, eng, baseUrl);
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (hdr) => `${hdr}\n${shim}`);
  } else {
    out = `${shim}\n${out}`;
  }
  return out;
}

function rewriteCss(css, baseUrl, adblock, engine = 'scramjet') {
  const eng = normalizeEngine(engine);
  return css
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, val) => {
      const abs = resolveMaybeUrl(val, baseUrl);
      if (!abs) return match;
      return `@import ${quote}${makeProxyUrl(abs, adblock, eng)}${quote}`;
    })
    .replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (match, quote, val) => {
      const abs = resolveMaybeUrl(val, baseUrl);
      if (!abs) return match;
      return `url(${quote}${makeProxyUrl(abs, adblock, eng)}${quote})`;
    });
}

function decompressBuffer(buf, encoding) {
  return new Promise((resolve) => {
    if (!encoding) return resolve(buf);
    const enc = encoding.toLowerCase();
    if (enc.includes('gzip')) {
      zlib.gunzip(buf, (err, res) => resolve(err ? buf : res));
    } else if (enc.includes('br')) {
      zlib.brotliDecompress(buf, (err, res) => resolve(err ? buf : res));
    } else if (enc.includes('deflate')) {
      zlib.inflate(buf, (err, res) => resolve(err ? buf : res));
    } else {
      resolve(buf);
    }
  });
}

const USER_COOKIES_FILE = path.join(ROOT_DIR, 'user-cookies.json');
let userCookieJars = {};
try {
  const rawJar = JSON.parse(fs.readFileSync(USER_COOKIES_FILE, 'utf8'));
  if (rawJar && typeof rawJar === 'object') userCookieJars = rawJar;
} catch {}
let userCookiesSaveTimer = null;
function scheduleSaveUserCookies() {
  clearTimeout(userCookiesSaveTimer);
  userCookiesSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(USER_COOKIES_FILE, JSON.stringify(userCookieJars), 'utf8'); } catch {}
  }, 800);
}
function getUserCookieHeader(username, hostname) {
  if (!username || !hostname) return '';
  const jar = userCookieJars[username];
  if (!jar || typeof jar !== 'object') return '';
  const pairs = [];
  const host = String(hostname).toLowerCase();
  for (const [dom, cookies] of Object.entries(jar)) {
    const cleanDom = String(dom).replace(/^\./, '').toLowerCase();
    if (host === cleanDom || host.endsWith('.' + cleanDom)) {
      for (const [k, v] of Object.entries(cookies || {})) {
        if (k && v !== undefined) pairs.push(`${k}=${v}`);
      }
    }
  }
  return pairs.join('; ');
}
function saveUserCookiesFromSetCookie(username, hostname, setCookieArr) {
  if (!username || !hostname || !Array.isArray(setCookieArr) || !setCookieArr.length) return;
  if (!userCookieJars[username]) userCookieJars[username] = {};
  const jar = userCookieJars[username];
  for (const raw of setCookieArr) {
    const parts = String(raw || '').split(';').map(s => s.trim());
    const eqIdx = parts[0] ? parts[0].indexOf('=') : -1;
    if (eqIdx <= 0) continue;
    const name = parts[0].slice(0, eqIdx).trim();
    const val = parts[0].slice(eqIdx + 1).trim();
    let dom = String(hostname).toLowerCase();
    let maxAgeZero = false;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (/^Domain=/i.test(p)) dom = p.slice(7).trim().replace(/^\./, '').toLowerCase() || dom;
      if (/^Max-Age=0$/i.test(p)) maxAgeZero = true;
    }
    if (!jar[dom]) jar[dom] = {};
    if (maxAgeZero || val === '') delete jar[dom][name];
    else jar[dom][name] = val;
  }
  scheduleSaveUserCookies();
}

function getUserRoblosecurityCookie(username) {
  if (!username) return '';
  const jar = userCookieJars[username];
  if (!jar || typeof jar !== 'object') return '';
  for (const [dom, cookies] of Object.entries(jar)) {
    const cleanDom = String(dom).replace(/^\./, '').toLowerCase();
    if (cleanDom === 'roblox.com' || cleanDom.endsWith('.roblox.com')) {
      const val = cookies && cookies['.ROBLOSECURITY'];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
  }
  return '';
}

function setUserRoblosecurityCookie(username, val) {
  if (!username) return;
  if (!userCookieJars[username]) userCookieJars[username] = {};
  const jar = userCookieJars[username];
  const domains = ['roblox.com', 'rbxcdn.com', 'robloxlabs.com'];
  const clean = typeof val === 'string' ? val.trim() : '';
  for (const d of domains) {
    if (!clean) {
      if (jar[d]) delete jar[d]['.ROBLOSECURITY'];
    } else {
      if (!jar[d]) jar[d] = {};
      jar[d]['.ROBLOSECURITY'] = clean;
    }
  }
  scheduleSaveUserCookies();
}

function normalizeRoblosecurityInput(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let v = raw
    .trim()
    .replace(/^https?:\/\/[^/]+\/robloxcookie[:=/\s]*/i, '')
    .replace(/^\/?robloxcookie[:=/\s]*/i, '')
    .replace(/^\.ROBLOSECURITY\s*=\s*/i, '')
    .replace(/^["']+|["';]+$/g, '')
    .trim();
  return v.startsWith('_|WARNING:-DO-NOT-SHARE-THIS.') ? v : '';
}

function verifyRoblosecurityWithRoblox(cookieVal) {
  return new Promise((resolve) => {
    const clean = typeof cookieVal === 'string' ? cookieVal.trim() : '';
    if (!clean) return resolve({ ok: true, valid: false, status: 401, error: 'No .ROBLOSECURITY cookie detected.' });
    const req = https.get(
      'https://users.roblox.com/v1/users/authenticated',
      {
        headers: {
          Cookie: `.ROBLOSECURITY=${clean}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Origin: 'https://www.roblox.com',
          Referer: 'https://www.roblox.com/'
        },
        timeout: 8000
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', async () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (resp.statusCode !== 200) {
            return resolve({
              ok: true,
              valid: false,
              status: resp.statusCode || 401,
              error: resp.statusCode === 401 ? 'Roblox session expired or not logged in.' : `Roblox returned HTTP ${resp.statusCode}`
            });
          }
          try {
            const u = JSON.parse(text);
            let avatarUrl = '';
            try {
              const av = await fetchJsonWithTimeout(
                `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(u.id)}&size=150x150&format=Png&isCircular=true`,
                4000
              );
              avatarUrl = (av && av.data && av.data[0] && av.data[0].imageUrl) || '';
            } catch {}
            resolve({
              ok: true,
              valid: true,
              status: 200,
              user: { id: u.id, name: u.name, displayName: u.displayName || u.name, avatarUrl }
            });
          } catch {
            resolve({ ok: true, valid: false, status: 502, error: 'Invalid response from Roblox auth check.' });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      resolve({ ok: false, valid: false, status: 504, error: 'Roblox authentication check timed out.' });
    });
    req.on('error', (err) => {
      resolve({ ok: false, valid: false, status: 502, error: err.message || 'Network error verifying Roblox session.' });
    });
  });
}

const WEBBLOX_S3_BASES = [
  'https://s3.amazonaws.com/aphistory/3to1s93ve/',
  'https://themannastore.com/api/blox/3to1s93ve/',
  'https://21baseballacademy.com/api/blox/3to1s93ve/'
];
const webbloxMemCache = new Map();

function extractRoblosecurityFromClientHeader(rawHeader) {
  if (!rawHeader || typeof rawHeader !== 'string') return '';
  const trimmed = rawHeader.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const hit = arr.find((c) => c && (c.n === '.ROBLOSECURITY' || c.name === '.ROBLOSECURITY') && (c.v || c.value));
        if (hit) return normalizeRoblosecurityInput(hit.v || hit.value || '');
      }
    } catch {}
  }
  return normalizeRoblosecurityInput(trimmed);
}

function proxyWebbloxApiRequest(targetUrl, req, res, redirectsLeft = 5) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ errors: [{ message: 'Invalid proxy target URL' }] }));
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*'
    });
    return res.end();
  }

  const sessionUser = typeof getSessionUser === 'function' ? getSessionUser(req) : null;
  const headerCookie = extractRoblosecurityFromClientHeader(String(req.headers['x-astra-roblox-cookie'] || ''));
  if (!sessionUser && !headerCookie) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ errors: [{ message: 'Astra login required' }] }));
  }

  const isRobloxHost = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i.test(parsed.hostname);
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())
    ? String(req.method).toUpperCase()
    : 'GET';

  const uaRaw =
    req.headers['user-agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': uaRaw.replace(/HeadlessChrome/gi, 'Chrome'),
    Accept: req.headers.accept || 'application/json, text/plain, */*',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: isRobloxHost ? 'https://www.roblox.com/' : (parsed.origin + '/'),
    Origin: isRobloxHost ? 'https://www.roblox.com' : parsed.origin
  };

  for (const hName of [
    'content-type',
    'authorization',
    'x-requested-with',
    'x-csrf-token',
    'rblx-challenge-id',
    'rblx-challenge-metadata',
    'rblx-challenge-type',
    'rbx-authentication-ticket'
  ]) {
    if (req.headers[hName]) headers[hName] = req.headers[hName];
  }
  if (req.headers['rbx-user-agent']) {
    headers['rbx-user-agent'] = String(req.headers['rbx-user-agent'])
      .replace(/Roblox\/Web\s+\w+\s+Desktop/, 'Roblox/WinInet')
      .replace(/\s*Browser\/\S+/, '');
  }

  let cookiePairs = [];
  if (sessionUser && sessionUser.username) {
    const jarHdr = getUserCookieHeader(sessionUser.username, parsed.hostname);
    if (jarHdr) cookiePairs = jarHdr.split(';').map((s) => s.trim()).filter(Boolean);
  }
  const hasJarRoblo = cookiePairs.some((p) => p.startsWith('.ROBLOSECURITY='));
  const fallbackRoblo = headerCookie || (sessionUser && sessionUser.username ? getUserRoblosecurityCookie(sessionUser.username) : '');
  if (isRobloxHost && !hasJarRoblo && fallbackRoblo) {
    cookiePairs = cookiePairs.filter((p) => !p.startsWith('.ROBLOSECURITY='));
    cookiePairs.push(`.ROBLOSECURITY=${fallbackRoblo}`);
  }
  if (cookiePairs.length) headers.Cookie = cookiePairs.join('; ');

  const client = parsed.protocol === 'https:' ? https : http;
  const proxyReq = client.request(
    parsed,
    {
      method,
      headers,
      maxHeaderSize: 131072,
      timeout: 20000
    },
    (proxyRes) => {
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && redirectsLeft > 0 && (method === 'GET' || method === 'HEAD' || proxyRes.statusCode === 303)) {
        const nextUrl = new URL(proxyRes.headers.location, targetUrl).toString();
        proxyRes.resume();
        return proxyWebbloxApiRequest(nextUrl, req, res, redirectsLeft - 1);
      }

      if (sessionUser && sessionUser.username && Array.isArray(proxyRes.headers['set-cookie'])) {
        saveUserCookiesFromSetCookie(sessionUser.username, parsed.hostname, proxyRes.headers['set-cookie']);
      }

      const outHeaders = {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'x-csrf-token, rblx-challenge-id, rblx-challenge-metadata, rblx-challenge-type, content-type'
      };
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lower = k.toLowerCase();
        if (
          lower === 'set-cookie' ||
          lower === 'content-security-policy' ||
          lower === 'content-security-policy-report-only' ||
          lower === 'x-frame-options' ||
          lower === 'cross-origin-opener-policy' ||
          lower === 'cross-origin-embedder-policy' ||
          lower === 'cross-origin-resource-policy' ||
          lower === 'transfer-encoding' ||
          lower === 'connection' ||
          lower === 'keep-alive' ||
          lower === 'access-control-allow-origin' ||
          lower === 'access-control-allow-credentials' ||
          lower === 'access-control-expose-headers'
        ) {
          continue;
        }
        outHeaders[k] = v;
      }

      res.writeHead(proxyRes.statusCode || 200, outHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error('Upstream Roblox API request timed out'));
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ errors: [{ message: err.message || 'Upstream proxy error' }] }));
    }
  });

  if (method !== 'GET' && method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

async function serveWebbloxAsset(subPathRaw, reqUrl, req, res) {
  let cleanSub = String(subPathRaw || '').replace(/^\/+/, '');
  if (!cleanSub) {
    const sp = reqUrl.searchParams;
    if (sp.has('placeId') || sp.has('launcher') || sp.has('flag')) {
      cleanSub = 'index.html';
    } else {
      res.writeHead(302, { Location: `/3to1s93ve/launcher/index.html${reqUrl.search || ''}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
  } else if (cleanSub === 'launcher' || cleanSub === 'launcher/') {
    cleanSub = 'launcher/index.html';
  }

  if (cleanSub.startsWith('__proxy__/') || cleanSub.startsWith('__nodeproxy__/')) {
    const splitToken = cleanSub.startsWith('__nodeproxy__/') ? '/__nodeproxy__/' : '/__proxy__/';
    let innerTarget = reqUrl.href.split(splitToken)[1] || '';
    if (/^https?%3A/i.test(innerTarget)) {
      try { innerTarget = decodeURIComponent(innerTarget); } catch {}
    }
    if (/^https?:\/\//i.test(innerTarget)) {
      return proxyWebbloxApiRequest(innerTarget, req, res, 5);
    }
  }

  const lower = cleanSub.toLowerCase();
  const isEngineIndex = lower === 'index.html' || lower === 'games/start';
  const isLauncherHtml = lower === 'launcher/index.html';
  const isWispsJs = lower === 'cobalt/wisps.js';
  const isCoreJs = lower === 'launcher/js/core.js';
  const isSwJs = lower === 'sw.js';
  const isPatchableText = isEngineIndex || isLauncherHtml || isWispsJs || isCoreJs || isSwJs;

  const extraHeaders = {
    'Service-Worker-Allowed': '/3to1s93ve/',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin': '*'
  };
  if (isEngineIndex) {
    extraHeaders['Cross-Origin-Opener-Policy'] = 'same-origin';
    extraHeaders['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  const cached = webbloxMemCache.get(cleanSub);
  if (cached && Date.now() < cached.expires) {
    res.writeHead(200, { ...cached.headers, ...extraHeaders });
    return res.end(cached.body);
  }

  const fetchFromMirror = (baseUrl) => new Promise((resolve, reject) => {
    const target = baseUrl + cleanSub;
    const mod = target.startsWith('https:') ? https : http;
    const r = mod.get(
      target,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
          'Accept-Encoding': isPatchableText ? 'gzip, deflate' : (req.headers['accept-encoding'] || 'gzip, deflate'),
          Accept: req.headers.accept || '*/*'
        },
        timeout: 25000
      },
      (up) => {
        if (up.statusCode === 301 || up.statusCode === 302 || up.statusCode === 307) {
          up.resume();
          return reject(new Error('redirect'));
        }
        if (!up.statusCode || up.statusCode >= 400) {
          up.resume();
          return reject(new Error(`HTTP ${up.statusCode}`));
        }
        resolve(up);
      }
    );
    r.on('timeout', () => { r.destroy(new Error('timeout')); reject(new Error('timeout')); });
    r.on('error', reject);
  });

  let upRes = null;
  let lastErr = null;
  for (const base of WEBBLOX_S3_BASES) {
    try {
      upRes = await fetchFromMirror(base);
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!upRes) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders });
    return res.end(`Failed to load LucideBlox resource (${cleanSub}): ${(lastErr && lastErr.message) || 'upstream error'}`);
  }

  const ext = path.extname(cleanSub.split('?')[0]).toLowerCase();
  const upCt = upRes.headers['content-type'];
  const mime = (upCt && !/application\/octet-stream/i.test(upCt)) ? upCt : (MIME_TYPES[ext] || upCt || 'application/octet-stream');
  const upLen = Number(upRes.headers['content-length'] || 0);

  if (isPatchableText || (upLen > 0 && upLen <= 1572864)) {
    const chunks = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', async () => {
      const rawBuf = Buffer.concat(chunks);
      let outBuf = rawBuf;
      let outEnc = upRes.headers['content-encoding'];
      if (isPatchableText) {
        const plain = await decompressBuffer(rawBuf, outEnc);
        let txt = plain.toString('utf8');
        if (isWispsJs) {
          txt = txt
            .replace('/fairs/`', '/wisp/`')
            .replace('let e=window.opener;', 'if(window.self!==window.top){try{window.parent.postMessage({type:_},location.origin)}catch{}return}let e=window.opener;');
        } else if (isCoreJs) {
          txt = txt.replace(
            /export function leaveFor\(url\)\s*\{[\s\S]*?location\.href\s*=\s*url;\s*\}/,
            `export function leaveFor(url) {
  let finalUrl = String(url);
  try {
    const parsedLaunch = new URL(finalUrl, location.href);
    if (parsedLaunch.searchParams.has("placeId")) {
      parsedLaunch.searchParams.set("mode", "wisp");
      if (!parsedLaunch.searchParams.get("wisp")) {
        parsedLaunch.searchParams.set("wisp", (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/");
      }
      finalUrl = parsedLaunch.href;
    }
  } catch {}
  if (/[?&]placeId=/.test(finalUrl)) {
    let win = null;
    try { win = window.open(finalUrl, "_blank"); } catch {}
    if (win) {
      try { win.focus(); } catch {}
      return;
    }
    if (window.self !== window.top) {
      try { window.parent.postMessage({ type: "astra-roblox-launch-url", url: finalUrl }, location.origin); } catch {}
    }
    const existing = document.getElementById("astra-play-tab-modal");
    if (existing) existing.remove();
    const wrap = document.createElement("div");
    wrap.id = "astra-play-tab-modal";
    wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(7,8,12,0.82);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;";
    const card = document.createElement("div");
    card.style.cssText = "max-width:400px;width:100%;background:rgba(16,17,24,0.96);border:1px solid rgba(255,255,255,0.16);border-radius:18px;padding:24px;color:#fff;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.65);";
    const h = document.createElement("h3");
    h.textContent = "Launch Game in New Tab";
    h.style.cssText = "margin:0 0 8px;font-size:17px;font-weight:700;";
    const p = document.createElement("p");
    p.textContent = "Your browser paused automatic tab opening. Click below to open Roblox in a dedicated isolated tab:";
    p.style.cssText = "margin:0 0 16px;font-size:13px;line-height:1.5;color:rgba(255,255,255,0.68);";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:center;flex-wrap:wrap;";
    const linkBtn = document.createElement("a");
    linkBtn.href = finalUrl;
    linkBtn.target = "_blank";
    linkBtn.textContent = "Open Game Tab ↗";
    linkBtn.style.cssText = "padding:10px 18px;border-radius:10px;background:#fff;color:#08090d;font-weight:700;font-size:13.5px;text-decoration:none;display:inline-flex;align-items:center;";
    linkBtn.addEventListener("click", () => { setTimeout(() => wrap.remove(), 150); });
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#fff;font-size:13px;cursor:pointer;";
    cancelBtn.addEventListener("click", () => wrap.remove());
    row.append(linkBtn, cancelBtn);
    card.append(h, p, row);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    return;
  }
  document.body.append(el("div", "leaving"));
  location.href = finalUrl;
}`
          );
        } else if (isSwJs) {
          txt = 'self.addEventListener("fetch",function(e){try{if(e.request&&e.request.url&&e.request.url.indexOf("/__nodeproxy__/")!==-1)return;}catch{}});\n' + txt.replace(
            '|^\\/launcher\\/(?!index\\.html)',
            ''
          );
        } else if (isLauncherHtml) {
          const bridge = `<script>(function(){try{var o=location.origin;var sp=new URLSearchParams(location.search);if(sp.get('mode')!=='wisp'){window.WEBLOX_SERVER=true;}var wsUrl=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/wisp/';var w=localStorage.getItem('webblox.transport');if(!w||/\\/fairs\\//i.test(w))localStorage.setItem('webblox.transport',wsUrl);function readRobloCookie(){try{var raw=localStorage.getItem('cobalt-cookies');if(!raw)return '';var arr=JSON.parse(raw);if(!Array.isArray(arr))return '';var hit=arr.find(function(c){return c&&c.n==='.ROBLOSECURITY'&&c.v;});return hit?String(hit.v):'';}catch{return '';}}function saveRobloCookie(val){var v=String(val||'').trim().replace(/^robloxcookie[:=\\/\\s]*/i,'').replace(/^\\.ROBLOSECURITY=/i,'');if(!v)return false;var domains=['roblox.com','rbxcdn.com','robloxlabs.com'];var arr=[];try{arr=JSON.parse(localStorage.getItem('cobalt-cookies')||'[]');if(!Array.isArray(arr))arr=[];}catch{arr=[];}arr=arr.filter(function(c){return c&&c.n!=='.ROBLOSECURITY';});domains.forEach(function(d){arr.push({n:'.ROBLOSECURITY',v:v,d:d,h:false,p:'/',s:true,o:true,e:0,ss:'none'});});localStorage.setItem('cobalt-cookies',JSON.stringify(arr));return true;}var promptShown=false;function showInlineCookiePrompt(){if(promptShown)return;if(location.hash&&location.hash.indexOf('#/charts')===0)return;promptShown=true;function mount(){if(document.getElementById('astra-rbx-inline-auth'))return;var wrap=document.createElement('div');wrap.id='astra-rbx-inline-auth';wrap.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(7,8,12,0.86);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,system-ui,sans-serif;';wrap.innerHTML='<div style="max-width:440px;width:100%;background:rgba(16,17,24,0.96);border:1px solid rgba(255,255,255,0.14);border-radius:18px;padding:24px;color:#fff;box-shadow:0 24px 60px rgba(0,0,0,0.65);">'+'<h2 style="margin:0 0 8px;font-size:18px;font-weight:700;">Connect Roblox Session</h2>'+'<p style="margin:0 0 14px;font-size:13px;line-height:1.5;color:rgba(255,255,255,0.68);">Paste your cookie after <code>robloxcookie=</code> below, open Setup Guide, or browse Charts.</p>'+'<form id="astra-rbx-inline-form" style="display:flex;flex-direction:column;gap:10px;">'+'<input id="astra-rbx-inline-in" type="text" value="robloxcookie=" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:#fff;font-size:12.5px;" />'+'<div id="astra-rbx-inline-err" style="font-size:12px;color:#fca5a5;display:none;"></div>'+'<div style="display:flex;gap:8px;flex-wrap:wrap;">'+'<button type="submit" style="flex:1;padding:10px 14px;border-radius:10px;border:none;background:#fff;color:#08090d;font-weight:700;font-size:13px;cursor:pointer;">Save &amp; Load</button>'+'<button type="button" id="astra-rbx-inline-charts" style="padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#fff;font-size:13px;cursor:pointer;">Browse Charts</button>'+(window.self!==window.top?'<button type="button" id="astra-rbx-inline-setup" style="padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#fff;font-size:13px;cursor:pointer;">Setup Guide</button>':'')+'</div></form></div>';document.body.appendChild(wrap);var f=document.getElementById('astra-rbx-inline-form');var inp=document.getElementById('astra-rbx-inline-in');var cb=document.getElementById('astra-rbx-inline-charts');var sb=document.getElementById('astra-rbx-inline-setup');if(cb){cb.onclick=function(){wrap.remove();location.hash='#/charts';};}if(sb){sb.onclick=function(){try{window.parent.postMessage({type:'lucideblox:sign-in'},o);}catch{}};}f.onsubmit=async function(e){e.preventDefault();var raw=inp.value.trim();var clean=raw.replace(/^robloxcookie[:=\\/\\s]*/i,'').replace(/^\\.ROBLOSECURITY=/i,'').trim();if(!clean.startsWith('_|WARNING:-DO-NOT-SHARE-THIS.')){var er=document.getElementById('astra-rbx-inline-err');er.textContent='Paste a valid .ROBLOSECURITY token after robloxcookie=';er.style.display='block';return;}saveRobloCookie(clean);try{await fetch(o+'/api/roblox/verify',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:clean})});}catch{}location.reload();};}if(document.body)mount();else addEventListener('DOMContentLoaded',mount);}var origFetch=window.fetch.bind(window);window.fetch=function(input,init){try{var urlStr=typeof input==='string'?input:(input&&input.url)||'';if(urlStr&&sp.get('mode')!=='wisp'){var parsed=new URL(urlStr,location.href);if(parsed.origin===o&&(parsed.pathname.indexOf('/3to1s93ve/__proxy__/')===0||parsed.pathname.indexOf('/__proxy__/')===0)){var idx=parsed.href.indexOf('__proxy__/');var rest=idx!==-1?parsed.href.slice(idx+'__proxy__/'.length):'';var nextUrl=o+'/3to1s93ve/__nodeproxy__/'+rest;var opts=init?Object.assign({},init):{};opts.credentials='same-origin';var hdrs=new Headers(opts.headers||(input&&typeof input!=='string'?input.headers:undefined)||undefined);var rc=readRobloCookie();if(rc&&!hdrs.has('x-astra-roblox-cookie'))hdrs.set('x-astra-roblox-cookie',rc);opts.headers=hdrs;var p=origFetch(typeof input==='string'?nextUrl:new Request(nextUrl,opts),typeof input==='string'?opts:undefined);if(rest.indexOf('users.roblox.com/v1/users/authenticated')!==-1){p=p.then(function(r){if(r&&r.status===401)showInlineCookiePrompt();return r;});}return p;}}}catch{}return origFetch(input,init);};window.addEventListener('message',function(ev){if(ev.origin!==o||!ev.data||ev.data.type!=='astra-roblox-sync')return;try{if(Array.isArray(ev.data.cookies))localStorage.setItem('cobalt-cookies',JSON.stringify(ev.data.cookies));if(ev.data.wispUrl)localStorage.setItem('webblox.transport',ev.data.wispUrl);if(ev.data.reload)location.reload();}catch{}});}catch{}})();</script>`;
          txt = /<head[^>]*>/i.test(txt) ? txt.replace(/<head[^>]*>/i, (m) => m + bridge) : txt.replace(/<\/head>/i, bridge + '</head>');
        }
        outBuf = Buffer.from(txt, 'utf8');
        outEnc = undefined;
      }
      const outMime = (isWispsJs || isCoreJs || isSwJs) ? 'application/javascript; charset=utf-8' : (isPatchableText ? 'text/html; charset=utf-8' : mime);
      const hdrs = {
        'Content-Type': outMime,
        'Content-Length': outBuf.length,
        'Cache-Control': isPatchableText ? 'no-store' : 'public, max-age=3600'
      };
      if (outEnc) hdrs['Content-Encoding'] = outEnc;
      if (webbloxMemCache.size < 220) {
        webbloxMemCache.set(cleanSub, { headers: hdrs, body: outBuf, expires: Date.now() + (isPatchableText ? 60000 : 1800000) });
      }
      res.writeHead(200, { ...hdrs, ...extraHeaders });
      res.end(outBuf);
    });
    return;
  }

  const streamHdrs = {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=86400',
    ...extraHeaders
  };
  if (upRes.headers['content-encoding']) streamHdrs['Content-Encoding'] = upRes.headers['content-encoding'];
  if (upRes.headers['content-length']) streamHdrs['Content-Length'] = upRes.headers['content-length'];
  res.writeHead(upRes.statusCode || 200, streamHdrs);
  upRes.pipe(res);
}

function fetchAndProxy(targetUrl, adblock, req, res, redirectsLeft = 5, engine = 'scramjet') {
  const eng = normalizeEngine(engine);
  if (adblock && isBlockedAdHost(targetUrl)) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    return res.end();
  }

  // Transparently mirror blocked cdn.jsdelivr.net/gh/gn-math/* requests to GitHub raw
  const gnJsdelivrMatch = String(targetUrl || '').match(
    /^https?:\/\/cdn\.jsdelivr\.net\/gh\/gn-math\/([^/@?#]+)(?:@([^/?#]+))?\/([^?#]+)(\?[^#]*)?/i
  );
  if (gnJsdelivrMatch) {
    const branch = !gnJsdelivrMatch[2] || /^latest$/i.test(gnJsdelivrMatch[2]) ? 'main' : gnJsdelivrMatch[2];
    targetUrl = `https://raw.githubusercontent.com/gn-math/${gnJsdelivrMatch[1]}/${branch}/${gnJsdelivrMatch[3]}${gnJsdelivrMatch[4] || ''}`;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Invalid URL');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*'
    });
    return res.end();
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())
    ? String(req.method).toUpperCase()
    : 'GET';
  const uaRaw =
    req.headers['user-agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': uaRaw.replace(/HeadlessChrome/gi, 'Chrome'),
    Accept: req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'Accept-Encoding': /googlevideo\.com|videoplayback/i.test(targetUrl) ? 'identity' : 'gzip, deflate, br',
    Referer: parsed.origin + '/'
  };
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }
  const proxySessionUser = typeof getSessionUser === 'function' ? getSessionUser(req) : null;
  if (proxySessionUser && proxySessionUser.username) {
    const savedCookieHdr = getUserCookieHeader(proxySessionUser.username, parsed.hostname);
    if (savedCookieHdr) headers.Cookie = savedCookieHdr;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers.Origin = parsed.origin;
  }
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
  if (req.headers.cookie) {
    const cleanedCookie = req.headers.cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('astra_session='))
      .join('; ');
    if (cleanedCookie) headers.Cookie = cleanedCookie;
  }

  const proxyReq = client.request(
    parsed,
    {
      method,
      headers,
      maxHeaderSize: 131072
    },
    (proxyRes) => {
      // Follow GET/HEAD redirects server-side cleanly
      if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && redirectsLeft > 0 && (method === 'GET' || method === 'HEAD' || proxyRes.statusCode === 303)) {
        const nextUrl = new URL(proxyRes.headers.location, targetUrl).toString();
        proxyRes.resume();
        return fetchAndProxy(nextUrl, adblock, req, res, redirectsLeft - 1, eng);
      }

      const outHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lower = k.toLowerCase();
        if (
          lower === 'x-frame-options' ||
          lower === 'content-security-policy' ||
          lower === 'content-security-policy-report-only' ||
          lower === 'x-content-security-policy' ||
          lower === 'cross-origin-opener-policy' ||
          lower === 'cross-origin-embedder-policy' ||
          lower === 'cross-origin-resource-policy' ||
          lower === 'content-length' ||
          lower === 'transfer-encoding' ||
          lower === 'content-encoding'
        ) {
          continue;
        }
        if (lower === 'location' && typeof v === 'string') {
          const absLoc = resolveMaybeUrl(v, targetUrl);
          outHeaders[k] = absLoc ? makeProxyUrl(absLoc, adblock, eng) : v;
          continue;
        }
        if (lower === 'set-cookie' && Array.isArray(v)) {
          if (proxySessionUser && proxySessionUser.username) {
            saveUserCookiesFromSetCookie(proxySessionUser.username, parsed.hostname, v);
          }
          outHeaders[k] = v.map((c) =>
            c
              .replace(/;\s*Domain=[^;]*/gi, '')
              .replace(/;\s*SameSite=None/gi, '; SameSite=Lax')
              .replace(/;\s*Secure/gi, '')
          );
          continue;
        }
        outHeaders[k] = v;
      }
      outHeaders['Access-Control-Allow-Origin'] = '*';
      outHeaders['X-Astra-Engine'] = eng;

      const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isRawHost = /(?:raw\.githubusercontent\.com|githack\.com)$/i.test(parsed.hostname);
      const isRawTextPlain = contentType.includes('text/plain') || !contentType;
      const isRawTextHtml = isRawHost && isRawTextPlain && /\.(?:html?)(?:$|\?)/i.test(parsed.pathname);
      const isRawTextCss = isRawHost && isRawTextPlain && /\.css(?:$|\?)/i.test(parsed.pathname);
      const isRawTextJs = isRawHost && isRawTextPlain && /\.(?:m?js)(?:$|\?)/i.test(parsed.pathname);
      if (isRawTextHtml) outHeaders['content-type'] = 'text/html; charset=utf-8';
      else if (isRawTextCss) outHeaders['content-type'] = 'text/css; charset=utf-8';
      else if (isRawTextJs) outHeaders['content-type'] = 'application/javascript; charset=utf-8';

      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || isRawTextHtml;
      const isCss = contentType.includes('text/css') || isRawTextCss;
      const isJs =
        contentType.includes('javascript') ||
        contentType.includes('ecmascript') ||
        isRawTextJs ||
        /\.(?:m?js)(?:$|\?)/i.test(parsed.pathname);

      if (!isHtml && !isCss && !isJs) {
        if (proxyRes.headers['content-encoding']) {
          outHeaders['content-encoding'] = proxyRes.headers['content-encoding'];
        }
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        return proxyRes.pipe(res);
      }

      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', async () => {
        const rawBuf = Buffer.concat(chunks);
        const plainBuf = await decompressBuffer(rawBuf, proxyRes.headers['content-encoding']);
        let text = plainBuf.toString('utf8');
        if (isHtml) text = rewriteHtml(text, targetUrl, adblock, eng);
        else if (isCss) text = rewriteCss(text, targetUrl, adblock, eng);
        else text = rewriteJs(text);
        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        res.end(text, 'utf8');
      });
    }
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<html><body style="background:#07070b;color:#f5f5f7;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;">
        <div style="max-width:460px;padding:28px;border:1px solid rgba(255,255,255,0.12);border-radius:16px;background:rgba(16,16,22,0.9);">
          <h2 style="margin:0 0 8px;font-weight:500;">could not reach site</h2>
          <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.58);line-height:1.5;">${err.message}</p>
        </div>
      </body></html>`
    );
  });

  if (method !== 'GET' && method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function serveStaticFile(filePath, req, res, extraHeaders = {}) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, must-revalidate',
        ...extraHeaders
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, must-revalidate',
        ...extraHeaders
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

function serveFromDir(baseDir, subPath, req, res, extraHeaders = {}) {
  try {
    const cleanSub = decodeURIComponent(String(subPath || '')).split('?')[0].replace(/^[/\\]+/, '');
    const baseResolved = path.resolve(baseDir);
    const targetResolved = path.resolve(baseResolved, cleanSub);
    if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    return serveStaticFile(targetResolved, req, res, extraHeaders);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad path');
  }
}

function buildUvConfigScript() {
  return `/*global Ultraviolet*/
self.__uv$config = {
  prefix: '/uv/service/',
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: '/uv/uv.handler.js',
  client: '/uv/uv.client.js',
  bundle: '/uv/uv.bundle.js',
  config: '/uv/uv.config.js',
  sw: '/uv/uv.sw.js'
};
`;
}

function buildUnifiedServiceWorkerScript() {
  const unityFixSnippet = `<script>(function(){if(window.__astraUnityFixDone)return;window.__astraUnityFixDone=true;function isUC(el){if(!el||!el.tagName||el.tagName!=='CANVAS')return false;var id=(el.id||'').toLowerCase();var p=el.parentElement;var pid=p&&p.id?p.id.toLowerCase():'';return id==='#canvas'||pid==='gamecontainer'||pid==='unitycontainer'||pid==='unity-container'||!!(el.closest&&el.closest('#gameContainer,#unityContainer,#unity-container'));}function syncUCS(el){if(!isUC(el))return;var cw=el.clientWidth||(el.parentElement?el.parentElement.clientWidth:0);var ch=el.clientHeight||(el.parentElement?el.parentElement.clientHeight:0);if(cw>100&&el.width!==cw)el.width=cw;if(ch>100&&el.height!==ch)el.height=ch;}if(window.HTMLCanvasElement&&HTMLCanvasElement.prototype.getContext){var oGC=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(){syncUCS(this);return oGC.apply(this,arguments);};}window.addEventListener('resize',function(){var c=document.querySelector('#gameContainer>canvas,#unityContainer>canvas,#unity-container>canvas');if(c)syncUCS(c);});})();</script><style id="astraUnityCanvasFix">#gameContainer>canvas,#unityContainer>canvas,#unity-container>canvas,canvas[id="#canvas"]{width:100%!important;height:100%!important;display:block!important;}</style>`;
  return `/* Astra Unified Real Scramjet + Ultraviolet Service Worker */
importScripts('/baremux/index.js');
importScripts('/scram/scramjet.all.js');
importScripts('/uv/uv.bundle.js');
importScripts('/uv/uv.config.js');
importScripts('/uv/uv.sw.js');

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const uv = new UVServiceWorker();

let astraAdblockEnabled = true;
let astraCapturedRoblosecurity = '';
function findRoblosecurityInJarObj(obj) {
  if (!obj) return '';
  const list = Array.isArray(obj) ? obj : (typeof obj === 'object' ? Object.values(obj) : []);
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const dom = String(c.domain || c.d || '').replace(/^\\./, '').toLowerCase();
    const nm = c.name || c.n;
    const val = c.value || c.v;
    if (nm === '.ROBLOSECURITY' && typeof val === 'string' && val && (!dom || dom === 'roblox.com' || dom.endsWith('.roblox.com'))) {
      return val;
    }
  }
  return '';
}
function saveAstraRoblosecurityCookie(val) {
  if (!val || typeof val !== 'string') return;
  const clean = val.trim();
  if (!clean) return;
  astraCapturedRoblosecurity = clean;
  try {
    const req = indexedDB.open('$astra_rbx', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(clean, 'cookie');
      } catch {}
    };
  } catch {}
}
function readIdbSafe(dbName, fn) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName);
      let upgraded = false;
      req.onupgradeneeded = () => { upgraded = true; };
      req.onerror = () => resolve('');
      req.onsuccess = () => {
        const db = req.result;
        if (upgraded) {
          try { db.close(); indexedDB.deleteDatabase(dbName); } catch {}
          return resolve('');
        }
        fn(db, (v) => { try { db.close(); } catch {} resolve(v || ''); });
      };
    } catch { resolve(''); }
  });
}
async function readAstraRoblosecurityFromSwStores() {
  if (astraCapturedRoblosecurity) return astraCapturedRoblosecurity;
  try {
    if (scramjet && scramjet.cookieStore) {
      const hit = findRoblosecurityInJarObj(scramjet.cookieStore.cookies || (typeof scramjet.cookieStore.dump === 'function' ? JSON.parse(scramjet.cookieStore.dump() || '{}') : null));
      if (hit) return hit;
    }
  } catch {}
  const fromAstra = await readIdbSafe('$astra_rbx', (db, done) => {
    try {
      if (!db.objectStoreNames.contains('kv')) return done('');
      const r = db.transaction('kv', 'readonly').objectStore('kv').get('cookie');
      r.onsuccess = () => done(typeof r.result === 'string' ? r.result : '');
      r.onerror = () => done('');
    } catch { done(''); }
  });
  if (fromAstra) return fromAstra;
  const fromSj = await readIdbSafe('$scramjet', (db, done) => {
    try {
      if (!db.objectStoreNames.contains('cookies')) return done('');
      const r = db.transaction('cookies', 'readonly').objectStore('cookies').get('cookies');
      r.onsuccess = () => done(findRoblosecurityInJarObj(r.result));
      r.onerror = () => done('');
    } catch { done(''); }
  });
  if (fromSj) return fromSj;
  const fromUv = await readIdbSafe('__op', (db, done) => {
    try {
      if (!db.objectStoreNames.contains('cookies')) return done('');
      const r = db.transaction('cookies', 'readonly').objectStore('cookies').getAll();
      r.onsuccess = () => done(findRoblosecurityInJarObj(r.result));
      r.onerror = () => done('');
    } catch { done(''); }
  });
  return fromUv || '';
}
const ASTRA_AD_HOSTS = ${JSON.stringify(getMergedAdHosts())};
const ASTRA_UNITY_FIX_SNIPPET = ${JSON.stringify(unityFixSnippet)};
const ASTRA_FRAME_FIX_SNIPPET = ${JSON.stringify(
    '<script data-astra-frame-fix="1">(function(){try{Object.defineProperty(window,"outerWidth",{get:function(){return window.innerWidth||1280;},configurable:true});Object.defineProperty(window,"outerHeight",{get:function(){return window.innerHeight||800;},configurable:true});Object.defineProperty(window,"frameElement",{get:function(){return null;},configurable:true});}catch(e){}})();</script>'
  )};
const ASTRA_COSMETIC_ADBLOCK_SNIPPET = ${JSON.stringify(
    '<style id="astraAdCosmetic">ins.adsbygoogle,[id^="google_ads_iframe"],[id^="div-gpt-ad"],[data-google-query-id],iframe[src*="doubleclick"],iframe[src*="googlesyndication"],iframe[src*="adsterra"],iframe[src*="exoclick"],iframe[src*="propeller"],iframe[src*="monetag"],[id^="taboola-"],.taboola_wrap,.OUTBRAIN,[data-widget-id*="taboola"],.mgbox,[id^="M"][id*="Composite"],.ad-banner,.ad-slot,.advertisement-banner,.adsbox{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;pointer-events:none!important;}</style><script data-astra-cosmetic-adblock="1">(function(){if(window.__astraCosmeticShield)return;window.__astraCosmeticShield=true;var hosts=' +
      JSON.stringify(getMergedAdHosts()) +
      ';function isAdHref(u){if(!u||typeof u!=="string")return false;try{var x=new URL(u,location.href);if((x.pathname.indexOf("/scramjet/")===0||x.pathname.indexOf("/uv/service/")===0)&&x.href){/* handled by SW */}var h=x.hostname.toLowerCase();return hosts.some(function(d){return h===d||h.endsWith("."+d);})||/(?:popunder|pagead|adserver|clickadu|adsterra|exoclick|monetag|propeller)/i.test(u);}catch(e){return false;}}try{var ow=window.open;window.open=function(u,t,f){if(!u||isAdHref(String(u)))return null;if(t==="_blank"||!t){try{location.assign(u);}catch(e){}return null;}return ow?ow.apply(this,arguments):null;};}catch(e){}document.addEventListener("click",function(ev){try{var tgt=ev.target;if(tgt&&tgt.tagName==="DIV"||tgt&&tgt.tagName==="A"){var cs=getComputedStyle(tgt);var r=tgt.getBoundingClientRect();if(cs.position==="fixed"&&r.width>=window.innerWidth*0.85&&r.height>=window.innerHeight*0.85&&(!tgt.innerText||tgt.innerText.trim().length===0)&&(parseFloat(cs.opacity||"1")<=0.05||parseInt(cs.zIndex||"0",10)>=9999)){ev.preventDefault();ev.stopPropagation();tgt.remove();return;}}var a=tgt&&tgt.closest?tgt.closest("a[href]"):null;if(a&&isAdHref(a.getAttribute("href"))){ev.preventDefault();ev.stopPropagation();a.remove();}}catch(e){}},true);})();</script>'
  )};
const ASTRA_YT_ADBLOCK_SNIPPET = ${JSON.stringify(
    '<style id="astraYtAdShield">.ytp-ad-overlay-container,.ytp-ad-module,.ytp-ad-player-overlay,ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,ytd-display-ad-renderer,ytd-statement-banner-renderer,ytd-promoted-sparkles-web-renderer,.ytd-banner-promo-renderer,#masthead-ad,#player-ads,ytd-companion-slot-renderer,ytm-promoted-sparkles-web-renderer,ytm-companion-ad-renderer{display:none!important;}</style><script data-astra-yt-adblock="1">(function(){if(window.__astraYtAdShield)return;window.__astraYtAdShield=true;var wasAd=false;setInterval(function(){try{var p=document.querySelector(".html5-video-player");var v=document.querySelector("video");var sk=document.querySelector(".ytp-ad-skip-button,.ytp-skip-ad-button,.ytp-ad-skip-button-modern,.ytp-ad-skip-button-slot button");if(sk)sk.click();var adOn=!!(p&&p.classList.contains("ad-showing"));if(adOn&&v){wasAd=true;v.muted=true;try{v.playbackRate=16;}catch(e){}if(isFinite(v.duration)&&v.duration>0){v.currentTime=Math.max(0,v.duration-0.1);}}else if(wasAd&&!adOn&&v){wasAd=false;v.muted=false;try{v.playbackRate=1;}catch(e){}}}catch(e){}},250);})();</script>'
  )};

function astraXorDecode(str) {
  try {
    const dec = decodeURIComponent(String(str || ''));
    let out = '';
    for (let i = 0; i < dec.length; i++) {
      out += i % 2 === 1 ? String.fromCharCode(dec.charCodeAt(i) ^ 2) : dec[i];
    }
    return out;
  } catch {
    return '';
  }
}

function decodeProxiedUrlStr(urlStr) {
  try {
    const s = String(urlStr || '');
    if (!s) return '';
    const scramPrefixPath = (typeof scramjet !== 'undefined' && scramjet && scramjet.config && scramjet.config.prefix) || '/scramjet/';
    const scramBase = location.origin + scramPrefixPath;
    if (s.startsWith(scramBase)) {
      const tail = s.slice(scramBase.length).split('#')[0];
      if (/^(?:hvtrs8|hvvr)/i.test(tail)) return astraXorDecode(tail);
      const dec = decodeURIComponent(tail);
      return /^https?:\\/\\//i.test(dec) ? dec : '';
    }
    if (typeof __uv$config !== 'undefined' && __uv$config && __uv$config.prefix && typeof __uv$config.decodeUrl === 'function') {
      const uvBase = location.origin + __uv$config.prefix;
      if (s.startsWith(uvBase)) {
        const tail = s.slice(uvBase.length).split('#')[0];
        const dec = __uv$config.decodeUrl(tail);
        return /^https?:\\/\\//i.test(dec) ? dec : '';
      }
    }
  } catch {}
  return '';
}

function normalizeTargetKey(uStr) {
  try {
    const u = new URL(String(uStr || ''));
    u.hash = '';
    return u.href;
  } catch {
    return String(uStr || '');
  }
}

function isLocalOriginUrl(uStr) {
  return /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost)(?::\\d+)?(?:\\/|$)/i.test(String(uStr || ''));
}

const pendingCtxByUrl = new Map();
function pushPendingCtx(urlKey, ctx) {
  if (!urlKey || !ctx) return null;
  let q = pendingCtxByUrl.get(urlKey);
  if (!q) {
    q = [];
    pendingCtxByUrl.set(urlKey, q);
  }
  const entry = { ctx };
  q.push(entry);
  return entry;
}
function takePendingCtx(urlKey) {
  const q = pendingCtxByUrl.get(urlKey);
  if (!q || q.length === 0) return null;
  const entry = q.shift();
  if (q.length === 0) pendingCtxByUrl.delete(urlKey);
  return entry ? entry.ctx : null;
}
function removePendingCtx(urlKey, entry) {
  if (!urlKey || !entry) return;
  const q = pendingCtxByUrl.get(urlKey);
  if (!q) return;
  const idx = q.indexOf(entry);
  if (idx !== -1) q.splice(idx, 1);
  if (q.length === 0) pendingCtxByUrl.delete(urlKey);
}

async function getUpstreamContext(event) {
  try {
    const ref = event && event.request ? (event.request.referrer || '') : '';
    const decRef = decodeProxiedUrlStr(ref);
    if (decRef) {
      return { ref: decRef, origin: new URL(decRef).origin };
    }
    const cid = event && event.clientId ? event.clientId : '';
    if (cid && self.clients && typeof self.clients.get === 'function') {
      const client = await self.clients.get(cid);
      const clientUrl = client && client.url ? client.url : '';
      const decClient = decodeProxiedUrlStr(clientUrl);
      if (decClient) {
        return { ref: decClient, origin: new URL(decClient).origin };
      }
    }
  } catch {}
  return null;
}

function notifyAstraAdBlocked(urlStr) {
  try {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
      for (const c of cls) {
        try { c.postMessage({ type: 'astra-ad-blocked', count: 1, url: urlStr || '' }); } catch {}
      }
    }).catch(() => {});
  } catch {}
}

function createBlockedAdResponse(urlStr, isBare) {
  let body = '';
  let status = 204;
  let ct = 'text/plain; charset=utf-8';
  const low = String(urlStr || '').toLowerCase();
  if (/\\.m?js(?:$|\\?)|\\/prebid|\\/adsbygoogle|\\/pubads|\\/popunder/i.test(low)) {
    body = '/* blocked by astra adblock */';
    status = 200;
    ct = 'application/javascript; charset=utf-8';
  } else if (/\\.css(?:$|\\?)/i.test(low)) {
    body = '/* blocked by astra adblock */';
    status = 200;
    ct = 'text/css; charset=utf-8';
  } else if (/\\.json(?:$|\\?)|\\/api\\/stats\\/|\\/player\\/ad_break|\\/get_midroll/i.test(low)) {
    body = '{}';
    status = 200;
    ct = 'application/json; charset=utf-8';
  }
  const headers = new Headers({ 'content-type': ct, 'access-control-allow-origin': '*' });
  const r = new Response(status === 204 ? null : body, { status, statusText: status === 204 ? 'No Content' : 'OK', headers });
  if (isBare) {
    r.rawHeaders = { 'content-type': ct, 'access-control-allow-origin': '*' };
    r.finalURL = String(urlStr || '');
  }
  return r;
}

function patchBareClientInstance(client) {
  if (!client || client.__astraPatched || typeof client.fetch !== 'function') return;
  client.__astraPatched = true;
  const origFetch = client.fetch.bind(client);
  client.fetch = async function patchedBareFetch(remote, init) {
    let nextInit = init;
    const rawTargetStr = String(remote || '');
    if (astraAdblockEnabled && isAdBlockedTarget(rawTargetStr)) {
      notifyAstraAdBlocked(rawTargetStr);
      return createBlockedAdResponse(rawTargetStr, true);
    }
    try {
      const targetStr = rawTargetStr;
      const targetKey = normalizeTargetKey(targetStr);
      const ctx = takePendingCtx(targetKey);
      const targetUrl = new URL(targetStr);
      const reqHeadersObj = {};
      const srcHeaders = init && init.headers;
      if (srcHeaders) {
        const entries = srcHeaders instanceof Headers ? srcHeaders.entries() : Object.entries(srcHeaders);
        for (const [k, v] of entries) {
          reqHeadersObj[k] = v;
        }
      }
      const getHeaderCI = (name) => {
        const lower = name.toLowerCase();
        for (const k of Object.keys(reqHeadersObj)) {
          if (k.toLowerCase() === lower) return String(reqHeadersObj[k] || '');
        }
        return '';
      };
      const setHeaderCI = (name, val) => {
        const lower = name.toLowerCase();
        for (const k of Object.keys(reqHeadersObj)) {
          if (k.toLowerCase() === lower) delete reqHeadersObj[k];
        }
        if (val !== null && val !== undefined && val !== '') {
          reqHeadersObj[lower] = String(val);
        }
      };

      let curRef = getHeaderCI('referer');
      if (curRef && isLocalOriginUrl(curRef)) {
        const unwrapped = decodeProxiedUrlStr(curRef);
        curRef = unwrapped || '';
      }
      if (!curRef && ctx && ctx.ref) {
        curRef = ctx.ref;
      }
      if (curRef) {
        try {
          const refUrlObj = new URL(curRef);
          if (refUrlObj.origin !== targetUrl.origin) {
            curRef = refUrlObj.origin + '/';
          }
        } catch {}
        setHeaderCI('referer', curRef);
      }

      let curOrigin = getHeaderCI('origin');
      if (curOrigin && isLocalOriginUrl(curOrigin)) {
        const unwrappedOrig = decodeProxiedUrlStr(curOrigin);
        if (unwrappedOrig) {
          try { curOrigin = new URL(unwrappedOrig).origin; } catch { curOrigin = ''; }
        } else {
          curOrigin = '';
        }
      }
      if (!curOrigin && ctx && ctx.origin) {
        const sfMode = getHeaderCI('sec-fetch-mode').toLowerCase();
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (sfMode === 'cors' || (method !== 'GET' && method !== 'HEAD')) {
          curOrigin = ctx.origin;
        }
      }
      if (curOrigin) {
        setHeaderCI('origin', curOrigin);
      } else {
        setHeaderCI('origin', '');
      }

      if (curRef) {
        try {
          const refOrigin = new URL(curRef).origin;
          const computedSite = refOrigin === targetUrl.origin ? 'same-origin' : 'cross-site';
          const curSite = getHeaderCI('sec-fetch-site').toLowerCase();
          if (!curSite || curSite !== computedSite) {
            setHeaderCI('sec-fetch-site', computedSite);
          }
        } catch {}
      }

      nextInit = Object.assign({}, init || {}, { headers: reqHeadersObj });
      try {
        const th = targetUrl.hostname.toLowerCase();
        if (th === 'roblox.com' || th.endsWith('.roblox.com')) {
          const outCookie = getHeaderCI('cookie');
          const m = outCookie && outCookie.match(/(?:^|[;,\\s])\\.ROBLOSECURITY=([^;\\s]+)/);
          if (m && m[1]) saveAstraRoblosecurityCookie(decodeURIComponent(m[1]));
        }
      } catch {}
    } catch {}
    const resp = await origFetch(remote, nextInit);
    try {
      const targetStr = String((resp && resp.finalURL) || remote || '');
      const u = new URL(targetStr);
      const th = u.hostname.toLowerCase();
      if (th === 'roblox.com' || th.endsWith('.roblox.com')) {
        try {
          const scList = [];
          if (resp && resp.rawHeaders && typeof resp.rawHeaders === 'object') {
            for (const [hk, hv] of Object.entries(resp.rawHeaders)) {
              if (String(hk).toLowerCase() === 'set-cookie') {
                if (Array.isArray(hv)) scList.push(...hv);
                else if (hv) scList.push(String(hv));
              }
            }
          }
          if (resp && resp.headers) {
            if (typeof resp.headers.getSetCookie === 'function') {
              scList.push(...resp.headers.getSetCookie());
            } else {
              const gsc = resp.headers.get('set-cookie');
              if (gsc) scList.push(gsc);
            }
          }
          for (const entry of scList) {
            const m = String(entry || '').match(/(?:^|[;,\\s])\\.ROBLOSECURITY=([^;\\s]+)/);
            if (m && m[1]) saveAstraRoblosecurityCookie(decodeURIComponent(m[1]));
          }
        } catch {}
      }
      const origCt = (resp.headers.get('content-type') || '').toLowerCase();
      if (astraAdblockEnabled && /youtubei\\/v1\\/player/i.test(targetStr) && origCt.includes('json')) {
        try {
          const data = await resp.clone().json();
          if (data && typeof data === 'object' && (data.adPlacements || data.playerAds || data.adSlots)) {
            delete data.adPlacements;
            delete data.playerAds;
            delete data.adSlots;
            notifyAstraAdBlocked(targetStr);
            const headers = new Headers(resp.headers);
            headers.delete('content-length');
            const rawHeaders = Object.assign({}, resp.rawHeaders || {});
            delete rawHeaders['content-length'];
            delete rawHeaders['Content-Length'];
            const cleaned = new Response(JSON.stringify(data), {
              status: resp.status,
              statusText: resp.statusText,
              headers
            });
            cleaned.rawHeaders = rawHeaders;
            cleaned.rawResponse = resp.rawResponse;
            cleaned.finalURL = resp.finalURL;
            return cleaned;
          }
        } catch {}
      }
      const isRawHost = /(?:^|\\.)(raw\\.githubusercontent\\.com|gist\\.githubusercontent\\.com|githack\\.com)$/i.test(u.hostname);
      if (isRawHost && (!origCt || origCt.includes('text/plain'))) {
        let newCt = '';
        if (/\\.html?$/i.test(u.pathname)) newCt = 'text/html; charset=utf-8';
        else if (/\\.css$/i.test(u.pathname)) newCt = 'text/css; charset=utf-8';
        else if (/\\.m?js$/i.test(u.pathname)) newCt = 'application/javascript; charset=utf-8';
        if (newCt) {
          const headers = new Headers(resp.headers);
          headers.set('content-type', newCt);
          const rawHeaders = Object.assign({}, resp.rawHeaders || {});
          for (const k of Object.keys(rawHeaders)) {
            if (k.toLowerCase() === 'content-type') delete rawHeaders[k];
          }
          rawHeaders['content-type'] = newCt;
          const patched = new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers
          });
          patched.rawHeaders = rawHeaders;
          patched.rawResponse = resp.rawResponse;
          patched.finalURL = resp.finalURL;
          return patched;
        }
      }
    } catch {}
    return resp;
  };
}

patchBareClientInstance(scramjet && scramjet.client);
patchBareClientInstance(uv && uv.bareClient);

function isAdBlockedTarget(urlStr) {
  if (!astraAdblockEnabled || !urlStr) return false;
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (ASTRA_AD_HOSTS.some((d) => h === d || h.endsWith('.' + d))) return true;
    const p = u.pathname || '';
    if ((h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtube-nocookie.com' || h.endsWith('.youtube-nocookie.com')) &&
        /(?:^\\/pagead\\/|^\\/ptracking|^\\/api\\/stats\\/(?:ads|atr)|^\\/youtubei\\/v1\\/player\\/ad_break|^\\/get_midroll_info)/i.test(p)) {
      return true;
    }
    if (/(?:\\/gpt\\/pubads_impl|\\/pagead\\/js\\/adsbygoogle|\\/pagead\\/show_ads|\\/prebid(?:[.-][^/]*)?\\.js|\\/popunder(?:[.-][^/]*)?\\.js|\\/vast\\.xml|\\/vpaid|\\/adserver\\/)/i.test(p)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function maybePatchProxiedHtml(event, res) {
  try {
    if (!res || res.status < 200 || res.status >= 300) return res;
    const dest = event && event.request ? event.request.destination : '';
    if (dest !== 'iframe' && dest !== 'document') return res;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isHtmlCt = ct.includes('text/html');
    const isPlain = !ct || ct.includes('text/plain');
    if (!isHtmlCt && !isPlain) return res;
    const text = await res.clone().text();
    const looksHtml = isHtmlCt || /<\\s*(?:!doctype|html|head|body|link|script|div)[\\s>]/i.test(text.slice(0, 512));
    if (!looksHtml) return res;
    const isUnity = /gameContainer|unityContainer|unity-container|UnityLoader/i.test(text);
    const decTarget = decodeProxiedUrlStr((event && event.request && event.request.url) || '');
    const isYt = astraAdblockEnabled && /(?:youtube\\.com|youtube-nocookie\\.com|youtu\\.be)/i.test(decTarget);
    const injectPayload = ASTRA_FRAME_FIX_SNIPPET + (isUnity ? ASTRA_UNITY_FIX_SNIPPET : '') + (astraAdblockEnabled ? ASTRA_COSMETIC_ADBLOCK_SNIPPET : '') + (isYt ? ASTRA_YT_ADBLOCK_SNIPPET : '');
    let patched = text;
    if (/<\\/head>/i.test(text)) {
      patched = text.replace(/<\\/head>/i, injectPayload + '</head>');
    } else if (/<\\/body>/i.test(text)) {
      patched = text.replace(/<\\/body>/i, injectPayload + '</body>');
    } else {
      patched = injectPayload + text;
    }
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    if (!isHtmlCt) headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(patched, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

let scramjetLoadPromise = null;
let scramjetFullyInitialized = false;

async function ensureScramjetSwLoaded() {
  if (scramjetFullyInitialized && scramjet.config) {
    patchBareClientInstance(scramjet.client);
    return;
  }
  if (!scramjetLoadPromise) {
    scramjetLoadPromise = (async () => {
      try {
        scramjet.config = null;
        await scramjet.loadConfig();
        if (scramjet.config) scramjetFullyInitialized = true;
        patchBareClientInstance(scramjet.client);
      } finally {
        scramjetLoadPromise = null;
      }
    })();
  }
  await scramjetLoadPromise;
}

self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'astra-adblock') {
    astraAdblockEnabled = !!event.data.enabled;
  } else if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event && event.data && event.data.type === 'astra-get-roblox-cookie' && event.ports && event.ports[0]) {
    event.waitUntil((async () => {
      try {
        const cookie = await readAstraRoblosecurityFromSwStores();
        event.ports[0].postMessage({ cookie: cookie || '' });
      } catch {
        event.ports[0].postMessage({ cookie: '' });
      }
    })());
  }
});

async function handleRequest(event) {
  const reqUrl = event && event.request ? (event.request.url || '') : '';
  const isScramjetReq =
    reqUrl.startsWith(location.origin + '/scramjet/') ||
    reqUrl.startsWith(location.origin + '/scram/scramjet.wasm.wasm');
  const isUvReq = reqUrl.startsWith(location.origin + __uv$config.prefix);
  if (!isScramjetReq && !isUvReq) {
    if (reqUrl && !reqUrl.startsWith(location.origin) && /^https?:\\/\\//i.test(reqUrl) && event.request.mode !== 'navigate') {
      if (isAdBlockedTarget(reqUrl)) {
        notifyAstraAdBlocked(reqUrl);
        return createBlockedAdResponse(reqUrl, false);
      }
      try {
        const leakCtx = await getUpstreamContext(event);
        if (leakCtx && leakCtx.ref) {
          let bare = (uv && uv.bareClient) || (scramjet && scramjet.client);
          if (!bare) {
            try { await ensureScramjetSwLoaded(); } catch {}
            bare = (scramjet && scramjet.client) || (uv && uv.bareClient);
          }
          if (bare) {
            patchBareClientInstance(bare);
            const method = (event.request.method || 'GET').toUpperCase();
            if (method === 'OPTIONS') {
              const reqOrigin = event.request.headers.get('origin') || location.origin;
              return new Response(null, {
                status: 204,
                headers: {
                  'access-control-allow-origin': event.request.credentials === 'include' ? reqOrigin : '*',
                  'access-control-allow-credentials': 'true',
                  'access-control-allow-methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
                  'access-control-allow-headers': '*',
                  'access-control-max-age': '86400'
                }
              });
            }
            let fwdRef = leakCtx.ref;
            try {
              const refUrlObj = new URL(leakCtx.ref);
              const tgtUrlObj = new URL(reqUrl);
              if (refUrlObj.origin !== tgtUrlObj.origin) {
                fwdRef = refUrlObj.origin + '/';
              }
            } catch {}
            const fwdHeaders = {
              referer: fwdRef,
              'user-agent': (typeof navigator !== 'undefined' && navigator.userAgent) || 'Mozilla/5.0'
            };
            const acceptHdr = event.request.headers.get('accept');
            if (acceptHdr) fwdHeaders.accept = acceptHdr;
            const rangeHdr = event.request.headers.get('range');
            if (rangeHdr) fwdHeaders.range = rangeHdr;
            if (event.request.mode === 'cors' || (method !== 'GET' && method !== 'HEAD')) {
              fwdHeaders.origin = leakCtx.origin;
            }
            try {
              const targetOrigin = new URL(reqUrl).origin;
              fwdHeaders['sec-fetch-site'] = leakCtx.origin === targetOrigin ? 'same-origin' : 'cross-site';
            } catch {}
            let bodyBuf = undefined;
            if (method !== 'GET' && method !== 'HEAD') {
              try { bodyBuf = await event.request.arrayBuffer(); } catch {}
            }
            const bareRes = await bare.fetch(reqUrl, {
              method,
              headers: fwdHeaders,
              body: bodyBuf && bodyBuf.byteLength ? bodyBuf : undefined,
              redirect: 'follow'
            });
            const outHeaders = new Headers(bareRes.headers);
            const acaoOrigin = event.request.credentials === 'include' ? location.origin : '*';
            outHeaders.set('access-control-allow-origin', acaoOrigin);
            if (event.request.credentials === 'include') {
              outHeaders.set('access-control-allow-credentials', 'true');
            }
            outHeaders.set('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS');
            outHeaders.set('access-control-allow-headers', '*');
            outHeaders.set('access-control-expose-headers', '*');
            outHeaders.delete('content-security-policy');
            outHeaders.delete('content-security-policy-report-only');
            outHeaders.delete('x-frame-options');
            const nullBodyStatus = bareRes.status === 204 || bareRes.status === 205 || bareRes.status === 304 || method === 'HEAD';
            return new Response(nullBodyStatus ? null : bareRes.body, {
              status: bareRes.status,
              statusText: bareRes.statusText,
              headers: outHeaders
            });
          }
        }
      } catch {}
    }
    return await fetch(event.request);
  }
  try {
    if (isScramjetReq) {
      try {
        await ensureScramjetSwLoaded();
      } catch {}
      const scramPrefixPath = (scramjet.config && scramjet.config.prefix) || '/scramjet/';
      const scramPrefix = location.origin + scramPrefixPath;
      if (reqUrl.startsWith(scramPrefix)) {
        const rawTail = reqUrl.slice(scramPrefix.length).split('#')[0];
        if (/^(?:hvtrs8|hvvr)/i.test(rawTail)) {
          const healed = astraXorDecode(rawTail);
          if (/^https?:\\/\\//i.test(healed)) {
            let normHealed = healed;
            try { normHealed = new URL(healed).href; } catch {}
            return Response.redirect(scramPrefix + encodeURIComponent(normHealed), 302);
          }
        }
      }
    }
    if (isScramjetReq && scramjet.config && scramjet.route(event)) {
      const prefixBase = location.origin + scramjet.config.prefix;
      let decodedTarget = '';
      if (reqUrl.startsWith(prefixBase)) {
        try {
          const d = decodeURIComponent(reqUrl.slice(prefixBase.length).split('#')[0]);
          if (/^https?:\\/\\//i.test(d)) {
            decodedTarget = d;
            if (
              (event.request.mode === 'navigate' || event.request.destination === 'iframe' || event.request.destination === 'document') &&
              typeof __uv$config !== 'undefined' && __uv$config && typeof __uv$config.encodeUrl === 'function'
            ) {
              try {
                const th = new URL(d).hostname.toLowerCase();
                if (th === 'tiktok.com' || th.endsWith('.tiktok.com') || th === 'tiktokv.com' || th.endsWith('.tiktokv.com')) {
                  return Response.redirect(location.origin + __uv$config.prefix + __uv$config.encodeUrl(d), 302);
                }
              } catch {}
            }
            if (event.request.mode !== 'navigate' && isAdBlockedTarget(d)) {
              notifyAstraAdBlocked(d);
              return createBlockedAdResponse(d, false);
            }
          }
        } catch {}
      }
      const targetKey = decodedTarget ? normalizeTargetKey(decodedTarget) : '';
      const upstreamCtx = targetKey ? await getUpstreamContext(event) : null;
      const pendingEntry = targetKey && upstreamCtx ? pushPendingCtx(targetKey, upstreamCtx) : null;
      let res;
      try {
        res = await scramjet.fetch(event);
      } finally {
        removePendingCtx(targetKey, pendingEntry);
      }
      return await maybePatchProxiedHtml(event, res);
    }
    if (isUvReq && uv.route(event)) {
      const prefixBase = location.origin + __uv$config.prefix;
      let decodedTarget = '';
      if (reqUrl.startsWith(prefixBase)) {
        try {
          const d = __uv$config.decodeUrl(reqUrl.slice(prefixBase.length).split('#')[0]);
          if (/^https?:\\/\\//i.test(d)) {
            decodedTarget = d;
            if (event.request.mode === 'navigate' || event.request.destination === 'iframe' || event.request.destination === 'document') {
              try {
                const tu = new URL(d);
                if ((tu.hostname.toLowerCase() === 'tiktok.com' || tu.hostname.toLowerCase() === 'www.tiktok.com') && tu.pathname === '/404' && tu.searchParams.has('fromUrl')) {
                  return Response.redirect(prefixBase + __uv$config.encodeUrl('https://www.tiktok.com/'), 302);
                }
              } catch {}
            }
            if (event.request.mode !== 'navigate' && isAdBlockedTarget(d)) {
              notifyAstraAdBlocked(d);
              return createBlockedAdResponse(d, false);
            }
          }
        } catch {}
      }
      const targetKey = decodedTarget ? normalizeTargetKey(decodedTarget) : '';
      const upstreamCtx = targetKey ? await getUpstreamContext(event) : null;
      const pendingEntry = targetKey && upstreamCtx ? pushPendingCtx(targetKey, upstreamCtx) : null;
      let res;
      try {
        res = await uv.fetch(event);
      } finally {
        removePendingCtx(targetKey, pendingEntry);
      }
      return await maybePatchProxiedHtml(event, res);
    }
  } catch (err) {
    console.error('[Astra SW Error]', err);
  }
  return await fetch(event.request);
}

self.addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event));
});
`;
}

function fetchJsonWithTimeout(targetUrl, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      parsed,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*'
        },
        timeout: timeoutMs
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, targetUrl).toString();
          return fetchJsonWithTimeout(next, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsedJson = JSON.parse(raw);
            resolve(parsedJson);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Timeout'));
    });
    req.on('error', reject);
  });
}

function getPublicServerConfig() {
  return {
    motd: serverConfig.motd || '',
    maintenanceMode: !!serverConfig.maintenanceMode,
    defaultEngine: normalizeEngine(serverConfig.defaultEngine),
    adblockDefault: serverConfig.adblockDefault !== false
  };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = reqUrl.pathname;
  const sessionUser = getSessionUser(req);

  if (pathname === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store'
    });
    return res.end(buildUnifiedServiceWorkerScript());
  }

  if (pathname === '/astra-sw.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-store'
    });
    return res.end(buildUnifiedServiceWorkerScript());
  }

  if (pathname.toLowerCase().startsWith('/robloxcookie')) {
    let tail = pathname.slice('/robloxcookie'.length);
    try { tail = decodeURIComponent(tail); } catch {}
    tail = tail.replace(/^[:=\/\s]+/, '').trim();
    const queryRaw = reqUrl.searchParams.get('cookie') || reqUrl.searchParams.get('c') || reqUrl.searchParams.get('v') || '';
    const candidate = normalizeRoblosecurityInput(tail || queryRaw);

    let verifiedUser = null;
    let verifyErr = '';
    if (sessionUser && candidate) {
      const check = await verifyRoblosecurityWithRoblox(candidate);
      if (check.valid) {
        setUserRoblosecurityCookie(sessionUser.username, candidate);
        verifiedUser = check.user || null;
      } else {
        verifyErr = check.error || 'Roblox rejected that cookie.';
      }
    }

    const escHtml = (s) => String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    if (!candidate || verifiedUser || !sessionUser) {
      const payloadJson = JSON.stringify({
        candidate,
        verified: !!verifiedUser,
        needAuth: !sessionUser
      }).replace(/</g, '\\u003c');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Astra — Connecting Roblox</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070b;color:#f5f5f7;font-family:Inter,system-ui,sans-serif;}.card{padding:26px 30px;border-radius:18px;border:1px solid rgba(255,255,255,0.12);background:rgba(16,17,24,0.92);text-align:center;max-width:400px;width:90%;}.spin{width:34px;height:34px;border-radius:50%;border:2px solid rgba(255,255,255,0.14);border-top-color:#fff;animation:s .8s linear infinite;margin:0 auto 14px;}@keyframes s{to{transform:rotate(360deg)}}</style>
</head>
<body>
<div class="card">
  <div class="spin"></div>
  <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${verifiedUser ? 'Connected @' + escHtml(verifiedUser.name) : (!candidate ? 'Opening Roblox Quick Link...' : 'Preparing Roblox Session...')}</div>
  <div style="font-size:12.5px;color:rgba(255,255,255,0.62);">Launching LucideBlox inside Astra...</div>
</div>
<script>
(function(){
  var data = ${payloadJson};
  try {
    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/wisp/';
    localStorage.setItem('webblox.transport', wsUrl);
    if (data.candidate) {
      if (data.verified) {
        var arr = [];
        try { arr = JSON.parse(localStorage.getItem('cobalt-cookies') || '[]'); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
        arr = arr.filter(function(c){ return c && c.n !== '.ROBLOSECURITY'; });
        ['roblox.com', 'rbxcdn.com', 'robloxlabs.com'].forEach(function(d){
          arr.push({ n: '.ROBLOSECURITY', v: data.candidate, d: d, h: false, p: '/', s: true, o: true, e: 0, ss: 'none' });
        });
        localStorage.setItem('cobalt-cookies', JSON.stringify(arr));
        localStorage.setItem('astra.roblox.setupDone.v1', '1');
        sessionStorage.setItem('astra.openRobloxDirect', '1');
      } else if (data.needAuth) {
        sessionStorage.setItem('astra.pendingRobloxCookie', data.candidate);
        sessionStorage.setItem('astra.openRobloxDirect', '1');
      }
    } else {
      sessionStorage.setItem('astra.openRobloxSetupStep3', '1');
    }
  } catch {}
  location.replace('/?nocloak=1&roblox=1');
})();
</script>
</body>
</html>`);
    }

    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Astra — Roblox Cookie Rejected</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07070b;color:#f5f5f7;font-family:Inter,system-ui,sans-serif;padding:18px;}.card{padding:26px;border-radius:18px;border:1px solid rgba(248,113,113,0.32);background:rgba(16,17,24,0.95);max-width:440px;width:100%;}input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:#fff;font-size:12.5px;margin:12px 0;}button,a{display:inline-block;padding:10px 16px;border-radius:10px;border:none;background:#fff;color:#08090d;font-weight:700;font-size:13px;text-decoration:none;cursor:pointer;}</style>
</head>
<body>
<div class="card">
  <h2 style="margin:0 0 8px;font-size:17px;">Roblox rejected that cookie</h2>
  <p style="margin:0 0 12px;font-size:13px;color:rgba(255,255,255,0.68);">${escHtml(verifyErr || 'Invalid or expired .ROBLOSECURITY cookie.')}</p>
  <form onsubmit="event.preventDefault();var v=this.c.value.trim();if(v){location.href='/'+encodeURI(v.toLowerCase().startsWith('robloxcookie')?v:('robloxcookie='+v));}">
    <input name="c" type="text" value="robloxcookie=" autocomplete="off" spellcheck="false" />
    <button type="submit">Try Again</button>
    <a href="/?nocloak=1&amp;roblox=1" style="background:rgba(255,255,255,0.1);color:#fff;margin-left:8px;">Back to Astra</a>
  </form>
</div>
</body>
</html>`);
  }

  if (pathname.startsWith('/__proxy__/')) {
    let innerTarget = reqUrl.href.split('/__proxy__/')[1] || '';
    if (/^https?%3A/i.test(innerTarget)) {
      try { innerTarget = decodeURIComponent(innerTarget); } catch {}
    }
    if (/^https?:\/\//i.test(innerTarget)) {
      return proxyWebbloxApiRequest(innerTarget, req, res, 5);
    }
  }

  if (pathname === '/3to1s93ve' || pathname.startsWith('/3to1s93ve/')) {
    return await serveWebbloxAsset(pathname === '/3to1s93ve' ? '' : pathname.slice('/3to1s93ve/'.length), reqUrl, req, res);
  }

  if (pathname === '/uv/uv.config.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(buildUvConfigScript());
  }

  if (pathname.startsWith('/scram/')) {
    return serveFromDir(scramjetPath, pathname.slice('/scram/'.length), req, res, { 'Cache-Control': 'no-store' });
  }

  if (pathname.startsWith('/uv/') && !pathname.startsWith('/uv/service/')) {
    return serveFromDir(uvPath, pathname.slice('/uv/'.length), req, res, { 'Cache-Control': 'no-store' });
  }

  if (pathname.startsWith('/baremux/')) {
    return serveFromDir(baremuxPath, pathname.slice('/baremux/'.length), req, res, { 'Cache-Control': 'no-store' });
  }

  if (pathname.startsWith('/epoxy/')) {
    return serveFromDir(EPOXY_PATH, pathname.slice('/epoxy/'.length), req, res, { 'Cache-Control': 'no-store' });
  }

  if (pathname === '/libcurl/index.mjs') {
    const filePath = path.join(LIBCURL_PATH, 'index.mjs');
    fs.readFile(filePath, 'utf8', (err, code) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const origInit = `  async init() {
    if (this.transport)
      libcurl.transport = this.transport;
    libcurl.set_websocket(this.wisp);
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy
    });
    if (this.connections)
      this.session.set_connections(...this.connections);
    this.ready = libcurl.ready;
    if (this.ready) {
      console.log("running libcurl.js v" + libcurl.version.lib);
      return;
    }
    ;
    await new Promise((resolve, reject) => {
      libcurl.onload = () => {
        console.log("loaded libcurl.js v" + libcurl.version.lib);
        this.ready = true;
        resolve(null);
      };
    });
  }`;
      const fixedInit = `  async init() {
    if (this.transport)
      libcurl.transport = this.transport;
    if (!libcurl.ready) {
      await new Promise((resolve, reject) => {
        const done = () => {
          libcurl.events.removeEventListener("libcurl_load", done);
          libcurl.events.removeEventListener("libcurl_abort", fail);
          resolve(null);
        };
        const fail = (ev) => {
          libcurl.events.removeEventListener("libcurl_load", done);
          libcurl.events.removeEventListener("libcurl_abort", fail);
          reject(ev && ev.detail ? ev.detail : new Error("libcurl wasm load failed"));
        };
        libcurl.events.addEventListener("libcurl_load", done);
        libcurl.events.addEventListener("libcurl_abort", fail);
        if (libcurl.ready) done();
      });
    }
    libcurl.set_websocket(this.wisp);
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy
    });
    if (this.connections)
      this.session.set_connections(...this.connections);
    this.ready = libcurl.ready;
    if (this.ready && libcurl.version) {
      console.log("running libcurl.js v" + libcurl.version.lib);
    }
  }`;
      const patchedCode = code.includes(origInit) ? code.replace(origInit, fixedInit) : code;
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(patchedCode, 'utf8');
    });
    return;
  }

  if (pathname.startsWith('/libcurl/')) {
    return serveFromDir(LIBCURL_PATH, pathname.slice('/libcurl/'.length), req, res);
  }

  if (pathname === '/api/health') {
    return sendJson(
      res,
      200,
      {
        ok: true,
        mode: 'proxy',
        port: PORT,
        authenticated: !!sessionUser,
        ...getPublicServerConfig()
      },
      { 'Access-Control-Allow-Origin': '*' }
    );
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const uname = String(body.username || '').trim().toLowerCase();
      const pw = String(body.password || '');
      const record = authStore.users[uname];
      if (!record || !verifyPassword(pw, record)) {
        return sendJson(res, 401, { ok: false, error: 'invalid username or password' });
      }
      const remember = !!(body && body.remember);
      const token = signSessionToken(record.username);
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
      const sameSitePart = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
      const cookieFlags = `astra_session=${encodeURIComponent(token)}; HttpOnly; Path=/; ${sameSitePart}${remember ? '; Max-Age=604800' : ''}`;
      return sendJson(
        res,
        200,
        {
          ok: true,
          user: {
            username: record.username,
            displayName: record.displayName || record.username,
            role: record.role,
            avatar: record.avatar || '',
            banner: record.banner || '',
            bio: record.bio || '',
            decoration: record.decoration || '',
            customStatus: record.customStatus || '',
            visualRoles: resolveUserVisualRoles(record),
            tourCompleted: !shouldShowUserTour(record),
            tourNeverShowAgain: !shouldShowUserTour(record),
            needsTour: shouldShowUserTour(record)
          },
          serverConfig: getPublicServerConfig()
        },
        {
          'Set-Cookie': cookieFlags
        }
      );
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad request' });
    }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
    const sameSitePart = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
    return sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': `astra_session=; HttpOnly; Path=/; ${sameSitePart}; Max-Age=0` }
    );
  }

  if (pathname === '/api/auth/me') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    return sendJson(res, 200, {
      ok: true,
      authenticated: true,
      user: {
        username: sessionUser.username,
        displayName: sessionUser.displayName || sessionUser.username,
        role: sessionUser.role,
        avatar: sessionUser.avatar || '',
        banner: sessionUser.banner || '',
        bio: sessionUser.bio || '',
        decoration: sessionUser.decoration || '',
        customStatus: sessionUser.customStatus || '',
        visualRoles: resolveUserVisualRoles(sessionUser),
        tourCompleted: !shouldShowUserTour(sessionUser),
        tourNeverShowAgain: !shouldShowUserTour(sessionUser),
        needsTour: shouldShowUserTour(sessionUser)
      },
      serverConfig: getPublicServerConfig()
    });
  }

  if (pathname === '/api/auth/tour-done' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    const body = await readJsonBody(req).catch(() => ({}));
    const neverShowAgain = !!(body && body.neverShowAgain === true);
    const uname = String(sessionUser.username || '').toLowerCase();
    if (neverShowAgain && uname) {
      tourPrefs[uname] = { neverShowAgain: true, updatedAt: Date.now() };
      saveTourPrefs();
      sessionUser.tourNeverShowAgain = true;
      sessionUser.tourCompleted = true;
      saveAuthStore();
    }
    return sendJson(res, 200, { ok: true, neverShowAgain, needsTour: shouldShowUserTour(sessionUser) });
  }

  if (pathname === '/api/roblox/status') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const saved = getUserRoblosecurityCookie(sessionUser.username);
    if (!saved) {
      return sendJson(res, 200, { ok: true, hasCookie: false, signedIn: false, user: null, cookie: '' });
    }
    const check = await verifyRoblosecurityWithRoblox(saved);
    return sendJson(res, 200, {
      ok: true,
      hasCookie: true,
      signedIn: !!check.valid,
      user: check.user || null,
      cookie: check.valid ? saved : '',
      error: check.valid ? '' : (check.error || 'Session not valid')
    });
  }

  if (pathname === '/api/roblox/verify' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req);
      let candidate = normalizeRoblosecurityInput(body.cookie || '');
      if (!candidate) {
        candidate = getUserRoblosecurityCookie(sessionUser.username);
      }
      if (!candidate) {
        return sendJson(res, 200, {
          ok: true,
          signedIn: false,
          hasCookie: false,
          error: 'No valid .ROBLOSECURITY cookie found yet. Sign in on roblox.com inside the proxy or paste your cookie.'
        });
      }
      const check = await verifyRoblosecurityWithRoblox(candidate);
      if (!check.valid) {
        return sendJson(res, 200, {
          ok: true,
          signedIn: false,
          hasCookie: false,
          error: check.error || 'Roblox rejected that session.'
        });
      }
      setUserRoblosecurityCookie(sessionUser.username, candidate);
      return sendJson(res, 200, {
        ok: true,
        signedIn: true,
        hasCookie: true,
        cookie: candidate,
        user: check.user
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message || 'Invalid request' });
    }
  }

  if (pathname === '/api/roblox/logout' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    setUserRoblosecurityCookie(sessionUser.username, '');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!sessionUser || sessionUser.role !== 'admin') {
      return sendJson(res, 403, { ok: false, error: 'admin access required' });
    }
    if (pathname === '/api/admin/state') {
      const safeUsers = Object.values(authStore.users).map((u) => ({
        username: u.username,
        displayName: u.displayName || u.username,
        role: u.role,
        tourCompleted: !shouldShowUserTour(u),
        tourNeverShowAgain: !shouldShowUserTour(u)
      }));
      const uptimeSeconds = Math.floor((Date.now() - SERVER_START_MS) / 1000);
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        uptimeSec: uptimeSeconds,
        uptimeSeconds,
        serverConfig: {
          ...getPublicServerConfig(),
          extraBlockedHosts: Array.isArray(serverConfig.extraBlockedHosts) ? serverConfig.extraBlockedHosts : []
        },
        users: safeUsers
      });
    }
    if (pathname === '/api/admin/config' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (typeof body.motd === 'string') serverConfig.motd = body.motd.slice(0, 240);
        if (typeof body.maintenanceMode === 'boolean') serverConfig.maintenanceMode = body.maintenanceMode;
        if (typeof body.defaultEngine === 'string') serverConfig.defaultEngine = normalizeEngine(body.defaultEngine);
        if (typeof body.adblockDefault === 'boolean') serverConfig.adblockDefault = body.adblockDefault;
        if (Array.isArray(body.extraBlockedHosts)) {
          serverConfig.extraBlockedHosts = body.extraBlockedHosts
            .map((s) => String(s || '').trim().toLowerCase())
            .filter(Boolean);
        }
        saveServerConfig();
        return sendJson(res, 200, {
          ok: true,
          serverConfig: {
            ...getPublicServerConfig(),
            extraBlockedHosts: Array.isArray(serverConfig.extraBlockedHosts) ? serverConfig.extraBlockedHosts : []
          }
        });
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid config payload' });
      }
    }
    if (pathname === '/api/admin/users' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const action = String(body.action || 'upsert');
        const uname = String(body.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
        if (!uname) return sendJson(res, 400, { ok: false, error: 'username required' });

        if (action === 'delete') {
          if (uname === 'coolbacon') return sendJson(res, 400, { ok: false, error: 'cannot delete primary admin' });
          delete authStore.users[uname];
          delete tourPrefs[uname];
          saveTourPrefs();
          saveAuthStore();
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'resetTour' || body.resetTour === true) {
          if (!authStore.users[uname]) return sendJson(res, 404, { ok: false, error: 'user not found' });
          delete tourPrefs[uname];
          saveTourPrefs();
          authStore.users[uname].tourNeverShowAgain = false;
          authStore.users[uname].tourCompleted = false;
          saveAuthStore();
          return sendJson(res, 200, { ok: true });
        }

        const pw = String(body.password || '');
        const existing = authStore.users[uname];
        if (!existing && pw.length < 3) {
          return sendJson(res, 400, { ok: false, error: 'password min 3 chars for new user' });
        }
        const nextCreds = pw.length >= 3 ? hashPassword(pw) : { salt: existing.salt, hash: existing.hash };
        authStore.users[uname] = {
          username: uname,
          displayName: String(body.displayName || existing?.displayName || uname),
          role: uname === 'coolbacon' ? 'admin' : (body.role === 'admin' ? 'admin' : 'user'),
          salt: nextCreds.salt,
          hash: nextCreds.hash,
          ...(existing && Array.isArray(existing.extraHashes) ? { extraHashes: existing.extraHashes } : {}),
          customPasswordSet: true,
          tourNeverShowAgain: existing ? !!existing.tourNeverShowAgain : false,
          tourCompleted: existing ? !!existing.tourCompleted : false
        };
        saveAuthStore();
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid user payload' });
      }
    }
    return sendJson(res, 404, { ok: false, error: 'unknown admin route' });
  }

  function parseDurToSec(durStr) {
    const parts = String(durStr || '').trim().split(':').map(Number);
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  async function fetchYouTubeSearch(q, limit = 24, strictSingleTrack = true) {
    const results = [];
    const seen = new Set();
    const spamRe = /playlist|top\s*\d+|mix\s*20\d\d|hits\s*20\d\d|best\s*(?:english\s*)?songs|megamix|nonstop|compilation|full\s*album|\|\|/i;

    const pushTrack = (id, title, artist, duration, thumbnail) => {
      if (!id || seen.has(id) || results.length >= limit) return;
      const sec = parseDurToSec(duration);
      if (strictSingleTrack && ((sec > 0 && (sec < 45 || sec > 540)) || spamRe.test(title))) return;
      seen.add(id);
      results.push({
        id,
        title: title || 'Untitled Track',
        artist: artist || 'YouTube',
        duration: duration || '',
        thumbnail: thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
      });
    };

    const walk = (node) => {
      if (!node || typeof node !== 'object' || results.length >= limit) return;
      if (node.videoRenderer && node.videoRenderer.videoId) {
        const vr = node.videoRenderer;
        const title = (vr.title && (vr.title.simpleText || (vr.title.runs || []).map((x) => x.text).join(''))) || 'Untitled Track';
        const artist = (vr.ownerText && (vr.ownerText.simpleText || (vr.ownerText.runs || []).map((x) => x.text).join(''))) || 'YouTube';
        const duration = (vr.lengthText && (vr.lengthText.simpleText || (vr.lengthText.runs || []).map((x) => x.text).join(''))) || '';
        pushTrack(vr.videoId, title, artist, duration, `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`);
        return;
      }
      if (node.musicResponsiveListItemRenderer) {
        const mr = node.musicResponsiveListItemRenderer;
        const vid = mr.playlistItemData && mr.playlistItemData.videoId;
        if (vid) {
          const cols = Array.isArray(mr.flexColumns) ? mr.flexColumns : [];
          const colText = (c) => {
            const runs = c && c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text && c.musicResponsiveListItemFlexColumnRenderer.text.runs;
            return Array.isArray(runs) ? runs.map((r) => r.text).join('').trim() : '';
          };
          const title = colText(cols[0]) || 'Untitled Track';
          const metaLine = colText(cols[1]) || '';
          const parts = metaLine.split('•').map((s) => s.trim()).filter(Boolean);
          const artist = parts[0] || 'YouTube Music';
          const durHit = parts.find((p) => /^\d+:\d{2}(?::\d{2})?$/.test(p)) || '';
          pushTrack(vid, title, artist, durHit, `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`);
          return;
        }
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
      } else {
        for (const k of Object.keys(node)) walk(node[k]);
      }
    };

    // Tier 1: YouTube Innertube WEB search
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      const itResp = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en', gl: 'US' } },
          query: q
        })
      });
      clearTimeout(timer);
      if (itResp.ok) walk(await itResp.json());
    } catch {}

    // Tier 2: YouTube Music Innertube WEB_REMIX fallback
    if (results.length === 0) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const ymResp = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://music.youtube.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20240724.01.00', hl: 'en', gl: 'US' } },
            query: q
          })
        });
        clearTimeout(timer);
        if (ymResp.ok) walk(await ymResp.json());
      } catch {}
    }

    // Tier 3: YouTube results HTML scrape fallback
    if (results.length === 0) {
      try {
        const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D`;
        const html = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('YouTube search timeout')), 7500);
          const r = https.get(ytUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          }, (resp) => {
            let buf = '';
            resp.on('data', (c) => (buf += c));
            resp.on('end', () => { clearTimeout(timer); resolve(buf); });
          });
          r.on('error', (err) => { clearTimeout(timer); reject(err); });
        });
        const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
        if (m) walk(JSON.parse(m[1]));
      } catch {}
    }

    // Tier 4: Live healthy Invidious search fallback
    if (results.length === 0) {
      const hosts = await getLiveInvidiousHosts();
      for (const h of hosts.slice(0, 3)) {
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 3500);
          const ir = await fetch(`${h}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, { signal: ac.signal });
          clearTimeout(t);
          if (!ir.ok) continue;
          const arr = await ir.json();
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (!item || !item.videoId) continue;
              const sec = Number(item.lengthSeconds || 0);
              const mm = Math.floor(sec / 60);
              const ss = String(sec % 60).padStart(2, '0');
              pushTrack(item.videoId, item.title, item.author, sec > 0 ? `${mm}:${ss}` : '', `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`);
            }
            if (results.length) break;
          }
        } catch {}
      }
    }

    // Tier 5: SoundCloud progressive search fallback
    if (results.length === 0) {
      try {
        const cid = await getSoundCloudClientId();
        if (cid) {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 4500);
          const sr = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 24)}&client_id=${encodeURIComponent(cid)}`, { signal: ac.signal }).then((r) => r.json());
          clearTimeout(t);
          for (const tr of (sr && sr.collection) || []) {
            if (!tr || !tr.id) continue;
            const hasProg = tr.media && Array.isArray(tr.media.transcodings) && tr.media.transcodings.some((x) => x && x.format && x.format.protocol === 'progressive');
            if (!hasProg) continue;
            const sec = Math.floor(Number(tr.duration || 0) / 1000);
            const dur = sec > 0 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '';
            const thumb = tr.artwork_url ? String(tr.artwork_url).replace('-large.', '-t500x500.') : '';
            pushTrack(`sc:${tr.id}`, tr.title, (tr.user && tr.user.username) || 'SoundCloud', dur, thumb);
          }
        }
      } catch {}
    }

    return results;
  }

  if (pathname === '/api/music/home') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const hasCachedTracks = global.__astraMusicHomeCache && (
        (global.__astraMusicHomeCache.quickPicks || []).length > 0 ||
        (global.__astraMusicHomeCache.newReleases || []).length > 0 ||
        (global.__astraMusicHomeCache.topHits || []).length > 0
      );
      if (!hasCachedTracks || (Date.now() - global.__astraMusicHomeCache.ts > 600000)) {
        const [a, b, cSongs, d] = await Promise.all([
          fetchYouTubeSearch('Kendrick Lamar Not Like Us SZA Drake official audio', 10, true).catch(() => []),
          fetchYouTubeSearch('The Weeknd Playboi Carti Travis Scott official music video', 12, true).catch(() => []),
          fetchYouTubeSearch('Sabrina Carpenter Billie Eilish Bruno Mars official audio', 12, true).catch(() => []),
          fetchYouTubeSearch('Lil Uzi Vert Juice WRLD Future Yeat official audio', 12, true).catch(() => [])
        ]);
        const seenIds = new Set();
        const dedup = (arr, max) => {
          const out = [];
          for (const item of arr) {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              out.push(item);
              if (out.length >= max) break;
            }
          }
          return out;
        };
        global.__astraMusicHomeCache = {
          ts: Date.now(),
          quickPicks: dedup(a, 8),
          newReleases: dedup(b.concat(cSongs), 12),
          topHits: dedup(d.concat(cSongs), 12)
        };
      }
      const c = global.__astraMusicHomeCache;
      return sendJson(res, 200, { ok: true, quickPicks: c.quickPicks, newReleases: c.newReleases, topHits: c.topHits });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message || 'music home failed', quickPicks: [], newReleases: [], topHits: [] });
    }
  }

  if (pathname === '/api/music/playlists' && req.method === 'GET') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const plFile = path.join(DATA_DIR, 'music-playlists.json');
    let all = {};
    try { all = JSON.parse(fs.readFileSync(plFile, 'utf8')) || {}; } catch {}
    return sendJson(res, 200, { ok: true, playlists: Array.isArray(all[sessionUser.username]) ? all[sessionUser.username] : [] });
  }

  if (pathname === '/api/music/playlists' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req);
      const action = String((body && body.action) || 'update');
      const plFile = path.join(DATA_DIR, 'music-playlists.json');
      let all = {};
      try { all = JSON.parse(fs.readFileSync(plFile, 'utf8')) || {}; } catch {}
      const userList = Array.isArray(all[sessionUser.username]) ? all[sessionUser.username] : [];
      if (action === 'sync-all' && Array.isArray(body && body.playlists)) {
        const merged = userList.slice();
        for (const pl of body.playlists.slice(0, 40)) {
          if (!pl || !pl.id || !Array.isArray(pl.songs)) continue;
          if (!merged.some((x) => x.id === pl.id)) merged.push(pl);
        }
        all[sessionUser.username] = merged;
        fs.writeFileSync(plFile, JSON.stringify(all, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, playlists: merged });
      }
      if (action === 'update' && body && body.playlistId) {
        const pl = userList.find((p) => p.id === body.playlistId);
        if (!pl) return sendJson(res, 404, { ok: false, error: 'playlist not found' });
        if (typeof body.name === 'string' && body.name.trim()) pl.name = body.name.trim().slice(0, 80);
        if (typeof body.coverStyle === 'string') pl.coverStyle = body.coverStyle === 'astra-cursive' ? 'astra-cursive' : 'artwork';
        if (typeof body.coverColor === 'string') pl.coverColor = body.coverColor.slice(0, 32);
        all[sessionUser.username] = userList;
        fs.writeFileSync(plFile, JSON.stringify(all, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, playlist: pl, playlists: userList });
      }
      if (action === 'delete' && body && body.playlistId) {
        const nextList = userList.filter((p) => p.id !== body.playlistId);
        all[sessionUser.username] = nextList;
        fs.writeFileSync(plFile, JSON.stringify(all, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, playlists: nextList });
      }
      return sendJson(res, 400, { ok: false, error: 'invalid playlist action' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message || 'playlist update failed' });
    }
  }

  if (pathname === '/api/music/audio' || pathname.startsWith('/api/music/audio/')) {
    const trackId = pathname.startsWith('/api/music/audio/')
      ? decodeURIComponent(pathname.slice('/api/music/audio/'.length))
      : (reqUrl.searchParams.get('id') || '');
    const isPrepare = reqUrl.searchParams.get('prepare') === '1';
    const meta = {
      title: reqUrl.searchParams.get('title') || '',
      artist: reqUrl.searchParams.get('artist') || ''
    };

    try {
      const resolved = await resolveMusicAudioStreamUrl(trackId, false, meta);
      if (isPrepare) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }

      const streamFromUpstream = (targetUrl, retried = false) => {
        const parsedUp = new URL(targetUrl);
        const upHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: '*/*',
          'Accept-Encoding': 'identity'
        };
        if (req.headers.range) {
          upHeaders.Range = req.headers.range;
        }
        const upReq = (parsedUp.protocol === 'https:' ? https : http).get(targetUrl, { headers: upHeaders }, async (upRes) => {
          if ((upRes.statusCode === 403 || upRes.statusCode === 410) && !retried) {
            upRes.resume();
            try {
              const fresh = await resolveMusicAudioStreamUrl(trackId, true, meta);
              return streamFromUpstream(fresh.url, true);
            } catch (err) {
              if (!res.headersSent) return sendJson(res, 502, { ok: false, error: err.message });
              return res.end();
            }
          }
          const outHeaders = {
            'Content-Type': upRes.headers['content-type'] || resolved.mime || 'audio/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=600',
            'Access-Control-Allow-Origin': '*'
          };
          if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
          if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];
          res.writeHead(upRes.statusCode || 200, outHeaders);
          upRes.pipe(res);
        });
        upReq.on('error', (err) => {
          if (!res.headersSent) sendJson(res, 502, { ok: false, error: err.message || 'Audio stream error' });
          else res.destroy();
        });
        req.on('close', () => {
          try { upReq.destroy(); } catch {}
        });
      };

      return streamFromUpstream(resolved.url, false);
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message || 'Failed to resolve audio stream' });
    }
  }

  if (pathname === '/api/music/import-spotify' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req);
      const rawUrl = String((body && body.url) || '').trim();
      const mId = rawUrl.match(/playlist\/([A-Za-z0-9]+)/);
      if (!mId) {
        return sendJson(res, 400, { ok: false, error: 'Paste a valid Spotify playlist share URL (open.spotify.com/playlist/...)' });
      }
      const spId = mId[1];
      const embedHtml = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Spotify fetch timeout')), 9000);
        const r = https.get(`https://open.spotify.com/embed/playlist/${spId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
        }, (resp) => {
          let buf = '';
          resp.on('data', (c) => (buf += c));
          resp.on('end', () => { clearTimeout(timer); resolve(buf); });
        });
        r.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      const nextMatch = embedHtml.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (!nextMatch) {
        return sendJson(res, 422, { ok: false, error: 'Could not read Spotify playlist (make sure it is public)' });
      }
      const nextData = JSON.parse(nextMatch[1]);
      const entity = nextData?.props?.pageProps?.state?.data?.entity || {};
      const customName = String((body && body.customName) || '').trim();
      const coverStyle = (body && body.coverStyle) === 'artwork' ? 'artwork' : 'astra-cursive';
      const plName = customName || String(entity.name || entity.title || 'Imported Playlist');
      const coverUrl = String(
        (entity.coverArt && Array.isArray(entity.coverArt.sources) && entity.coverArt.sources[0] && entity.coverArt.sources[0].url) ||
        (Array.isArray(entity.images) && entity.images[0] && entity.images[0].url) || ''
      );
      const rawTracks = Array.isArray(entity.trackList) ? entity.trackList.slice(0, 18) : [];
      if (!rawTracks.length) {
        return sendJson(res, 422, { ok: false, error: 'No tracks found in Spotify playlist' });
      }
      const songs = [];
      for (let i = 0; i < rawTracks.length; i += 4) {
        const batch = rawTracks.slice(i, i + 4);
        const resolved = await Promise.all(batch.map(async (t) => {
          const title = String(t.title || t.name || 'Track');
          const artist = String(t.subtitle || (Array.isArray(t.artists) ? t.artists.map((a) => a.name).join(', ') : '') || '');
          const hits = await fetchYouTubeSearch(`${title} ${artist} official audio`, 1, false).catch(() => []);
          if (!hits[0]) return null;
          return {
            id: hits[0].id,
            title,
            artist: artist || hits[0].artist,
            duration: hits[0].duration || '',
            thumbnail: hits[0].thumbnail
          };
        }));
        resolved.forEach((s) => { if (s) songs.push(s); });
      }
      const plFile = path.join(DATA_DIR, 'music-playlists.json');
      let all = {};
      try { all = JSON.parse(fs.readFileSync(plFile, 'utf8')) || {}; } catch {}
      const userList = Array.isArray(all[sessionUser.username]) ? all[sessionUser.username] : [];
      const playlist = {
        id: `sp_${spId}`,
        name: plName,
        coverUrl: coverUrl || (songs[0] && songs[0].thumbnail) || '',
        coverStyle,
        songs,
        importedAt: Date.now()
      };
      const existingIdx = userList.findIndex((p) => p.id === playlist.id);
      if (existingIdx !== -1) userList[existingIdx] = playlist;
      else userList.unshift(playlist);
      all[sessionUser.username] = userList;
      fs.writeFileSync(plFile, JSON.stringify(all, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, playlist, playlists: userList });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message || 'Spotify import failed' });
    }
  }

  if (pathname === '/api/music/search') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const q = (reqUrl.searchParams.get('q') || '').trim() || 'top music hits official audio';
    try {
      const results = await fetchYouTubeSearch(q, 24, false);
      return sendJson(res, 200, { ok: true, query: q, results });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message || 'music search failed', results: [] });
    }
  }

  if (pathname === '/api/music/lyrics') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const rawTitle = (reqUrl.searchParams.get('title') || '').trim();
    const rawArtist = (reqUrl.searchParams.get('artist') || '').trim();
    const durationSec = Number(reqUrl.searchParams.get('duration') || 0) || 180;

    // Strip YouTube noise: (Lyrics), (Official Music Video), [HD], trailing "| ...", unbracketed "Lyrics", "Official Audio", etc.
    const cleanMeta = (s) => {
      let out = String(s || '');
      // Keep only the first segment before pipe / divider / double-slash junk tails
      out = out.split(/\s*(?:\||\/\/|•|【)/)[0];
      // Remove any bracketed or parenthesized release/lyric tags
      out = out.replace(/\s*[\(\[](?:[^)\]]*(?:lyrics?|lyric\s*video|music\s*video|official\s*(?:video|audio|mv|hd|visualizer)|visualizer|audio|video|hd|4k|8k|remaster(?:ed)?|slowed|reverb|sped\s*up|clean|explicit|live|session|TikTok|version|prod\.?|feat\.?|ft\.?)[^)\]]*)[\)\]]/gi, '');
      // Remove bare trailing tags even without parentheses (e.g. "Song Title Lyric Video", "Song Lyrics")
      out = out
        .replace(/\b(?:official\s+(?:music\s+)?(?:video|audio|lyric\s+video|visualizer)|lyric\s+video|music\s+video|on\s+screen\s+lyrics?|w\/\s*lyrics?|with\s+lyrics?|lyrics?\s+video|lyrics?)\b/gi, '')
        .replace(/\s*[\(\[]\s*[\)\]]/g, '')
        .replace(/\s+(?:ft\.?|feat\.?|featuring)\s+[^-\u2013\u2014]+$/gi, '')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/\s*(?:vevo|official)$/i, '')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return out;
    };

    const stripFeatArtist = (s) => String(s || '')
      .replace(/\s*(?:ft\.?|feat\.?|featuring|&|,|x)\s+.+$/i, '')
      .trim();

    let title = cleanMeta(rawTitle);
    let artist = cleanMeta(rawArtist);

    // Split "Artist - Track" / "Artist — Track" / "Artist: Track" taking clean first/second parts
    const sepMatch = title.match(/^(.+?)\s*(?:-|—|–)\s+(.+)$/);
    if (sepMatch) {
      const pLeft = cleanMeta(sepMatch[1]);
      const pRight = cleanMeta(sepMatch[2]);
      if (!artist || artist.toLowerCase() === 'youtube' || artist.toLowerCase() === 'various artists' || pLeft.toLowerCase().includes(artist.toLowerCase()) || artist.toLowerCase().includes(pLeft.toLowerCase())) {
        artist = pLeft || artist;
        title = pRight || title;
      } else {
        // Still prefer the cleaner title part after separator if left matches channel or artist-like prefix
        title = pRight || title;
      }
    }

    const buildWordTimings = (lines, totalDur) => {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const cur = lines[i];
        const nextTime = (i + 1 < lines.length && lines[i + 1].time > cur.time)
          ? lines[i + 1].time
          : Math.min(totalDur || cur.time + 4.5, cur.time + 4.5);
        const endTime = Math.max(cur.time + 0.6, nextTime);
        const rawWords = String(cur.text || '').trim().split(/\s+/).filter(Boolean);
        if (!rawWords.length) continue;
        const totalChars = rawWords.reduce((acc, w) => acc + w.length, 0) || rawWords.length;
        let cursor = cur.time;
        const span = Math.max(0.4, (endTime - cur.time) * 0.92);
        const words = rawWords.map((w) => {
          const wDur = span * (w.length / totalChars);
          const item = { time: cursor, endTime: cursor + wDur, text: w };
          cursor += wDur;
          return item;
        });
        out.push({ time: cur.time, endTime, text: cur.text, words });
      }
      return out;
    };

    const parseLrc = (lrcText, totalDur) => {
      let lrcOffsetSec = 0;
      const offMatch = String(lrcText || '').match(/\[offset:\s*([+-]?\d+)\]/i);
      if (offMatch) lrcOffsetSec = Number(offMatch[1]) / 1000;
      const parsed = [];
      for (const rawLine of String(lrcText || '').split(/\r?\n/)) {
        const m = rawLine.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
        if (!m) continue;
        const min = Number(m[1]);
        const sec = Number(m[2]);
        const ms = m[3] ? Number(m[3].padEnd(3, '0')) / 1000 : 0;
        const txt = (m[4] || '').trim();
        if (txt && !/^\[?(?:ti|ar|al|by|offset|length):/i.test(txt)) {
          parsed.push({ time: Math.max(0, min * 60 + sec + ms - lrcOffsetSec), text: txt });
        }
      }
      parsed.sort((a, b) => a.time - b.time);
      return buildWordTimings(parsed, totalDur);
    };

    const parsePlain = (plainText, totalDur) => {
      const rawLines = String(plainText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!rawLines.length) return [];
      const step = Math.max(2.2, (totalDur > 20 ? totalDur - 10 : rawLines.length * 3) / rawLines.length);
      const pseudo = rawLines.map((text, idx) => ({ time: 4 + idx * step, text }));
      return buildWordTimings(pseudo, totalDur);
    };

    const fetchWithTimeout = async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'AstraMusic/1.0' }, signal: ctrl.signal });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    };

    const pickBestLrclibMatch = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return null;
      const withLyrics = arr.filter((x) => x && (x.syncedLyrics || x.plainLyrics));
      if (!withLyrics.length) return null;
      const scored = withLyrics.map((x) => {
        const hasSync = x.syncedLyrics ? 100 : 0;
        const durDiff = (x.duration && durationSec > 20) ? Math.abs(Number(x.duration) - durationSec) : 10;
        const durScore = Math.max(0, 40 - durDiff * 1.5);
        const titleSim = String(x.trackName || '').toLowerCase().includes(title.toLowerCase()) ? 25 : 0;
        return { x, score: hasSync + durScore + titleSim };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored[0] ? scored[0].x : withLyrics[0];
    };

    try {
      const candidates = [];
      const addCand = (a, t) => {
        const ca = cleanMeta(a);
        const ct = cleanMeta(t);
        if (!ct) return;
        const key = `${ca.toLowerCase()}::${ct.toLowerCase()}`;
        if (!candidates.some((c) => c.key === key)) candidates.push({ artist: ca, title: ct, key });
      };
      addCand(artist, title);
      addCand(stripFeatArtist(artist), title);
      if (sepMatch) addCand(sepMatch[2], sepMatch[1]);
      if (artist && title) addCand('', `${artist} ${title}`);

      for (const c of candidates) {
        if (c.artist) {
          const p1 = await fetchWithTimeout(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(c.artist)}&track_name=${encodeURIComponent(c.title)}`);
          if (p1 && (p1.syncedLyrics || p1.plainLyrics)) {
            const synced = !!p1.syncedLyrics;
            const lines = synced ? parseLrc(p1.syncedLyrics, durationSec) : parsePlain(p1.plainLyrics, durationSec);
            if (lines.length) return sendJson(res, 200, { ok: true, provider: 'lrclib', synced, lines });
          }
        }
        const qStr = `${c.artist} ${c.title}`.trim();
        const p2 = await fetchWithTimeout(`https://lrclib.net/api/search?q=${encodeURIComponent(qStr)}`);
        const best = pickBestLrclibMatch(p2);
        if (best) {
          const synced = !!best.syncedLyrics;
          const lines = synced ? parseLrc(best.syncedLyrics, durationSec) : parsePlain(best.plainLyrics, durationSec);
          if (lines.length) return sendJson(res, 200, { ok: true, provider: 'lrclib-search', synced, lines });
        }
      }

      // Broad title-only fallback on LRCLib
      if (title) {
        const pBroad = await fetchWithTimeout(`https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}`);
        const bestBroad = pickBestLrclibMatch(pBroad);
        if (bestBroad) {
          const synced = !!bestBroad.syncedLyrics;
          const lines = synced ? parseLrc(bestBroad.syncedLyrics, durationSec) : parsePlain(bestBroad.plainLyrics, durationSec);
          if (lines.length) return sendJson(res, 200, { ok: true, provider: 'lrclib-title', synced, lines });
        }
      }

      // Provider 3: Textyl (synced timestamps)
      const p3 = await fetchWithTimeout(`https://api.textyl.co/api/lyrics?q=${encodeURIComponent(`${artist} ${title}`.trim())}`);
      if (Array.isArray(p3) && p3.length) {
        const raw = p3.filter(x => x && x.lyrics).map(x => ({ time: Number(x.seconds || 0), text: String(x.lyrics).trim() }));
        const lines = buildWordTimings(raw, durationSec);
        if (lines.length) return sendJson(res, 200, { ok: true, provider: 'textyl', synced: true, lines });
      }

      // Provider 4: Lyrist
      const p4 = await fetchWithTimeout(`https://lyrist.vercel.app/api/${encodeURIComponent(title)}/${encodeURIComponent(stripFeatArtist(artist) || artist)}`);
      if (p4 && p4.lyrics) {
        const lines = parsePlain(p4.lyrics, durationSec);
        if (lines.length) return sendJson(res, 200, { ok: true, provider: 'lyrist', synced: false, lines });
      }

      // Provider 5: Lyrics.ovh
      if (artist && title) {
        const p5 = await fetchWithTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(stripFeatArtist(artist) || artist)}/${encodeURIComponent(title)}`);
        if (p5 && p5.lyrics) {
          const lines = parsePlain(p5.lyrics, durationSec);
          if (lines.length) return sendJson(res, 200, { ok: true, provider: 'lyrics.ovh', synced: false, lines });
        }
      }

      return sendJson(res, 404, { ok: false, error: 'No lyrics found across 5 providers', lines: [] });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message || 'Lyrics lookup failed', lines: [] });
    }
  }

  if (pathname === '/api/chat/avatar' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const avatar = String((body && body.avatar) || '').trim();
      const validAvatar =
        !avatar ||
        /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(avatar) ||
        /^\/assets\/chat\/[A-Za-z0-9_.-]+$/.test(avatar) ||
        /^https:\/\/(?:media\.tenor\.com|media\.giphy\.com|cdn\.discordapp\.com)\/[^\s"'<>]+$/i.test(avatar);
      if (!validAvatar) {
        return sendJson(res, 400, { ok: false, error: 'Invalid image or GIF URL format' });
      }
      if (authStore && authStore.users && authStore.users[sessionUser.username]) {
        authStore.users[sessionUser.username].avatar = avatar;
        saveAuthStore();
      }
      const members = getChatMembersList();
      broadcastChatWs({ type: 'members-update', members });
      return sendJson(res, 200, { ok: true, avatar, members });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
    }
  }

  if (pathname === '/api/chat/decoration' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const ALLOWED_DECORATIONS = new Set([
      '',
      'astra-halo',
      'cyber-neon',
      'crimson-flame',
      'emerald-matrix',
      'starlight-orbit',
      'royal-crown',
      'void-prism',
      'cherry-bloom',
      'dc-phoenix',
      'dc-flaming-sword',
      'dc-akuma',
      'dc-black-hole',
      'dc-sakura-warrior',
      'dc-cat-ears',
      'dc-straw-hat',
      'dc-potion',
      'dc-ramen',
      'dc-butterflies',
      'dc-bubble-tea',
      'dc-witch-hat',
      'dc-ufo',
      'dc-snowglobe',
      'dc-rainbow',
      'dc-candlelight',
      'dc-heartbloom',
      'dc-mirage',
      'dc-firecrackers',
      'dc-owlbear'
    ]);
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const decoration = String((body && body.decoration) || '').trim();
      if (!ALLOWED_DECORATIONS.has(decoration)) {
        return sendJson(res, 400, { ok: false, error: 'Unknown decoration preset' });
      }
      const customStatus = body && typeof body.customStatus === 'string'
        ? body.customStatus.trim().slice(0, 48)
        : undefined;
      const bio = body && typeof body.bio === 'string'
        ? body.bio.replace(/[<>]/g, '').trim().slice(0, 140)
        : undefined;
      let banner = body && typeof body.banner === 'string' ? body.banner.trim() : undefined;
      if (banner !== undefined && banner) {
        const validBanner =
          /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(banner) ||
          /^https:\/\/(?:media\.tenor\.com|media\.giphy\.com|cdn\.discordapp\.com)\/[^\s"'<>]+$/i.test(banner) ||
          /^linear-gradient\([^;{}<>]+\)$/i.test(banner);
        if (!validBanner) {
          return sendJson(res, 400, { ok: false, error: 'Invalid banner format' });
        }
      }
      const newDisplayNameRaw = body && typeof body.displayName === 'string'
        ? body.displayName.replace(/[<>]/g, '').trim().slice(0, 32)
        : undefined;
      const rawNextUsername = body && typeof body.username === 'string'
        ? body.username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24)
        : undefined;

      let activeUsername = sessionUser.username;
      let extraHeaders = {};
      if (rawNextUsername !== undefined && rawNextUsername !== activeUsername) {
        if (rawNextUsername.length < 2) {
          return sendJson(res, 400, { ok: false, error: 'Username must be at least 2 characters (letters, numbers, _ . -)' });
        }
        if (rawNextUsername === 'astra-bot' || rawNextUsername === 'system') {
          return sendJson(res, 400, { ok: false, error: 'That username is reserved' });
        }
        if (authStore.users[rawNextUsername]) {
          return sendJson(res, 409, { ok: false, error: `@${rawNextUsername} is already taken` });
        }
        if (activeUsername === 'coolbacon') {
          return sendJson(res, 400, { ok: false, error: 'Primary admin handle coolbacon stays locked (you can still change Display Name)' });
        }
        const rec = authStore.users[activeUsername];
        if (!rec) return sendJson(res, 404, { ok: false, error: 'Account not found' });
        delete authStore.users[activeUsername];
        rec.username = rawNextUsername;
        authStore.users[rawNextUsername] = rec;

        if (tourPrefs[activeUsername]) {
          tourPrefs[rawNextUsername] = tourPrefs[activeUsername];
          delete tourPrefs[activeUsername];
          saveTourPrefs();
        }
        if (userCookieJars[activeUsername]) {
          userCookieJars[rawNextUsername] = userCookieJars[activeUsername];
          delete userCookieJars[activeUsername];
          scheduleSaveUserCookies();
        }
        for (const c of chatClients) {
          if (c.astraSession && c.astraSession.username === activeUsername) {
            c.astraSession.username = rawNextUsername;
          }
        }
        for (const p of voicePeers.values()) {
          if (p.username === activeUsername) p.username = rawNextUsername;
        }
        const cd = readChatStore();
        let renamed = false;
        for (const [k, arr] of Object.entries(cd)) {
          if (k === '_channels' || !Array.isArray(arr)) continue;
          for (const m of arr) {
            if (m && m.username === activeUsername) {
              m.username = rawNextUsername;
              renamed = true;
            }
          }
        }
        if (renamed) writeChatStore(cd);

        activeUsername = rawNextUsername;
        const nextToken = signSessionToken(activeUsername);
        const isHttps = req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
        const sameSitePart = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
        extraHeaders['Set-Cookie'] = `astra_session=${encodeURIComponent(nextToken)}; HttpOnly; Path=/; ${sameSitePart}; Max-Age=604800`;
      }

      if (authStore && authStore.users && authStore.users[activeUsername]) {
        authStore.users[activeUsername].decoration = decoration;
        if (customStatus !== undefined) authStore.users[activeUsername].customStatus = customStatus;
        if (bio !== undefined) authStore.users[activeUsername].bio = bio;
        if (banner !== undefined) authStore.users[activeUsername].banner = banner;
        if (newDisplayNameRaw !== undefined && newDisplayNameRaw.length >= 1) {
          authStore.users[activeUsername].displayName = newDisplayNameRaw;
          for (const c of chatClients) {
            if (c.astraSession && c.astraSession.username === activeUsername) {
              c.astraSession.displayName = newDisplayNameRaw;
            }
          }
          for (const p of voicePeers.values()) {
            if (p.username === activeUsername) p.displayName = newDisplayNameRaw;
          }
        }
        saveAuthStore();
      }
      const savedUser = authStore.users[activeUsername] || {};
      const members = getChatMembersList();
      broadcastChatWs({ type: 'members-update', members });
      return sendJson(res, 200, {
        ok: true,
        username: activeUsername,
        displayName: savedUser.displayName || activeUsername,
        decoration,
        banner: savedUser.banner || '',
        bio: savedUser.bio || '',
        customStatus: savedUser.customStatus || '',
        visualRoles: resolveUserVisualRoles(savedUser),
        members
      }, extraHeaders);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
    }
  }

  if (pathname === '/api/chat/roles') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    if (req.method === 'GET') {
      const roles = readVisualRolesStore();
      const rec = authStore && authStore.users && authStore.users[sessionUser.username];
      return sendJson(res, 200, { ok: true, roles, myRoleIds: resolveUserVisualRoles(rec).map((r) => r.id) });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 512 * 1024);
        const action = String((body && body.action) || 'toggle');
        const roles = readVisualRolesStore();
        const rec = authStore && authStore.users && authStore.users[sessionUser.username];
        if (!rec) return sendJson(res, 404, { ok: false, error: 'User not found' });
        if (!Array.isArray(rec.visualRoles)) rec.visualRoles = [];

        if (action === 'create') {
          const name = String((body && body.name) || '').replace(/[<>]/g, '').trim().slice(0, 26);
          if (name.length < 2) {
            return sendJson(res, 400, { ok: false, error: 'Role name must be at least 2 characters' });
          }
          const colorRaw = String((body && body.color) || '#a855f7').trim();
          const color = /^#[0-9a-f]{3,8}$/i.test(colorRaw) ? colorRaw : '#a855f7';
          const iconRaw = String((body && body.icon) || '⭐').trim();
          const isImg = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(iconRaw) || /^\/assets\/chat\/[A-Za-z0-9_.-]+$/.test(iconRaw);
          const iconType = isImg ? 'image' : 'emoji';
          const icon = isImg ? iconRaw : (iconRaw.slice(0, 8) || '⭐');
          const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) + '-' + crypto.randomBytes(2).toString('hex');
          const newRole = {
            id,
            name,
            iconType,
            icon,
            color,
            createdBy: sessionUser.username,
            visualOnly: true
          };
          roles.push(newRole);
          writeCustomVisualRolesStore(roles);
          if (!rec.visualRoles.includes(id)) rec.visualRoles.push(id);
          saveAuthStore();
          const members = getChatMembersList();
          broadcastChatWs({ type: 'roles-update', roles, members });
          return sendJson(res, 200, { ok: true, role: newRole, roles, myRoleIds: resolveUserVisualRoles(rec).map((r) => r.id), members });
        }

        if (action === 'delete') {
          const targetId = String((body && body.roleId) || '').trim();
          const target = roles.find((r) => r.id === targetId);
          if (!target) return sendJson(res, 404, { ok: false, error: 'Role not found' });
          if (target.locked) return sendJson(res, 403, { ok: false, error: 'Built-in server roles cannot be deleted' });
          if (sessionUser.role !== 'admin' && target.createdBy !== sessionUser.username) {
            return sendJson(res, 403, { ok: false, error: 'Only the creator or admin can remove this visual role' });
          }
          const nextRoles = roles.filter((r) => r.id !== targetId);
          writeCustomVisualRolesStore(nextRoles);
          for (const u of Object.values(authStore.users)) {
            if (Array.isArray(u.visualRoles)) {
              u.visualRoles = u.visualRoles.filter((id) => id !== targetId);
            }
          }
          saveAuthStore();
          const members = getChatMembersList();
          broadcastChatWs({ type: 'roles-update', roles: nextRoles, members });
          return sendJson(res, 200, { ok: true, roles: nextRoles, myRoleIds: resolveUserVisualRoles(rec).map((r) => r.id), members });
        }

        // Toggle equip/unequip visual role
        const roleId = String((body && body.roleId) || '').trim();
        const roleObj = roles.find((r) => r.id === roleId);
        if (!roleObj) return sendJson(res, 404, { ok: false, error: 'Visual role not found' });
        if (roleObj.ownerOnly && sessionUser.username !== 'coolbacon') {
          return sendJson(res, 403, { ok: false, error: 'Astra Owner crown is exclusive to coolbacon' });
        }
        const idx = rec.visualRoles.indexOf(roleId);
        if (idx >= 0) rec.visualRoles.splice(idx, 1);
        else rec.visualRoles.push(roleId);
        saveAuthStore();
        const members = getChatMembersList();
        broadcastChatWs({ type: 'roles-update', roles, members });
        return sendJson(res, 200, { ok: true, roles, myRoleIds: resolveUserVisualRoles(rec).map((r) => r.id), members });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
  }

  if (pathname === '/api/chat/gifs') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const q = String(reqUrl.searchParams.get('q') || '').trim().slice(0, 60);
    const cacheKey = q.toLowerCase() || '__trending__';
    const hit = chatGifSearchCache.get(cacheKey);
    if (hit && Date.now() < hit.expires) {
      return sendJson(res, 200, { ok: true, gifs: hit.gifs });
    }
    try {
      const targetUrl = q
        ? `https://tenor.com/search/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'))}-gifs`
        : 'https://tenor.com/search/meme-gifs';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6000);
      const html = await fetch(targetUrl, {
        signal: ac.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' }
      }).then((r) => r.text());
      clearTimeout(timer);
      const urls = [...new Set([...html.matchAll(/https:\/\/media\.tenor\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.gif/g)].map((m) => m[0]))].slice(0, 24);
      chatGifSearchCache.set(cacheKey, { gifs: urls, expires: Date.now() + 10 * 60 * 1000 });
      return sendJson(res, 200, { ok: true, gifs: urls });
    } catch {
      return sendJson(res, 200, { ok: true, gifs: [] });
    }
  }

  const DEFAULT_CHAT_CHANNELS = [
    { id: 'announcements', name: 'announcements', topic: 'admin announcements & server news', type: 'text', category: 'Text Channels', adminOnly: true, locked: true },
    { id: 'updates', name: 'updates', topic: 'astra bot update drops & patch notes', type: 'text', category: 'Text Channels', adminOnly: true, locked: true },
    { id: 'roles', name: 'roles', topic: 'create & pick custom visual chat role icons', type: 'text', category: 'Text Channels', locked: true },
    { id: 'general', name: 'general', topic: 'main server chat', type: 'text', category: 'Text Channels', locked: true },
    { id: 'off-topic', name: 'off-topic', topic: 'memes, gaming & anything goes', type: 'text', category: 'Text Channels' },
    { id: 'roblox-squads', name: 'roblox-squads', topic: 'share place IDs & party up for roblox', type: 'text', category: 'Text Channels' },
    { id: 'voice-lounge', name: 'Voice Lounge', topic: 'chill voice hangout', type: 'voice', category: 'Voice Channels', locked: true }
  ];

  const ASTRA_BOT_LATEST_ID = 'seed-astra-bot-updates-v2';
  const buildAstraBotMessage = (channel, title, bodyText, highlights = []) => ({
    id: `${ASTRA_BOT_LATEST_ID}-${crypto.randomBytes(4).toString('hex')}`,
    channel,
    username: 'astra-bot',
    displayName: 'Astra Bot',
    role: 'bot',
    isBot: true,
    avatar: '/assets/chat/astra-bot-pfp.png',
    decoration: 'astra-halo',
    text: bodyText,
    embed: {
      title,
      badge: 'NEW UPDATES',
      highlights
    },
    reactions: { '🚀': ['astra-bot'], '🔥': ['astra-bot'] },
    ts: Date.now()
  });

  const readChatStore = () => {
    let data = chatStoreCache;
    let dirty = false;
    if (!data || typeof data !== 'object') {
      const loaded = readJsonStoreSafe(CHAT_FILE, null);
      if (loaded && typeof loaded === 'object') {
        data = loaded;
      } else {
        data = {
          announcements: [
            {
              id: 'seed-ann-1',
              channel: 'announcements',
              username: 'coolbacon',
              displayName: 'Luis (coolbacon)',
              role: 'admin',
              text: 'Welcome to Astra Chat! Create or reorder channels anytime, react/reply, crop your PFP, and equip genuine Discord decorations!',
              ts: Date.now() - 60000
            }
          ],
          general: [],
          'off-topic': [],
          'roblox-squads': []
        };
        dirty = true;
      }
      chatStoreCache = data;
    }
    if (!Array.isArray(data._channels) || !data._channels.length) {
      data._channels = DEFAULT_CHAT_CHANNELS.map((c) => ({ ...c }));
      dirty = true;
    } else {
      for (const def of DEFAULT_CHAT_CHANNELS) {
        if (!data._channels.some((c) => c && c.id === def.id)) {
          data._channels.push({ ...def });
          dirty = true;
        }
      }
    }
    for (const ch of data._channels) {
      if (ch.type !== 'voice' && !Array.isArray(data[ch.id])) {
        data[ch.id] = [];
        dirty = true;
      }
    }
    if (!Array.isArray(data.announcements)) { data.announcements = []; dirty = true; }
    const cleanedAnn = data.announcements.filter((m) => !(m && String(m.id || '').startsWith('seed-astra-bot-updates')));
    if (cleanedAnn.length !== data.announcements.length) {
      data.announcements = cleanedAnn;
      dirty = true;
    }
    if (!Array.isArray(data.updates)) { data.updates = []; dirty = true; }
    if (!data.updates.some((m) => m && String(m.id || '').startsWith(ASTRA_BOT_LATEST_ID))) {
      data.updates.push({
        ...buildAstraBotMessage(
          'updates',
          'Astra v2.4 Update Drop',
          'Here is everything new live on Astra right now:',
          [
            'Roblox + LucideBlox Node API Proxy (fast catalog & charts + new-tab Play launcher)',
            'Premade robloxcookie= quick-connect URLs & copyable launch links',
            '20 Genuine Animated Discord Avatar Decorations + Username / Display Name editor',
            'GIFs, Stickers, Animated GIF PFPs, Banners, Role Icons & #roles custom role builder!',
            'Dedicated #updates channel + drag-and-drop Channel Reordering'
          ]
        ),
        id: ASTRA_BOT_LATEST_ID
      });
      dirty = true;
    }
    if (!Array.isArray(data.roles)) { data.roles = []; dirty = true; }
    if (!data.roles.some((m) => m && m.id === 'seed-roles-guide-v1')) {
      data.roles.push({
        ...buildAstraBotMessage(
          'roles',
          'Welcome to #roles — Custom Role Icons',
          'Design or claim visual role badges using the interactive Role Studio card right above/below! Hover any role icon next to someone’s name in chat to see their role title.',
          [
            'coolbacon → Astra Owner 👑',
            'Mason & Jase → LBP Fans (LittleBigPlanet Sackboy sticker) + LEGO Star Wars PFP',
            'Kingsley → Snoop Dogg Fan + Snoop Dogg PFP',
            'Anyone can create their own visual role icon — cosmetic only, no permissions changed!'
          ]
        ),
        id: 'seed-roles-guide-v1'
      });
      dirty = true;
    }
    if (dirty) {
      try { writeJsonStoreAtomic(CHAT_FILE, data); } catch {}
    }
    return data;
  };
  const writeChatStore = (data) => {
    chatStoreCache = data;
    writeJsonStoreAtomic(CHAT_FILE, data);
  };

  if (pathname === '/api/chat/channels/reorder' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req);
      const order = Array.isArray(body && body.order) ? body.order.map((x) => String(x)) : [];
      if (!order.length) {
        return sendJson(res, 400, { ok: false, error: 'order array required' });
      }
      const data = readChatStore();
      const byId = new Map(data._channels.map((c) => [c.id, c]));
      const next = [];
      const used = new Set();
      for (const cid of order) {
        if (byId.has(cid) && !used.has(cid)) {
          next.push(byId.get(cid));
          used.add(cid);
        }
      }
      for (const c of data._channels) {
        if (!used.has(c.id)) next.push(c);
      }
      data._channels = next;
      writeChatStore(data);
      broadcastChatWs({ type: 'channels-update', channels: data._channels });
      return sendJson(res, 200, { ok: true, channels: data._channels });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
    }
  }

  if (pathname === '/api/chat/channels') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    if (req.method === 'GET') {
      const data = readChatStore();
      return sendJson(res, 200, { ok: true, channels: data._channels, voicePeers: getVoicePeerList(), members: getChatMembersList() });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const type = body && body.type === 'voice' ? 'voice' : 'text';
        const rawName = String((body && body.name) || '').trim();
        const cleanName = type === 'text'
          ? rawName.toLowerCase().replace(/[^a-z0-9-_ ]+/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)
          : rawName.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 28);
        if (!cleanName) {
          return sendJson(res, 400, { ok: false, error: 'Channel name must contain letters or numbers' });
        }
        const slug = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || cleanName.toLowerCase();
        const topic = String((body && body.topic) || '').trim().slice(0, 100);
        const category = type === 'voice' ? 'Voice Channels' : (String((body && body.category) || 'Text Channels').trim().slice(0, 28) || 'Text Channels');
        const data = readChatStore();
        let finalId = slug;
        if (data._channels.some((c) => c.id === finalId || (c.name.toLowerCase() === cleanName.toLowerCase() && c.type === type))) {
          return sendJson(res, 409, { ok: false, error: `A ${type} channel named "${cleanName}" already exists` });
        }
        const newCh = {
          id: finalId,
          name: cleanName,
          topic: topic || (type === 'voice' ? 'voice channel' : `chat in #${cleanName}`),
          type,
          category,
          createdBy: sessionUser.username,
          createdAt: Date.now()
        };
        data._channels.push(newCh);
        if (type === 'text' && !Array.isArray(data[finalId])) data[finalId] = [];
        writeChatStore(data);
        broadcastChatWs({ type: 'channels-update', channels: data._channels });
        return sendJson(res, 200, { ok: true, channel: newCh, channels: data._channels });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
    if (req.method === 'DELETE') {
      try {
        let targetId = String(reqUrl.searchParams.get('id') || '').trim().toLowerCase();
        if (!targetId) {
          const body = await readJsonBody(req).catch(() => ({}));
          targetId = String((body && body.id) || '').trim().toLowerCase();
        }
        const data = readChatStore();
        const ch = data._channels.find((c) => c.id === targetId);
        if (!ch) return sendJson(res, 404, { ok: false, error: 'Channel not found' });
        if (ch.locked) return sendJson(res, 403, { ok: false, error: 'Core server channels cannot be deleted' });
        if (sessionUser.role !== 'admin' && ch.createdBy && ch.createdBy !== sessionUser.username) {
          return sendJson(res, 403, { ok: false, error: 'Only the channel creator or admin can delete this channel' });
        }
        data._channels = data._channels.filter((c) => c.id !== targetId);
        delete data[targetId];
        writeChatStore(data);
        broadcastChatWs({ type: 'channels-update', channels: data._channels, deletedChannelId: targetId });
        return sendJson(res, 200, { ok: true, channels: data._channels });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
  }

  if (pathname === '/api/chat/react' && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req);
      const chId = String((body && body.channel) || 'general').toLowerCase();
      const messageId = String((body && body.messageId) || '').trim();
      const emoji = String((body && body.emoji) || '').trim().slice(0, 12);
      if (!messageId || !emoji) {
        return sendJson(res, 400, { ok: false, error: 'channel, messageId, and emoji required' });
      }
      const data = readChatStore();
      const list = Array.isArray(data[chId]) ? data[chId] : [];
      const msg = list.find((m) => m && m.id === messageId);
      if (!msg) return sendJson(res, 404, { ok: false, error: 'Message not found' });
      if (!msg.reactions || typeof msg.reactions !== 'object') msg.reactions = {};
      const arr = Array.isArray(msg.reactions[emoji]) ? msg.reactions[emoji] : [];
      const idx = arr.indexOf(sessionUser.username);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(sessionUser.username);
      if (arr.length) msg.reactions[emoji] = arr;
      else delete msg.reactions[emoji];
      writeChatStore(data);
      const hydrated = {
        ...msg,
        displayName: (authStore && authStore.users && authStore.users[msg.username] && authStore.users[msg.username].displayName) || msg.displayName || msg.username,
        avatar: (authStore && authStore.users && authStore.users[msg.username] && authStore.users[msg.username].avatar) || msg.avatar || '',
        banner: (authStore && authStore.users && authStore.users[msg.username] && authStore.users[msg.username].banner) || msg.banner || '',
        bio: (authStore && authStore.users && authStore.users[msg.username] && authStore.users[msg.username].bio) || '',
        decoration: (authStore && authStore.users && authStore.users[msg.username] && authStore.users[msg.username].decoration) || msg.decoration || '',
        visualRoles: resolveUserVisualRoles(authStore && authStore.users && authStore.users[msg.username])
      };
      broadcastChatWs({ type: 'message-update', channel: chId, message: hydrated });
      return sendJson(res, 200, { ok: true, message: hydrated });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
    }
  }

  if (pathname === '/api/chat/messages') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    if (req.method === 'GET') {
      const data = readChatStore();
      const ch = String(reqUrl.searchParams.get('channel') || 'general').toLowerCase();
      const channelObj = data._channels.find((c) => c.id === ch && c.type !== 'voice') || data._channels.find((c) => c.type !== 'voice');
      const channel = channelObj ? channelObj.id : 'general';
      const rawMessages = Array.isArray(data[channel]) ? data[channel] : [];
      const messages = rawMessages.map((m) => {
        const uRec = authStore && authStore.users && authStore.users[m.username];
        return {
          ...m,
          displayName: (uRec && uRec.displayName) || m.displayName || m.username,
          avatar: (m.isBot || m.username === 'astra-bot') ? '/assets/chat/astra-bot-pfp.png' : ((uRec && uRec.avatar) || m.avatar || ''),
          banner: (uRec && uRec.banner) || m.banner || '',
          bio: (uRec && uRec.bio) || '',
          decoration: (uRec && uRec.decoration) || m.decoration || '',
          visualRoles: (m.isBot || m.username === 'astra-bot') ? [{ id: 'astra-bot-role', name: 'Verified Bot', iconType: 'emoji', icon: '🤖', color: '#5865f2' }] : resolveUserVisualRoles(uRec)
        };
      });
      const canPost = !(channelObj && channelObj.adminOnly) || sessionUser.role === 'admin';
      return sendJson(res, 200, {
        ok: true,
        channel,
        channels: data._channels,
        messages,
        canPost,
        voicePeers: getVoicePeerList(),
        members: getChatMembersList()
      });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        const data = readChatStore();
        const ch = String((body && body.channel) || 'general').toLowerCase();
        const channelObj = data._channels.find((c) => c.id === ch && c.type !== 'voice');
        if (!channelObj) {
          return sendJson(res, 404, { ok: false, error: 'Text channel not found' });
        }
        const channel = channelObj.id;
        if (channelObj.adminOnly && sessionUser.role !== 'admin') {
          return sendJson(res, 403, { ok: false, error: 'Only admin (coolbacon) can post in #' + channelObj.name });
        }
        const text = String((body && body.text) || '').trim().slice(0, 1200);
        const rawMediaUrl = String((body && body.mediaUrl) || '').trim();
        const validMediaUrl =
          rawMediaUrl && (
            /^https:\/\/(?:media\.tenor\.com|media\.giphy\.com|cdn\.discordapp\.com)\/[^\s"'<>]+$/i.test(rawMediaUrl) ||
            /^\/assets\/chat\/[A-Za-z0-9_.-]+$/.test(rawMediaUrl) ||
            /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(rawMediaUrl)
          )
            ? rawMediaUrl
            : '';
        const mediaType = validMediaUrl ? (['gif', 'sticker', 'image'].includes(body && body.mediaType) ? body.mediaType : 'gif') : '';
        if (!text && !validMediaUrl) {
          return sendJson(res, 400, { ok: false, error: 'Message text or media required' });
        }
        if (!Array.isArray(data[channel])) data[channel] = [];
        let replyTo = null;
        if (body && body.replyToId) {
          const ref = data[channel].find((m) => m && m.id === String(body.replyToId));
          if (ref) {
            replyTo = {
              id: ref.id,
              username: ref.username,
              displayName: ref.displayName || ref.username,
              text: String(ref.text || (ref.mediaUrl ? '[GIF / Sticker]' : '')).slice(0, 90)
            };
          }
        }
        const isBotAnnounce = sessionUser.role === 'admin' && /^\/botupdate\s+(.+)/i.test(text);
        if (isBotAnnounce) {
          const customNote = text.replace(/^\/botupdate\s+/i, '').trim();
          const botEntry = buildAstraBotMessage(
            channel,
            'Astra Bot — Update Broadcast',
            customNote,
            []
          );
          data[channel].push(botEntry);
          if (data[channel].length > 200) data[channel] = data[channel].slice(-200);
          writeChatStore(data);
          broadcastChatWs({ type: 'chat-message', channel, message: botEntry });
          return sendJson(res, 200, { ok: true, message: botEntry, messages: data[channel] });
        }
        const userRec = authStore && authStore.users && authStore.users[sessionUser.username];
        const userAvatar = (userRec && userRec.avatar) || '';
        const userDecoration = (userRec && userRec.decoration) || '';
        const entry = {
          id: crypto.randomBytes(8).toString('hex'),
          channel,
          username: sessionUser.username,
          displayName: (userRec && userRec.displayName) || sessionUser.displayName || sessionUser.username,
          role: sessionUser.role || 'user',
          avatar: userAvatar,
          banner: (userRec && userRec.banner) || '',
          bio: (userRec && userRec.bio) || '',
          decoration: userDecoration,
          visualRoles: resolveUserVisualRoles(userRec),
          text,
          mediaUrl: validMediaUrl || undefined,
          mediaType: mediaType || undefined,
          replyTo,
          reactions: {},
          ts: Date.now()
        };
        data[channel].push(entry);

        if (/^!(?:updates|whatsnew|bot)$/i.test(text) || /@astra\s*bot/i.test(text)) {
          const botReply = buildAstraBotMessage(
            channel,
            'Astra Bot — Latest Updates',
            'Here is what was just added to Astra:',
            [
              'LucideBlox Node API Proxy + New Tab Game Launch (no Wisp relay failure)',
              'Premade robloxcookie= launch links in Astra URL / Search Bar',
              '20 Genuine Animated Discord Avatar Decorations + Username / Display Name editing',
              'Drag-and-drop Channel Reordering & compact Discord message spacing',
              'Admin command: type /botupdate <your message> to post as Astra Bot'
            ]
          );
          data[channel].push(botReply);
          if (data[channel].length > 200) data[channel] = data[channel].slice(-200);
          writeChatStore(data);
          broadcastChatWs({ type: 'chat-message', channel, message: entry });
          broadcastChatWs({ type: 'chat-message', channel, message: botReply });
          return sendJson(res, 200, { ok: true, message: entry, botMessage: botReply, messages: data[channel] });
        }

        if (data[channel].length > 200) data[channel] = data[channel].slice(-200);
        writeChatStore(data);
        broadcastChatWs({ type: 'chat-message', channel, message: entry });
        return sendJson(res, 200, { ok: true, message: entry, messages: data[channel] });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
    if (req.method === 'DELETE') {
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const ch = String((body && body.channel) || reqUrl.searchParams.get('channel') || 'general').toLowerCase();
        const messageId = String((body && body.messageId) || reqUrl.searchParams.get('messageId') || '').trim();
        const data = readChatStore();
        const list = Array.isArray(data[ch]) ? data[ch] : [];
        const idx = list.findIndex((m) => m && m.id === messageId);
        if (idx === -1) return sendJson(res, 404, { ok: false, error: 'Message not found' });
        const targetMsg = list[idx];
        if (sessionUser.role !== 'admin' && targetMsg.username !== sessionUser.username) {
          return sendJson(res, 403, { ok: false, error: 'You can only delete your own messages' });
        }
        list.splice(idx, 1);
        data[ch] = list;
        writeChatStore(data);
        broadcastChatWs({ type: 'message-delete', channel: ch, messageId });
        return sendJson(res, 200, { ok: true, messages: list });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
  }

  if (pathname === '/api/music/liked') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const likesFile = path.join(DATA_DIR, 'music-likes.json');
    const readLikes = () => {
      try {
        return JSON.parse(fs.readFileSync(likesFile, 'utf8')) || {};
      } catch {
        return {};
      }
    };
    const writeLikes = (all) => {
      fs.writeFileSync(likesFile, JSON.stringify(all, null, 2), 'utf8');
    };
    const uname = sessionUser.username;
    if (req.method === 'GET') {
      const all = readLikes();
      return sendJson(res, 200, { ok: true, songs: Array.isArray(all[uname]) ? all[uname] : [] });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (body && body.action === 'sync-all' && Array.isArray(body.songs)) {
          const all = readLikes();
          const list = Array.isArray(all[uname]) ? all[uname] : [];
          for (const s of body.songs.slice(0, 120)) {
            if (s && s.id && !list.some((x) => x.id === s.id)) list.push(s);
          }
          all[uname] = list;
          writeLikes(all);
          return sendJson(res, 200, { ok: true, songs: list });
        }
        const song = body && body.song ? body.song : null;
        if (!song || !song.id) {
          return sendJson(res, 400, { ok: false, error: 'song.id required' });
        }
        const all = readLikes();
        const list = Array.isArray(all[uname]) ? all[uname] : [];
        const idx = list.findIndex((s) => s.id === song.id);
        let liked = false;
        if (body.action === 'remove') {
          if (idx !== -1) list.splice(idx, 1);
          liked = false;
        } else if (body.action === 'add') {
          if (idx === -1) list.unshift({ id: String(song.id), title: String(song.title || 'Untitled'), artist: String(song.artist || 'YouTube'), duration: String(song.duration || ''), thumbnail: String(song.thumbnail || `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`), likedAt: Date.now() });
          liked = true;
        } else {
          if (idx !== -1) {
            list.splice(idx, 1);
            liked = false;
          } else {
            list.unshift({ id: String(song.id), title: String(song.title || 'Untitled'), artist: String(song.artist || 'YouTube'), duration: String(song.duration || ''), thumbnail: String(song.thumbnail || `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`), likedAt: Date.now() });
            liked = true;
          }
        }
        all[uname] = list;
        writeLikes(all);
        return sendJson(res, 200, { ok: true, liked, songs: list });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
  }

  if ((pathname === '/api/ai/chat' || pathname === '/api/ai/gemini') && req.method === 'POST') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    try {
      const body = await readJsonBody(req, 6 * 1024 * 1024);
      const selectedModel = String(body.model || (pathname === '/api/ai/gemini' ? 'gemini-2.5-flash' : 'claude-haiku-xkiro')).trim();
      const isHaiku = /haiku|xkiro|claude/i.test(selectedModel);
      const prompt = String(body.prompt || '').trim();
      const rawImg = String(body.imageBase64 || '').trim();
      const mimeType = String(body.mimeType || 'image/jpeg').trim() || 'image/jpeg';
      const history = Array.isArray(body.history) ? body.history.slice(-10) : [];

      if (!prompt && !rawImg) {
        return sendJson(res, 400, { ok: false, error: 'Prompt or screen frame required.' });
      }

      if (isHaiku) {
        const apiKey = String(body.apiKey || process.env.XKIRO_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
        let endpoint = String(body.baseUrl || process.env.XKIRO_BASE_URL || 'https://api.xkiro.ai/v1/messages').trim();
        if (!/\/messages$/i.test(endpoint)) {
          endpoint = endpoint.replace(/\/+$/, '') + (/\/v1$/i.test(endpoint) ? '/messages' : '/v1/messages');
        }
        if (!apiKey) {
          return sendJson(res, 400, {
            ok: false,
            error: 'No xKiro / Claude Haiku API key set. Click the model/key settings button in Astra AI to add your xKiro key (or switch to Gemini).'
          });
        }

        const messages = [];
        for (const turn of history) {
          if (!turn || !turn.text) continue;
          messages.push({
            role: turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user',
            content: String(turn.text).slice(0, 4000)
          });
        }

        const currentContent = [];
        if (rawImg) {
          const cleanB64 = rawImg.replace(/^data:[^;]+;base64,/, '');
          currentContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: cleanB64
            }
          });
        }
        currentContent.push({
          type: 'text',
          text: prompt || 'Look at my screen and help me with it.'
        });
        messages.push({ role: 'user', content: currentContent });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25000);
        try {
          const upstream = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'Authorization': `Bearer ${apiKey}`,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-3-5-haiku-latest',
              max_tokens: 1024,
              system: 'You are Astra AI running Claude Haiku via xKiro. Be sharp, concise, and helpful. When a screen capture is attached, inspect what is visible carefully.',
              messages
            }),
            signal: controller.signal
          });
          const data = await upstream.json();
          if (!upstream.ok) {
            const errMsg = data?.error?.message || data?.message || `xKiro API error (${upstream.status})`;
            return sendJson(res, upstream.status >= 400 ? upstream.status : 502, { ok: false, error: errMsg });
          }
          const parts = Array.isArray(data?.content) ? data.content : [];
          const reply = parts.map(p => p.text || '').join('').trim() || data?.choices?.[0]?.message?.content || 'No response generated.';
          return sendJson(res, 200, { ok: true, reply, model: 'claude-3-5-haiku (xKiro)' });
        } finally {
          clearTimeout(timer);
        }
      }

      const apiKey = String(body.apiKey || process.env.GEMINI_API_KEY || '').trim();
      if (!apiKey) {
        return sendJson(res, 400, {
          ok: false,
          error: 'No Gemini API key set. Click the key button in Astra AI to add your Gemini API key.'
        });
      }

      const contents = [];
      for (const turn of history) {
        if (!turn || !turn.text) continue;
        contents.push({
          role: turn.role === 'model' || turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(turn.text).slice(0, 4000) }]
        });
      }

      const currentParts = [];
      if (rawImg) {
        const cleanB64 = rawImg.replace(/^data:[^;]+;base64,/, '');
        currentParts.push({
          inline_data: {
            mime_type: mimeType,
            data: cleanB64
          }
        });
      }
      currentParts.push({
        text: prompt || 'Describe what is on my screen and help me with it.'
      });
      contents.push({ role: 'user', parts: currentParts });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: 'You are Astra AI, a sharp, concise multimodal assistant embedded inside Astra. When a screenshare frame is attached, inspect the visible UI, text, code, or content carefully and give direct, helpful answers.' }]
              },
              contents
            }),
            signal: controller.signal
          }
        );
        const data = await upstream.json();
        if (!upstream.ok) {
          const errMsg = data?.error?.message || `Gemini API error (${upstream.status})`;
          return sendJson(res, upstream.status >= 400 ? upstream.status : 502, { ok: false, error: errMsg });
        }
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const reply = parts.map(p => p.text || '').join('').trim() || 'No response generated.';
        return sendJson(res, 200, { ok: true, reply, model: 'gemini-2.5-flash' });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message || 'AI request failed' });
    }
  }

  if (pathname === '/api/user/state') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    const profileFile = migrateLegacyStoreFile('user-profiles.json');
    const readProfiles = () => readJsonStoreSafe(profileFile, {});
    const writeProfiles = (data) => {
      writeJsonStoreAtomic(profileFile, data);
    };
    if (req.method === 'GET') {
      const all = readProfiles();
      const state = all[sessionUser.username] || {};
      return sendJson(res, 200, { ok: true, username: sessionUser.username, state });
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 512 * 1024);
        const all = readProfiles();
        const prev = all[sessionUser.username] || {};
        const next = { ...prev };
        for (const key of ['settings', 'adblock', 'recentGames', 'tabs', 'aiThreads', 'aiUsage', 'lastTrack']) {
          if (body && body[key] !== undefined) next[key] = body[key];
        }
        next.updatedAt = Date.now();
        all[sessionUser.username] = next;
        writeProfiles(all);
        return sendJson(res, 200, { ok: true, state: next });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'bad payload' });
      }
    }
  }

  if (pathname === '/api/games') {
    if (!sessionUser) {
      return sendJson(res, 401, { ok: false, error: 'login required' });
    }
    if (serverConfig.maintenanceMode && sessionUser.role !== 'admin') {
      return sendJson(res, 503, { ok: false, error: 'maintenance mode enabled by admin' });
    }
    const mirrors = [
      'https://raw.githubusercontent.com/gn-math/assets/main/zones.json',
      'https://raw.githack.com/gn-math/assets/main/zones.json',
      'https://cdn.jsdelivr.net/gh/gn-math/assets@latest/zones.json',
      'https://gn-math.dev/zones.json'
    ];
    for (const mirror of mirrors) {
      try {
        const json = await fetchJsonWithTimeout(mirror, 4500);
        if (Array.isArray(json) && json.length > 0) {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          return res.end(JSON.stringify(json));
        }
      } catch {}
    }
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end('[]');
  }

  if (pathname === '/proxy' || pathname.startsWith('/scramjet/') || pathname.startsWith('/uv/service/')) {
    if (!sessionUser) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<body style="background:#050508;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">sign in to astra first</body>');
    }
    if (serverConfig.maintenanceMode && sessionUser.role !== 'admin') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<body style="background:#050508;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">astra is in maintenance mode — check back soon</body>');
    }
  }

  if (pathname === '/proxy') {
    const target = reqUrl.searchParams.get('url');
    const adblock = reqUrl.searchParams.get('adblock') !== '0';
    const engine = reqUrl.searchParams.get('engine') || serverConfig.defaultEngine || 'scramjet';
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Missing url parameter');
    }
    return fetchAndProxy(target, adblock, req, res, 5, engine);
  }

  function resolveRelativeViaReferer(relPath, fallbackAdblock = true) {
    const referer = req.headers.referer;
    if (!referer) return null;
    try {
      const refUrl = new URL(referer);
      let refTarget = null;
      let refEngine = serverConfig.defaultEngine || 'scramjet';
      if (refUrl.pathname === '/proxy' && refUrl.searchParams.get('url')) {
        refTarget = refUrl.searchParams.get('url');
        refEngine = refUrl.searchParams.get('engine') || refEngine;
      } else if (refUrl.pathname.startsWith('/scramjet/')) {
        refTarget = decodeXor(refUrl.pathname.slice('/scramjet/'.length));
        refEngine = 'scramjet';
      } else if (refUrl.pathname.startsWith('/uv/service/')) {
        refTarget = decodeXor(refUrl.pathname.slice('/uv/service/'.length));
        refEngine = 'ultraviolet';
      }
      if (!refTarget || !/^https?:\/\//i.test(refTarget)) return null;
      const baseForRef = resolvedBaseMap.get(refTarget) || refTarget;
      const adblockFlag = refUrl.searchParams.has('adblock') ? refUrl.searchParams.get('adblock') !== '0' : fallbackAdblock;
      const extraParams = new URLSearchParams(reqUrl.searchParams);
      extraParams.delete('adblock');
      const extraQuery = extraParams.toString() ? `?${extraParams.toString()}` : '';
      const relWithQuery = relPath.includes('?') ? relPath : `${relPath}${extraQuery}`;
      return {
        resolved: new URL(relWithQuery, baseForRef).toString(),
        adblock: adblockFlag,
        engine: refEngine
      };
    } catch {
      return null;
    }
  }

  if (pathname.startsWith('/scramjet/')) {
    const encoded = pathname.slice('/scramjet/'.length);
    const adblock = reqUrl.searchParams.get('adblock') !== '0';
    try {
      let target = '';
      try {
        const plain = decodeURIComponent(encoded);
        if (/^https?:\/\//i.test(plain)) target = plain;
      } catch {}
      if (!target) {
        const xorTarget = decodeXor(encoded);
        if (/^https?:\/\//i.test(xorTarget)) target = xorTarget;
      }
      if (/^https?:\/\//i.test(target)) {
        return fetchAndProxy(target, adblock, req, res, 5, 'scramjet');
      }
      const relHit = resolveRelativeViaReferer(encoded, adblock);
      if (relHit) {
        return fetchAndProxy(relHit.resolved, relHit.adblock, req, res, 5, relHit.engine || 'scramjet');
      }
      throw new Error('bad url');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Invalid scramjet url');
    }
  }

  if (pathname.startsWith('/uv/service/')) {
    const encoded = pathname.slice('/uv/service/'.length);
    const adblock = reqUrl.searchParams.get('adblock') !== '0';
    try {
      const target = decodeXor(encoded);
      if (/^https?:\/\//i.test(target)) {
        return fetchAndProxy(target, adblock, req, res, 5, 'ultraviolet');
      }
      const relHit = resolveRelativeViaReferer(encoded, adblock);
      if (relHit) {
        return fetchAndProxy(relHit.resolved, relHit.adblock, req, res, 5, relHit.engine || 'ultraviolet');
      }
      throw new Error('bad url');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Invalid ultraviolet url');
    }
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveStaticFile(path.join(ROOT_DIR, 'index.html'), req, res, { 'Cache-Control': 'no-store' });
  }

  if (pathname.startsWith('/clever-cloak/')) {
    let decodedSub = pathname;
    try { decodedSub = decodeURIComponent(pathname); } catch {}
    const safeSub = path.normalize(decodedSub).replace(/^(\.\.[/\\])+/, '');
    return serveStaticFile(path.join(ROOT_DIR, safeSub), req, res);
  }

  // Referer-based fallback for root-relative assets/chunks requested by proxied pages
  const refererFallback = resolveRelativeViaReferer(req.url, true);
  if (refererFallback && sessionUser && (!serverConfig.maintenanceMode || sessionUser.role === 'admin')) {
    return fetchAndProxy(refererFallback.resolved, refererFallback.adblock, req, res, 5, refererFallback.engine);
  }

  if (pathname.startsWith('/assets/')) {
    const safeSub = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    return serveStaticFile(path.join(ROOT_DIR, safeSub), req, res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.on('upgrade', (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (reqUrl.pathname === '/wisp' || reqUrl.pathname === '/wisp/') {
      if (req.url === '/wisp') req.url = '/wisp/';
      if (req.headers.origin) {
        try {
          const originHost = new URL(req.headers.origin).host;
          const reqHost = req.headers['x-forwarded-host']
            ? String(req.headers['x-forwarded-host']).split(',')[0].trim()
            : req.headers.host;
          if (reqHost && originHost !== reqHost) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {}
      }
      if (serverConfig.maintenanceMode) {
        const sessionUser = getSessionUser(req);
        if (!sessionUser || sessionUser.role !== 'admin') {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      wisp.server.routeRequest(req, socket, head);
      return;
    }
    if (reqUrl.pathname === '/chat-ws') {
      const sessionUser = getSessionUser(req);
      if (!sessionUser) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      chatWss.handleUpgrade(req, socket, head, (ws) => {
        chatWss.emit('connection', ws, req, sessionUser);
      });
      return;
    }
  } catch {}
  socket.destroy();
});

if (require.main === module) {
  const HOST = process.env.HOST || '0.0.0.0';
  const flushPersistentStores = () => {
    try { if (chatStoreCache) writeJsonStoreAtomic(CHAT_FILE, chatStoreCache); } catch {}
    try { saveAuthStore(); } catch {}
    try { saveTourPrefs(); } catch {}
  };
  process.on('SIGINT', () => { flushPersistentStores(); process.exit(0); });
  process.on('SIGTERM', () => { flushPersistentStores(); process.exit(0); });
  server.listen(PORT, HOST, () => {
    console.log(`Astra server running at http://${HOST}:${PORT} (DATA_DIR=${DATA_DIR})`);
  });
}

module.exports = {
  server,
  rewriteHtml,
  rewriteCss,
  rewriteJs,
  isBlockedAdHost,
  encodeXor,
  decodeXor,
  makeProxyUrl,
  hashPassword,
  verifyPassword,
  signSessionToken,
  getSessionUser,
  authStore,
  serverConfig
};
