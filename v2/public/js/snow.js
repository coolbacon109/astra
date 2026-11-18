// Astra Winter Snowfall - one lightweight canvas layer inside #bgStage.
// ~50-90 flakes, DPR-aware, auto-pauses when the tab is hidden, and respects
// prefers-reduced-motion. Zero dependencies, no layout thrash (transform-free 2D fill).

export function startSnowfall() {
  const stage = document.getElementById('bgStage');
  if (!stage || stage.querySelector('.snow-canvas')) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'snow-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  let flakes = [];
  let rafId = 0;
  let running = true;
  let last = performance.now();

  function makeFlake(fromTop) {
    return {
      x: Math.random() * w,
      y: fromTop ? -10 - Math.random() * 20 : Math.random() * h,
      r: 0.9 + Math.random() * 2.2,
      a: 0.22 + Math.random() * 0.58,
      vy: 16 + Math.random() * 46,          // px per second
      vx: -10 + Math.random() * 24,         // horizontal drift
      swayAmp: 8 + Math.random() * 16,
      phase: Math.random() * Math.PI * 2,
      swayFreq: 0.4 + Math.random() * 0.9
    };
  }

  function resize() {
    w = stage.clientWidth;
    h = stage.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(90, Math.max(48, (w * h) / 24000)));
    flakes = Array.from({ length: count }, () => makeFlake(false));
  }

  function tick(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    for (const f of flakes) {
      f.phase += f.swayFreq * dt;
      f.y += f.vy * dt;
      f.x += (f.vx + Math.sin(f.phase) * f.swayAmp) * dt;
      if (f.y > h + 12) Object.assign(f, makeFlake(true));
      if (f.x < -14) f.x = w + 12;
      else if (f.x > w + 14) f.x = -12;
      ctx.globalAlpha = f.a * (0.72 + 0.28 * Math.sin(f.phase * 2));
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    rafId = requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(rafId);
    } else if (!running) {
      running = true;
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  });

  rafId = requestAnimationFrame(tick);
}
