// Lazy-loaded Rewritten Cherri-Style Music Hub (/music) - YouTube Music First
import {
  subscribeMusic, formatTime, setQueueAndPlay, togglePlayPause,
  nextTrack, prevTrack, seekPercent, setVolume, toggleShuffle,
  stopAndExitMusic, isSongLiked, toggleLikeSong, loadLibraryData, getState,
  getAudioElement
} from '/js/music-engine.js';

let homeCatalog = { quickPicks: [], newReleases: [], topHits: [] };
let searchResults = [];
let searchEmpty = false; // a real search ran and returned nothing
let musicTab = 'search'; // search | library | playlist:<id>
let musicSource = 'ytmusic'; // ytmusic | youtube | soundcloud

export async function mount(container, ctx) {
  ctx.ensureCssLoaded('/css/music.css');

  container.innerHTML = `
    <div class="music-shell">
      <div class="music-workspace">
        <aside class="music-subnav">
          <div class="music-subnav-title">Music</div>
          <nav class="music-nav-list">
            <button type="button" class="music-nav-link active" data-mtab="search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <span>Search</span>
            </button>
            <button type="button" class="music-nav-link" data-mtab="library">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              <span>Your Library</span>
            </button>
          </nav>

          <div class="music-playlists-head">Playlists</div>
          <div class="music-playlists-scroll" id="musicPlMount"></div>
          <button type="button" class="btn btn-accent" id="musicNewPlBtn" style="width:100%;height:34px;font-size:12.5px;">+ New Playlist</button>

          <div class="music-subnav-foot">
            <button type="button" class="music-nav-link" id="musicShortcutsBtn" style="width:100%;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h8"/></svg>
              <span>Shortcuts</span>
            </button>
          </div>
        </aside>

        <section class="music-stage" id="musicStageMount"></section>

        <aside class="music-lyrics-pane" id="musicLyricsPane">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:14px;font-weight:700;color:var(--bright-text);">Lyrics</span>
            <button type="button" class="tb-icon-btn" id="musicCloseLyricsBtn">✕</button>
          </div>
          <div class="music-lyrics-scroll" id="musicLyricsMount">
            <div style="font-size:12.5px;color:var(--text-muted);">Play a song to view synced lyrics.</div>
          </div>
        </aside>
      </div>

      <footer class="music-bar">
        <div class="music-np-left">
          <img class="music-np-art" id="mpArt" alt="" />
          <div class="music-np-meta">
            <div class="music-np-title" id="mpTitle">Not playing</div>
            <div class="music-np-artist" id="mpArtist">Select a track from YouTube Music</div>
          </div>
          <button type="button" class="tb-icon-btn" id="mpLikeBtn" title="Like song">♡</button>
        </div>

        <div class="music-np-center">
          <div class="music-ctrls">
            <button type="button" class="tb-icon-btn" id="mpShuffleBtn" title="Shuffle (S)">⇄</button>
            <button type="button" class="tb-icon-btn" id="mpPrevBtn" title="Previous">◀◀</button>
            <button type="button" class="music-play-btn" id="mpPlayBtn" title="Play / Pause">▶</button>
            <button type="button" class="tb-icon-btn" id="mpNextBtn" title="Next">▶▶</button>
          </div>
          <div class="music-prog-row">
            <span id="mpCurTime">0:00</span>
            <input type="range" class="music-range" id="mpSeekBar" min="0" max="100" value="0" />
            <span id="mpDurTime">0:00</span>
          </div>
        </div>

        <div class="music-np-right">
          <button type="button" class="btn" id="mpLyricsBtn" style="height:30px;padding:0 11px;font-size:12px;">Lyrics</button>
          <input type="range" class="music-range" id="mpVolBar" min="0" max="100" value="85" style="max-width:90px;" title="Volume" />
          <button type="button" class="music-exit-pill" id="mpExitBtn" title="Stop &amp; unload track">✕ Exit</button>
        </div>
      </footer>
    </div>
  `;

  const stage = container.querySelector('#musicStageMount');
  const plMount = container.querySelector('#musicPlMount');
  const lyricsPane = container.querySelector('#musicLyricsPane');
  const lyricsMount = container.querySelector('#musicLyricsMount');
  let activeLyricTrackId = '';

  let lyricsLines = []; // parsed {time, endTime, text, words:[{time,endTime,text}]}
  let lyricActiveIdx = -1;

  function renderLyricsDom() {
    lyricsMount.innerHTML = lyricsLines.map((l, i) => {
      const words = (l.words && l.words.length)
        ? l.words.map((w) => `<span class="lyric-word" data-ws="${w.time}" data-we="${w.endTime}">${ctx.escapeHtml(w.text)}</span>`).join(' ')
        : ctx.escapeHtml(l.text || '');
      return `<div class="lyric-line" data-i="${i}" style="--i:${i}">${words}</div>`;
    }).join('');
    lyricActiveIdx = -1;
    // click a line to jump there
    lyricsMount.querySelectorAll('.lyric-line').forEach((el) => {
      el.onclick = () => {
        const st = getState();
        const line = lyricsLines[Number(el.dataset.i)];
        if (line && st.track && st.duration > 0) seekPercent(Math.min(100, (line.time / st.duration) * 100));
      };
    });
  }

  // Word/syllable sweep: words behind the playhead go bright, the word currently
  // being sung glows, the rest stay dim - Apple Music style.
  function syncLyrics(now) {
    if (!lyricsLines.length) return;
    let idx = lyricActiveIdx < 0 ? 0 : lyricActiveIdx;
    while (idx + 1 < lyricsLines.length && lyricsLines[idx + 1].time <= now) idx++;
    while (idx > 0 && lyricsLines[idx].time > now) idx--;
    if (idx !== lyricActiveIdx) {
      lyricActiveIdx = idx;
      const kids = lyricsMount.children;
      for (let i = 0; i < kids.length; i++) {
        kids[i].classList.toggle('active', i === idx);
        kids[i].classList.toggle('past', i < idx);
      }
      const act = kids[idx];
      if (act) {
        const top = act.offsetTop - (lyricsMount.clientHeight - act.offsetHeight) * 0.34;
        lyricsMount.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
    const line = lyricsLines[lyricActiveIdx];
    const act = lyricsMount.children[lyricActiveIdx];
    if (line && line.words && line.words.length && act) {
      const words = act.querySelectorAll('.lyric-word');
      for (let i = 0; i < words.length; i++) {
        const w = line.words[i];
        if (!w) break;
        const el = words[i];
        const sung = now >= w.endTime;
        const singing = !sung && now >= w.time;
        if (el.classList.contains('sung') !== sung) el.classList.toggle('sung', sung);
        if (el.classList.contains('singing') !== singing) el.classList.toggle('singing', singing);
      }
    }
  }

  // Karaoke rides the ~250ms `timeupdate` cadence by default, which reads as a
  // visible lag on word-level sweeps. While the lyrics pane is open and playing,
  // a rAF ticker samples the audio clock per frame instead - highlight timing
  // drops from ~250ms behind to ~16ms.
  let lyricRafId = 0;
  function tickLyricsFrame() {
    lyricRafId = 0;
    const st = getState();
    if (lyricsPane.classList.contains('open') && st.track && !st.paused && lyricsLines.length) {
      const audio = getAudioElement();
      syncLyrics(audio ? audio.currentTime : (st.currentTime || 0));
      lyricRafId = requestAnimationFrame(tickLyricsFrame);
    }
  }
  function ensureLyricTicker() {
    if (!lyricRafId) lyricRafId = requestAnimationFrame(tickLyricsFrame);
  }

  async function loadLyricsFor(track) {
    if (!track || activeLyricTrackId === track.id) return;
    activeLyricTrackId = track.id;
    lyricsLines = [];
    lyricActiveIdx = -1;
    if (track.thumbnail) lyricsPane.style.setProperty('--lyr-art', `url("${String(track.thumbnail).replace(/["\\]/g, '')}")`);
    lyricsMount.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);">Loading lyrics...</div>`;
    try {
      const st = getState();
      const dur = st.track && st.duration > 20 ? Math.round(st.duration) : '';
      const r = await fetch(`/api/music/lyrics?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist)}${dur ? `&duration=${dur}` : ''}`, { credentials: 'same-origin' });
      const j = await r.json();
      if (activeLyricTrackId !== track.id) return; // track changed while fetching
      if (j && j.ok && Array.isArray(j.lines) && j.lines.length) {
        lyricsLines = j.lines;
        renderLyricsDom();
        syncLyrics(getState().currentTime || 0);
      } else if (j && j.plainLyrics) {
        lyricsMount.innerHTML = `<div style="font-size:13px;white-space:pre-line;color:var(--text);">${ctx.escapeHtml(j.plainLyrics)}</div>`;
      } else {
        lyricsMount.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);">No lyrics found for this track.</div>`;
      }
    } catch {
      if (activeLyricTrackId === track.id) lyricsMount.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);">Could not fetch lyrics.</div>`;
    }
  }

  function renderPlaylistsSidebar(st) {
    if (!plMount) return;
    const pls = Array.isArray(st.playlists) ? st.playlists : [];
    if (!pls.length) {
      plMount.innerHTML = `<div class="music-pl-empty">Import Spotify or create a playlist below</div>`;
      return;
    }
    plMount.innerHTML = pls.map((p) => `
      <button type="button" class="music-pl-row ${musicTab === 'playlist:' + p.id ? 'active' : ''}" data-open-pl="${ctx.escapeHtml(p.id)}">
        <img class="music-pl-thumb" src="${ctx.escapeHtml(p.coverUrl || '/assets/astra-logo.png')}" alt="" />
        <div style="min-width:0;">
          <div class="music-pl-name">${ctx.escapeHtml(p.name)}</div>
          <div class="music-pl-count">${(p.songs || []).length} tracks</div>
        </div>
      </button>
    `).join('');
    plMount.querySelectorAll('[data-open-pl]').forEach((b) => {
      b.onclick = () => {
        musicTab = 'playlist:' + b.dataset.openPl;
        renderNavHighlight();
        renderMainStage(getState());
      };
    });
  }

  function renderNavHighlight() {
    container.querySelectorAll('[data-mtab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mtab === musicTab);
    });
  }

  function renderCarousel(title, list) {
    if (!list || !list.length) return '';
    return `
      <div class="music-shelf">
        <div class="music-shelf-head">
          <h3 class="music-shelf-title">${ctx.escapeHtml(title)}</h3>
        </div>
        <div class="music-carousel">
          ${list.map((s, idx) => {
            const st = getState();
            const isCur = st.track && st.track.id === s.id;
            return `
              <div class="music-card ${isCur ? 'playing' : ''}" data-play-shelf="${ctx.escapeHtml(title)}" data-idx="${idx}">
                <div class="music-card-art-wrap">
                  <img class="music-card-art" src="${ctx.escapeHtml(s.thumbnail)}" loading="lazy" alt="" />
                  <button type="button" class="music-card-play">${isCur && !st.paused ? '⏸' : '▶'}</button>
                </div>
                <div class="music-card-title">${ctx.escapeHtml(s.title)}</div>
                <div class="music-card-artist">${ctx.escapeHtml(s.artist)}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderRows(list, emptyMsg) {
    if (!list || !list.length) {
      return `<div style="padding:28px;text-align:center;color:var(--text-muted);font-size:13px;">${ctx.escapeHtml(emptyMsg)}</div>`;
    }
    const st = getState();
    return `<div class="music-rows">` + list.map((s, idx) => {
      const isCur = st.track && st.track.id === s.id;
      const liked = isSongLiked(s.id);
      return `
        <div class="music-row ${isCur ? 'playing' : ''}" data-row-idx="${idx}">
          <img class="music-row-art" src="${ctx.escapeHtml(s.thumbnail)}" loading="lazy" alt="" />
          <div class="music-row-meta">
            <div class="music-row-title">${ctx.escapeHtml(s.title)}</div>
            <div class="music-row-artist">${ctx.escapeHtml(s.artist)}</div>
          </div>
          <span class="music-row-dur">${ctx.escapeHtml(s.duration || '')}</span>
          <button type="button" class="tb-icon-btn" data-like-idx="${idx}" style="color:${liked ? 'var(--accent)' : 'var(--text-muted)'};">${liked ? '♥' : '♡'}</button>
          <span style="font-size:12px;color:var(--text-muted);">${isCur && !st.paused ? '⏸' : '▶'}</span>
        </div>
      `;
    }).join('') + `</div>`;
  }

  async function runSearch(query) {
    const q = String(query || '').trim();
    if (!q) return;
    stage.querySelector('#msMount')?.replaceChildren();
    const mount = stage.querySelector('#msMount');
    if (mount) mount.innerHTML = `<div style="padding:28px;color:var(--text-muted);font-size:13px;">Searching ${ctx.escapeHtml(musicSource === 'ytmusic' ? 'YouTube Music' : musicSource)} for "${ctx.escapeHtml(q)}"...</div>`;
    try {
      const r = await fetch(`/api/music/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(musicSource)}`, { credentials: 'same-origin' });
      const j = await r.json();
      searchResults = (r.ok && j && Array.isArray(j.results)) ? j.results : [];
      searchEmpty = searchResults.length === 0;
      if (musicTab === 'search') renderMainStage(getState(), q);
    } catch {
      searchResults = [];
      searchEmpty = true;
      if (musicTab === 'search') renderMainStage(getState(), q);
    }
  }

  function renderMainStage(st, lastSearchQuery = '') {
    if (musicTab === 'search') {
      const hasResults = searchResults.length > 0;
      const shelvesLoaded = homeCatalog.quickPicks.length || homeCatalog.topHits.length;
      const shelves = (!hasResults && !searchEmpty && shelvesLoaded)
        ? renderCarousel('Quick Picks', homeCatalog.quickPicks) +
          renderCarousel('New Releases', homeCatalog.newReleases) +
          renderCarousel('Top Hits', homeCatalog.topHits)
        : '';
      stage.innerHTML = `
        <h1 class="music-stage-title">Search</h1>
        <form class="music-search-row" id="msForm">
          <div class="music-search-box">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="msInput" type="text" placeholder="What do you want to listen to?" value="${ctx.escapeHtml(lastSearchQuery)}" autocomplete="off" />
          </div>
          <select class="music-source-select" id="msSource">
            <option value="ytmusic" ${musicSource === 'ytmusic' ? 'selected' : ''}>YouTube Music</option>
            <option value="youtube" ${musicSource === 'youtube' ? 'selected' : ''}>YouTube</option>
            <option value="soundcloud" ${musicSource === 'soundcloud' ? 'selected' : ''}>SoundCloud</option>
          </select>
          <button type="submit" class="btn btn-accent">Search</button>
        </form>
        <div class="music-chips">
          ${['Top Hits', 'Kendrick Lamar', 'The Weeknd', 'Sabrina Carpenter', 'Playboi Carti', 'Lofi Beats', 'Bad Bunny', 'Phonk'].map((c) => `
            <button type="button" class="music-chip" data-chip-q="${ctx.escapeHtml(c)}">${ctx.escapeHtml(c)}</button>
          `).join('')}
        </div>
        <div id="msMount">
          ${(hasResults || searchEmpty)
            ? renderRows(searchResults, 'No results found. Try another search.')
            : (shelves || `<div style="padding:28px;color:var(--text-muted);font-size:13px;">Loading shelves...</div>`)}
        </div>
      `;
      stage.querySelector('#msForm').onsubmit = (e) => {
        e.preventDefault();
        runSearch(stage.querySelector('#msInput').value);
      };
      stage.querySelector('#msSource').onchange = (e) => {
        musicSource = e.target.value;
        const q = stage.querySelector('#msInput').value.trim();
        if (q) runSearch(q);
      };
      stage.querySelectorAll('[data-chip-q]').forEach((b) => {
        b.onclick = () => {
          stage.querySelector('#msInput').value = b.dataset.chipQ;
          runSearch(b.dataset.chipQ);
        };
      });
      stage.querySelectorAll('[data-row-idx]').forEach((row) => {
        row.onclick = (e) => {
          const likeBtn = e.target.closest('[data-like-idx]');
          const idx = Number(row.dataset.rowIdx);
          if (likeBtn) {
            e.stopPropagation();
            toggleLikeSong(searchResults[idx]);
            return;
          }
          setQueueAndPlay(searchResults, idx);
        };
      });
      stage.querySelectorAll('[data-play-shelf]').forEach((card) => {
        card.onclick = () => {
          const sh = card.dataset.playShelf;
          const arr = sh === 'Quick Picks' ? homeCatalog.quickPicks : (sh === 'New Releases' ? homeCatalog.newReleases : homeCatalog.topHits);
          setQueueAndPlay(arr, Number(card.dataset.idx));
        };
      });
      return;
    }

    if (musicTab === 'library') {
      const list = st.likedSongs || [];
      stage.innerHTML = `
        <h1 class="music-stage-title">Your Library</h1>
        <div style="font-size:13px;color:var(--text-muted);">${list.length} liked songs</div>
        ${renderRows(list, 'Heart any track to save it to Your Library.')}
      `;
      stage.querySelectorAll('[data-row-idx]').forEach((row) => {
        row.onclick = (e) => {
          const likeBtn = e.target.closest('[data-like-idx]');
          const idx = Number(row.dataset.rowIdx);
          if (likeBtn) { e.stopPropagation(); toggleLikeSong(list[idx]); return; }
          setQueueAndPlay(list, idx);
        };
      });
      return;
    }

    if (musicTab.startsWith('playlist:')) {
      const pid = musicTab.slice('playlist:'.length);
      const pl = (st.playlists || []).find((x) => x.id === pid);
      const list = (pl && pl.songs) || [];
      stage.innerHTML = `
        <div class="music-stage-head">
          <div>
            <h1 class="music-stage-title">${ctx.escapeHtml(pl ? pl.name : 'Playlist')}</h1>
            <div style="font-size:12.5px;color:var(--text-muted);">${list.length} songs</div>
          </div>
          ${list.length ? `<button type="button" class="btn btn-accent" id="playPlAllBtn">Play All</button>` : ''}
        </div>
        ${renderRows(list, 'No songs in this playlist.')}
      `;
      stage.querySelector('#playPlAllBtn')?.addEventListener('click', () => setQueueAndPlay(list, 0));
      stage.querySelectorAll('[data-row-idx]').forEach((row) => {
        row.onclick = () => setQueueAndPlay(list, Number(row.dataset.rowIdx));
      });
    }
  }

  // Subscribe to persistent audio state cleanly
  const unsub = subscribeMusic((st) => {
    const titleEl = container.querySelector('#mpTitle');
    const artEl = container.querySelector('#mpArt');
    const artistEl = container.querySelector('#mpArtist');
    const playBtn = container.querySelector('#mpPlayBtn');
    const curEl = container.querySelector('#mpCurTime');
    const durEl = container.querySelector('#mpDurTime');
    const seekBar = container.querySelector('#mpSeekBar');
    const likeBtn = container.querySelector('#mpLikeBtn');
    const exitBtn = container.querySelector('#mpExitBtn');
    const shufBtn = container.querySelector('#mpShuffleBtn');

    if (titleEl) titleEl.textContent = st.track ? st.track.title : 'Not playing';
    if (artistEl) artistEl.textContent = st.track ? st.track.artist : 'Select a track from YouTube Music';
    if (artEl) {
      artEl.src = st.track?.thumbnail || '/assets/astra-logo.png';
      artEl.style.opacity = st.track ? '1' : '0.35';
    }
    if (playBtn) playBtn.textContent = (!st.track || st.paused) ? '▶' : '⏸';
    if (curEl) curEl.textContent = st.track ? formatTime(st.currentTime) : '0:00';
    if (durEl) durEl.textContent = st.track ? formatTime(st.duration) : '0:00';
    if (seekBar) seekBar.value = st.track ? String(Math.round(st.progressPct)) : '0';
    if (likeBtn) {
      const liked = st.track && isSongLiked(st.track.id);
      likeBtn.textContent = liked ? '♥' : '♡';
      likeBtn.style.color = liked ? 'var(--accent)' : 'var(--text-muted)';
    }
    if (exitBtn) exitBtn.style.display = st.track ? 'inline-flex' : 'none';
    if (shufBtn) shufBtn.style.color = st.shuffleOn ? 'var(--accent)' : 'var(--text-muted)';

    renderPlaylistsSidebar(st);
    if (lyricsPane.classList.contains('open') && st.track) {
      loadLyricsFor(st.track);
      syncLyrics(st.currentTime || 0);
      ensureLyricTicker();
    }
  });

  // Nav & Controls
  container.querySelectorAll('[data-mtab]').forEach((b) => {
    b.onclick = () => {
      musicTab = b.dataset.mtab;
      renderNavHighlight();
      renderMainStage(getState());
    };
  });
  container.querySelector('#mpPlayBtn').onclick = () => togglePlayPause();
  container.querySelector('#mpNextBtn').onclick = () => nextTrack();
  container.querySelector('#mpPrevBtn').onclick = () => prevTrack();
  container.querySelector('#mpShuffleBtn').onclick = () => toggleShuffle();
  container.querySelector('#mpExitBtn').onclick = () => stopAndExitMusic();
  container.querySelector('#mpSeekBar').oninput = (e) => seekPercent(e.target.value);
  container.querySelector('#mpVolBar').oninput = (e) => setVolume(Number(e.target.value) / 100);
  container.querySelector('#mpLikeBtn').onclick = () => {
    const tr = getState().track;
    if (tr) toggleLikeSong(tr);
  };
  container.querySelector('#mpLyricsBtn').onclick = () => {
    lyricsPane.classList.toggle('open');
    const tr = getState().track;
    if (lyricsPane.classList.contains('open')) {
      if (tr?.thumbnail) lyricsPane.style.setProperty('--lyr-art', `url("${String(tr.thumbnail).replace(/["\\]/g, '')}")`);
      if (tr) {
        loadLyricsFor(tr);
        syncLyrics(getState().currentTime || 0);
        ensureLyricTicker();
      }
    }
  };
  container.querySelector('#musicCloseLyricsBtn').onclick = () => lyricsPane.classList.remove('open');

  // New Playlist / Spotify Import Modal
  container.querySelector('#musicNewPlBtn').onclick = () => {
    ctx.openModal(`
      <div class="modal-head"><span>Import Spotify Playlist</span><button type="button" class="tb-icon-btn" id="mClose">✕</button></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <label style="font-size:12px;color:var(--text-muted);">Public Spotify Playlist URL</label>
        <input class="field-input" id="spUrlInput" placeholder="https://open.spotify.com/playlist/..." />
        <label style="font-size:12px;color:var(--text-muted);">Custom Name (optional)</label>
        <input class="field-input" id="spNameInput" placeholder="My Playlist" />
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button type="button" class="btn" id="mCancel">Cancel</button>
        <button type="button" class="btn btn-accent" id="mImport">Import</button>
      </div>
    `, (card) => {
      card.querySelector('#mClose').onclick = ctx.closeModal;
      card.querySelector('#mCancel').onclick = ctx.closeModal;
      card.querySelector('#mImport').onclick = async () => {
        const url = card.querySelector('#spUrlInput').value.trim();
        const customName = card.querySelector('#spNameInput').value.trim();
        if (!url) return ctx.showToast('Paste a Spotify link first');
        card.querySelector('#mImport').textContent = 'Importing...';
        const r = await fetch('/api/music/import-spotify', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, customName })
        });
        const j = await r.json();
        if (!r.ok || !j.ok) return ctx.showToast(j.error || 'Import failed');
        await loadLibraryData();
        ctx.closeModal();
        ctx.showToast(`Imported "${j.playlist.name}"!`);
      };
    });
  };

  container.querySelector('#musicShortcutsBtn').onclick = () => {
    ctx.openModal(`
      <div class="modal-head"><span>Keyboard Shortcuts</span><button type="button" class="tb-icon-btn" id="mClose">✕</button></div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">
        <div style="display:flex;justify-content:space-between;"><span>Play / Pause</span><span class="badge-pill">Space</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Next Track</span><span class="badge-pill">Shift + →</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Previous Track</span><span class="badge-pill">Shift + ←</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Toggle Lyrics</span><span class="badge-pill">L</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Stop &amp; Exit Music</span><span class="badge-pill">✕ Exit</span></div>
      </div>
    `, (card) => { card.querySelector('#mClose').onclick = ctx.closeModal; });
  };

  renderMainStage(getState());
  if (!homeCatalog.quickPicks.length) {
    fetch('/api/music/home', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok) {
          homeCatalog = { quickPicks: j.quickPicks || [], newReleases: j.newReleases || [], topHits: j.topHits || [] };
          if (musicTab === 'search' && !searchResults.length && !searchEmpty) renderMainStage(getState());
        }
      }).catch(() => {});
  }

  return () => {
    unsub();
  };
}
