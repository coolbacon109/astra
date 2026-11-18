// Persistent Audio Playback Engine for Astra Music (stays alive across route switches)
const audioEl = new Audio();
audioEl.preload = 'auto';

const listeners = new Set();
let queue = [];
let queueIndex = -1;
let currentTrack = null;
let likedSongs = [];
let playlists = [];
let shuffleOn = true;
let repeatOn = false;
let playbackStatus = 'idle'; // idle | loading | playing | paused | stopped | error
let pendingSeekRatio = null;

function emit() {
  const snap = getState();
  for (const fn of listeners) {
    try { fn(snap); } catch {}
  }
}

export function subscribeMusic(fn) {
  listeners.add(fn);
  fn(getState());
  return () => listeners.delete(fn);
}

export function formatTime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function getSafeDuration() {
  const d = audioEl.duration;
  return (Number.isFinite(d) && d > 0) ? d : 0;
}

function getSafeCurrentTime() {
  const t = audioEl.currentTime;
  const d = getSafeDuration();
  if (!Number.isFinite(t) || t < 0) return 0;
  return d > 0 ? Math.min(t, d) : t;
}

export function getState() {
  const dur = getSafeDuration();
  const cur = getSafeCurrentTime();
  return {
    track: currentTrack,
    queue,
    queueIndex,
    likedSongs,
    playlists,
    shuffleOn,
    repeatOn,
    status: playbackStatus,
    paused: audioEl.paused,
    currentTime: cur,
    duration: dur,
    progressPct: dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0,
    volume: audioEl.volume,
    muted: audioEl.muted
  };
}

// Bind authentic HTMLAudioElement events
['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'playing', 'pause', 'seeking', 'seeked'].forEach((ev) => {
  audioEl.addEventListener(ev, () => {
    if ((ev === 'loadedmetadata' || ev === 'durationchange') && pendingSeekRatio !== null && getSafeDuration() > 0) {
      audioEl.currentTime = pendingSeekRatio * getSafeDuration();
      pendingSeekRatio = null;
    }
    if (ev === 'play' || ev === 'playing') playbackStatus = 'playing';
    else if (ev === 'pause' && currentTrack && playbackStatus !== 'stopped') playbackStatus = 'paused';
    emit();
  });
});

audioEl.addEventListener('ended', () => {
  if (repeatOn && currentTrack) {
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
    return;
  }
  if (queue.length > 0 && queueIndex + 1 < queue.length) {
    playAtIndex(queueIndex + 1);
  } else if (queue.length > 1 && shuffleOn) {
    const nextIdx = Math.floor(Math.random() * queue.length);
    playAtIndex(nextIdx);
  } else {
    playbackStatus = 'paused';
    emit();
  }
});

audioEl.addEventListener('error', () => {
  if (!currentTrack || playbackStatus === 'stopped') return;
  playbackStatus = 'error';
  emit();
});

export function getAudioElement() {
  return audioEl;
}

export async function loadLibraryData() {
  try {
    const [likesRes, plRes] = await Promise.all([
      fetch('/api/music/liked', { credentials: 'same-origin' }),
      fetch('/api/music/playlists', { credentials: 'same-origin' })
    ]);
    if (likesRes.ok) {
      const lj = await likesRes.json();
      if (Array.isArray(lj.songs)) likedSongs = lj.songs;
    }
    if (plRes.ok) {
      const pj = await plRes.json();
      if (Array.isArray(pj.playlists)) playlists = pj.playlists;
    }
    emit();
  } catch {}
}

export function setQueueAndPlay(list, idx = 0) {
  queue = Array.isArray(list) ? list.slice() : [];
  playAtIndex(idx);
}

export function playAtIndex(idx) {
  if (!queue.length) return;
  const safeIdx = ((idx % queue.length) + queue.length) % queue.length;
  queueIndex = safeIdx;
  playTrack(queue[safeIdx], false);
}

export function playTrack(track, pushToQueue = true) {
  if (!track || !track.id) return;
  if (pushToQueue) {
    const hit = queue.findIndex((t) => t.id === track.id);
    if (hit === -1) {
      queue = [track, ...queue];
      queueIndex = 0;
    } else {
      queueIndex = hit;
    }
  }
  try { audioEl.pause(); } catch {}
  currentTrack = track;
  pendingSeekRatio = null;
  playbackStatus = 'loading';
  const params = new URLSearchParams({
    title: track.title || '',
    artist: track.artist || ''
  });
  audioEl.src = `/api/music/audio/${encodeURIComponent(track.id)}?${params.toString()}`;
  audioEl.currentTime = 0;
  audioEl.play().catch(() => {});
  emit();
}

export function togglePlayPause() {
  if (!currentTrack) {
    if (queue.length) playAtIndex(0);
    return;
  }
  if (audioEl.paused) {
    audioEl.play().catch(() => {});
  } else {
    audioEl.pause();
  }
}

export function nextTrack() {
  if (!queue.length) return;
  if (shuffleOn && queue.length > 1) {
    let pick = queueIndex;
    while (pick === queueIndex) pick = Math.floor(Math.random() * queue.length);
    playAtIndex(pick);
  } else {
    playAtIndex(queueIndex + 1);
  }
}

export function prevTrack() {
  if (!queue.length) return;
  if (getSafeCurrentTime() > 3) {
    audioEl.currentTime = 0;
    return;
  }
  playAtIndex(queueIndex - 1);
}

export function seekPercent(pct) {
  const ratio = Math.min(1, Math.max(0, Number(pct) / 100));
  const dur = getSafeDuration();
  if (dur > 0) {
    audioEl.currentTime = ratio * dur;
    pendingSeekRatio = null;
  } else {
    pendingSeekRatio = ratio;
  }
  emit();
}

export function setVolume(val) {
  const v = Math.min(1, Math.max(0, Number(val)));
  audioEl.volume = v;
  if (v > 0 && audioEl.muted) audioEl.muted = false;
  emit();
}

export function toggleMute() {
  audioEl.muted = !audioEl.muted;
  emit();
}

export function toggleShuffle() {
  shuffleOn = !shuffleOn;
  emit();
}

export function toggleRepeat() {
  repeatOn = !repeatOn;
  emit();
}

export function stopAndExitMusic() {
  playbackStatus = 'stopped';
  pendingSeekRatio = null;
  try {
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl.load();
  } catch {}
  currentTrack = null;
  playbackStatus = 'idle';
  emit();
}

export function isSongLiked(id) {
  return likedSongs.some((s) => s && s.id === id);
}

export async function toggleLikeSong(song) {
  if (!song || !song.id) return;
  const liked = isSongLiked(song.id);
  const res = await fetch('/api/music/liked', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: liked ? 'remove' : 'add', song })
  });
  if (res.ok) {
    const j = await res.json();
    if (Array.isArray(j.songs)) likedSongs = j.songs;
    emit();
  }
}
