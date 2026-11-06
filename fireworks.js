// A few seconds of fireworks over the page, for a perfect quiz score.
// Skipped when the student has asked for reduced motion.

const COLORS = ["#ff5d5d", "#ffb13b", "#ffe156", "#5cd68f", "#5ab8ff", "#a77bff", "#ff7ad9"];
const DURATION = 3500;
const GRAVITY = 0.06;

export function fireworks() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.createElement("canvas");
  canvas.className = "fireworks";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const scale = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * scale;
  canvas.height = height * scale;
  ctx.scale(scale, scale);

  const rockets = [];
  const sparks = [];
  const start = performance.now();
  let nextLaunch = 0;

  function launch() {
    rockets.push({
      x: width * (0.15 + Math.random() * 0.7),
      y: height,
      vy: -(height / 75) * (0.8 + Math.random() * 0.3),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    });
  }

  function burst(r) {
    const count = 60 + Math.floor(Math.random() * 30);
    const speed = 2 + Math.random() * 2;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const v = speed * (0.6 + Math.random() * 0.4);
      sparks.push({ x: r.x, y: r.y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, life: 1, color: r.color });
    }
  }

  function frame(now) {
    const elapsed = now - start;
    if (elapsed < DURATION - 1200 && elapsed >= nextLaunch) {
      launch();
      nextLaunch = elapsed + 250 + Math.random() * 300;
    }
    ctx.clearRect(0, 0, width, height);

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.y += r.vy;
      r.vy += GRAVITY;
      ctx.fillStyle = r.color;
      ctx.fillRect(r.x - 1.5, r.y - 4, 3, 8);
      // Burst near the top of the climb.
      if (r.vy > -1.5) {
        burst(r);
        rockets.splice(i, 1);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vx *= 0.98;
      s.vy = s.vy * 0.98 + GRAVITY;
      s.life -= 0.015;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = s.life;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (elapsed < DURATION || rockets.length || sparks.length) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}
