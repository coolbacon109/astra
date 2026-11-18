// Lazy-loaded Browse View (/b): Scramjet-Primary + Automatic Scramjet <-> Ultraviolet Fallback
import { navigateFrameWithFallback, decodeProxyClientUrl, syncRobloxSession } from '/js/proxy-engine.js';

// One global browser frame: keep a single watcher across remounts so the omnibox
// line keeps tracking in-site navigation (link clicks, SPA pushState, redirects).
let frameWatchTimer = null;
let lastWatchedHref = '';

export function mountBrowse({ frame, url, forceReload, engineOverride, onTabMeta }) {
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
    if (st.loading && frame.classList.contains('frame-loaded')) frame.classList.remove('frame-loaded');
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
    frame.classList.add('frame-loaded');
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
