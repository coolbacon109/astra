// Lazy-loaded Browse View (/b): Scramjet-Primary + Automatic Scramjet <-> Ultraviolet Fallback
import { navigateFrameWithFallback, decodeProxyClientUrl, syncRobloxSession } from '/js/proxy-engine.js';

// One global browser frame: keep a single watcher across remounts so the omnibox
// line keeps tracking in-site navigation (link clicks, SPA pushState, redirects).
let frameWatchTimer = null;
let lastWatchedHref = '';

// The frame is visible unless it is hidden on purpose. It is only hidden while
// a new page is on its way, and a timer always brings it back, so a missed event
// can never leave an empty area on screen.
let revealTimer = null;

function hideFrame(frame) {
  frame.classList.add('frame-hidden');
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => frame.classList.remove('frame-hidden'), 12000);
}

function revealFrame(frame) {
  clearTimeout(revealTimer);
  frame.classList.remove('frame-hidden');
}

let frameFadeBound = false;
function bindFrameFade(frame) {
  if (frameFadeBound) return;
  frameFadeBound = true;
  frame.addEventListener('load', () => {
    let href = '';
    try { href = frame.contentWindow?.location?.href || ''; } catch { href = ''; }
    // A blank reset while switching engines is not a page.
    if (!href || href === 'about:blank') return;
    revealFrame(frame);
  });
}

export function mountBrowse({ frame, url, forceReload, engineOverride, onTabMeta }) {
  bindFrameFade(frame);
  const bar = document.getElementById('browseLoadingBar');
  const banner = document.getElementById('browseStatusBanner');
  const statusText = document.getElementById('browseStatusText');
  const switchNowBtn = document.getElementById('browseSwitchNowBtn');

  if (frameWatchTimer) { clearInterval(frameWatchTimer); frameWatchTimer = null; }
  lastWatchedHref = '';

  if (switchNowBtn) {
    switchNowBtn.onclick = () => {
      const curEng = frame.dataset.loadedEngine || 'scramjet';
      const alt = curEng === 'scramjet' ? 'ultraviolet' : 'scramjet';
      navigateFrameWithFallback(frame, url, {
        forceReload: true,
        engineOverride: alt,
        onStatus: handleStatus,
        onLoaded: handleLoaded
      });
    };
  }

  function handleStatus(st) {
    if (!st.loading) revealFrame(frame);
    if (bar) {
      bar.classList.toggle('active', !!st.loading);
      bar.style.width = st.loading ? '68%' : '100%';
      if (!st.loading) setTimeout(() => { bar.style.width = '0%'; }, 250);
    }
    if (banner && statusText) {
      banner.classList.toggle('visible', !!st.loading && !frame.dataset.hasRendered);
      statusText.textContent = st.text || `Connecting via ${st.engine || 'scramjet'}...`;
    }
    if (onTabMeta) onTabMeta({ loading: !!st.loading, engine: st.engine });
  }

  function handleLoaded(info) {
    frame.dataset.hasRendered = '1';
    revealFrame(frame);
    if (banner) banner.classList.remove('visible');
    if (bar) {
      bar.classList.remove('active');
      bar.style.width = '0%';
    }
    if (onTabMeta) onTabMeta({ url: info.url, engine: info.engine, title: info.title, loading: false });
  }

  // The proxied frame is same-origin (served under /scramjet/), so poll its real
  // location and title; this keeps the omnibox line live as the user browses.
  frameWatchTimer = setInterval(() => {
    let href = '';
    let title = '';
    try {
      href = frame.contentWindow?.location?.href || '';
      title = frame.contentDocument?.title || '';
    } catch {
      return;
    }
    if (!href || href === 'about:blank' || href === lastWatchedHref) return;
    lastWatchedHref = href;
    const real = decodeProxyClientUrl(href);
    if (onTabMeta) onTabMeta({ url: /^https?:\/\//i.test(real) ? real : href, title, loading: false });
  }, 900);

  if (forceReload) delete frame.dataset.hasRendered;
  hideFrame(frame);
  syncRobloxSession();
  navigateFrameWithFallback(frame, url, {
    forceReload,
    engineOverride,
    onStatus: handleStatus,
    onLoaded: handleLoaded
  });

  return () => {
    if (frameWatchTimer) { clearInterval(frameWatchTimer); frameWatchTimer = null; }
  };
}
