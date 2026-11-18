// Welcome card: greets returning users on boot and offers the tour.
// New users get the tutorial's own hello instead, and anyone who flips
// "Don't show me again" stays quiet. ?welcome=1 forces it for testing.
const NEVER_KEY = 'astra-welcome-never';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function maybeShowWelcome(deps) {
  const { appState, ensureCssLoaded } = deps;
  const forced = new URLSearchParams(location.search).get('welcome') === '1';

  let never = false;
  try { never = localStorage.getItem(NEVER_KEY) === '1'; } catch {}
  // The tutorial already welcomes brand new users, and people who opted out
  // stay opted out. ?welcome=1 ignores both so it can always be tested.
  if (!forced && (never || (appState.user && appState.user.needsTour))) return;
  if (document.querySelector('.welcome-overlay')) return;

  ensureCssLoaded('/css/welcome.css');

  const user = appState.user || {};
  const name = user.displayName || user.username || '';
  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.innerHTML = `
    <div class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle">
      <button type="button" class="welcome-x" aria-label="Close">&#x2715;</button>
      <div class="welcome-orb" aria-hidden="true">
        <span class="welcome-orbit a"></span>
        <span class="welcome-orbit b"></span>
        <span class="welcome-core"></span>
      </div>
      <h1 id="welcomeTitle">${name ? `Hello ${esc(name)}, welcome to astra-v2!` : 'Welcome to astra-v2!'}</h1>
      <p class="welcome-sub">Here's what's new:</p>
      <ul class="welcome-points">
        <li>fresh new look, with customizable wallpapers in settings</li>
        <li>roblox works right in your browser, sign in with your email code</li>
        <li>music keeps playing while you switch tabs</li>
        <li>games, anime, chat and more, all in one place</li>
      </ul>
      <p class="welcome-ask">Want me to show you around?</p>
      <div class="welcome-actions">
        <button type="button" class="welcome-cta" id="welcomeTourBtn">Show me around</button>
        <button type="button" class="welcome-ghost" id="welcomeNoBtn">No thanks</button>
      </div>
      <label class="welcome-never">
        <input type="checkbox" id="welcomeNeverChk" checked />
        <span class="welcome-slider" aria-hidden="true"></span>
        <span>Don't show me again</span>
      </label>
    </div>
  `;

  const close = () => {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 190);
    document.removeEventListener('keydown', onEsc);
  };
  const rememberChoice = () => {
    const chk = overlay.querySelector('#welcomeNeverChk');
    if (chk && chk.checked) {
      try { localStorage.setItem(NEVER_KEY, '1'); } catch {}
    }
  };
  const onEsc = (e) => { if (e.key === 'Escape') { rememberChoice(); close(); } };

  overlay.querySelector('.welcome-x').addEventListener('click', () => { rememberChoice(); close(); });
  overlay.querySelector('#welcomeNoBtn').addEventListener('click', () => { rememberChoice(); close(); });
  overlay.querySelector('#welcomeTourBtn').addEventListener('click', () => {
    // They took the tour, so the hello has done its job either way.
    try { localStorage.setItem(NEVER_KEY, '1'); } catch {}
    close();
    setTimeout(() => window.dispatchEvent(new Event('astra:start-tour')), 230);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { rememberChoice(); close(); } });
  document.addEventListener('keydown', onEsc);

  document.body.appendChild(overlay);
  setTimeout(() => overlay.querySelector('#welcomeTourBtn')?.focus(), 80);
}
