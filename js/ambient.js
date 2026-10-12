// Ambient life: orb-webs strung across the screen corners and little spiders crawling along the
// edges (and one dangling on a thread). Purely decorative - it makes the scene feel alive and
// reacts to the game: spiders scurry away whenever a web is fired.

const TAU = Math.PI * 2;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- spider drawing -------------------------------------------------------------------------
// Forward is +x after the rotation. `phase` drives the walking gait (alternating tetrapod).
function drawSpider(ctx, x, y, angle, size, phase, speedFactor) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // soft drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(size * 0.15, size * 0.35, size * 1.5, size * 0.8, 0, 0, TAU);
  ctx.fill();

  const spread = [0.62, 1.2, 1.9, 2.5]; // leg angle from forward axis, radians
  const hipX = [0.5, 0.22, -0.08, -0.36];
  const reach = size * 1.85;
  const stride = size * 0.38 * Math.min(1, speedFactor);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass === 0 ? '#06090d' : '#2b3a49';
    ctx.lineWidth = pass === 0 ? size * 0.2 : size * 0.07;
    for (const side of [-1, 1]) {
      for (let j = 0; j < 4; j++) {
        const ph = phase + ((j + (side > 0 ? 0 : 1)) % 2) * Math.PI;
        const lift = Math.cos(ph) > 0 ? 1 : 0;
        const a = spread[j] * side;
        const hx = hipX[j] * size, hy = side * size * 0.14;
        let fx = hx + Math.cos(a) * reach * (lift ? 0.88 : 1);
        let fy = hy + Math.sin(a) * reach * (lift ? 0.88 : 1);
        fx += Math.sin(ph) * stride;
        const mx = (hx + fx) / 2, my = (hy + fy) / 2;
        // knee bows outward and a little toward the direction of travel
        const kx = mx + Math.sin(ph) * stride * 0.3;
        const ky = my + side * size * (0.55 + lift * 0.25);
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(kx, ky);
        ctx.lineTo(fx, fy);
        ctx.stroke();
      }
    }
  }

  // abdomen with a red hourglass mark
  const ab = ctx.createRadialGradient(-size * 0.7, -size * 0.2, size * 0.1, -size * 0.55, 0, size * 0.85);
  ab.addColorStop(0, '#3b4b5c');
  ab.addColorStop(0.45, '#10161e');
  ab.addColorStop(1, '#05070a');
  ctx.fillStyle = ab;
  ctx.beginPath();
  ctx.ellipse(-size * 0.62, 0, size * 0.82, size * 0.62, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ff3355';
  ctx.shadowColor = '#ff3355';
  ctx.shadowBlur = size * 0.6;
  ctx.beginPath();
  ctx.moveTo(-size * 0.95, -size * 0.2);
  ctx.lineTo(-size * 0.3, -size * 0.05);
  ctx.lineTo(-size * 0.3, size * 0.05);
  ctx.lineTo(-size * 0.95, size * 0.2);
  ctx.lineTo(-size * 0.7, 0);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;

  // thorax + head
  ctx.fillStyle = '#10161e';
  ctx.beginPath();
  ctx.ellipse(size * 0.18, 0, size * 0.5, size * 0.38, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#1a232d';
  ctx.beginPath();
  ctx.arc(size * 0.66, 0, size * 0.24, 0, TAU);
  ctx.fill();

  // glowing eyes
  ctx.fillStyle = '#7ff3ff';
  ctx.shadowColor = '#66f6ff';
  ctx.shadowBlur = size * 0.5;
  ctx.beginPath();
  ctx.arc(size * 0.8, -size * 0.1, size * 0.06, 0, TAU);
  ctx.arc(size * 0.8, size * 0.1, size * 0.06, 0, TAU);
  ctx.fill();

  ctx.restore();
}

// ---- corner web -----------------------------------------------------------------------------
// (cx,cy) is the corner; (sx,sy) = +/-1 point into the screen.
function drawCornerWeb(ctx, cx, cy, sx, sy, R, now, web) {
  const sway = 1 + Math.sin(now * 0.0011 + web.seed) * 0.012;
  const rad = R * sway;
  const n = web.spokes.length;
  const pt = (ang, r) => ({ x: cx + sx * Math.cos(ang) * r, y: cy + sy * Math.sin(ang) * r });

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // frame threads along both screen edges
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (const ang of [web.spokes[0], web.spokes[n - 1]]) {
    const e = pt(ang, rad * 1.0);
    ctx.moveTo(cx, cy);
    ctx.lineTo(e.x, e.y);
  }
  ctx.stroke();

  // radial spokes
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  for (let i = 1; i < n - 1; i++) {
    const e = pt(web.spokes[i], rad * web.len[i]);
    ctx.moveTo(cx, cy);
    ctx.lineTo(e.x, e.y);
  }
  ctx.stroke();

  // sagging spiral rings
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 0.8;
  for (let ring = 0; ring < web.rings.length; ring++) {
    const rr = rad * web.rings[ring];
    ctx.beginPath();
    for (let i = 0; i < n - 1; i++) {
      const a0 = web.spokes[i], a1 = web.spokes[i + 1];
      const r0 = rr * web.len[i], r1 = rr * web.len[i + 1];
      const am = (a0 + a1) / 2;
      const p0 = pt(a0, r0), p1 = pt(a1, r1);
      const c = pt(am, ((r0 + r1) / 2) * (0.86 - web.sag[ring] * 0.1));
      if (i === 0) ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(c.x, c.y, p1.x, p1.y);
    }
    ctx.stroke();
  }

  // dew drops catching the light
  for (let k = 0; k < web.dew.length; k++) {
    const d = web.dew[k];
    const p = pt(web.spokes[d.s], rad * web.rings[d.r] * web.len[d.s]);
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(now * 0.002 + d.p));
    ctx.fillStyle = `rgba(215, 245, 255, ${0.25 + tw * 0.55})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1 + tw * 0.9, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function makeWeb(seed) {
  const rnd = mulberry32(seed);
  const n = 7;
  const spokes = [];
  for (let i = 0; i < n; i++) spokes.push((i / (n - 1)) * (Math.PI / 2));
  const len = spokes.map((_, i) => (i === 0 || i === n - 1 ? 1 : 0.8 + rnd() * 0.22));
  const rings = [0.18, 0.34, 0.52, 0.72, 0.92];
  const sag = rings.map(() => rnd());
  const dew = [];
  for (let k = 0; k < 7; k++) {
    dew.push({ s: 1 + Math.floor(rnd() * (n - 2)), r: Math.floor(rnd() * rings.length), p: rnd() * TAU });
  }
  return { seed: rnd() * TAU, spokes, len, rings, sag, dew };
}

// ---- the ambient scene ----------------------------------------------------------------------
export class AmbientLife {
  constructor() {
    this.webs = [makeWeb(11), makeWeb(23), makeWeb(37), makeWeb(53)];
    this.lastNow = 0;
    this.scareUntil = 0;
    this.scareStart = 0;

    // crawlers walk back and forth along lanes hugging the screen edges
    this.crawlers = [
      { lane: (w, h) => [18, h * 0.22, 18, h * 0.78], s: 0.3, dir: 1, speed: 26, pause: 0, phase: 0, trail: [], trailT: 0, scale: 1 },
      { lane: (w, h) => [w - 18, h * 0.76, w - 18, h * 0.24], s: 0.6, dir: 1, speed: 22, pause: 1.2, phase: 2, trail: [], trailT: 0, scale: 0.9 },
      { lane: (w) => [w * 0.3, 16, w * 0.7, 16], s: 0.2, dir: 1, speed: 20, pause: 0, phase: 4, trail: [], trailT: 0, scale: 0.85 },
    ];
    this.dangler = { x: 0.64, offset: Math.random() * 12, phase: 0 };
  }

  scare(now) {
    this.scareStart = now;
    this.scareUntil = now + 1400;
  }

  _scareFactor(now) {
    if (now >= this.scareUntil) return 0;
    return 1 - (now - this.scareStart) / (this.scareUntil - this.scareStart);
  }

  draw(ctx, w, h, now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - (this.lastNow || now)) / 1000));
    this.lastNow = now;
    const scare = this._scareFactor(now);
    const base = Math.max(8, Math.min(13, Math.min(w, h) * 0.022));

    // corner webs
    const R = Math.max(110, Math.min(250, Math.min(w, h) * 0.3));
    drawCornerWeb(ctx, 0, 0, 1, 1, R, now, this.webs[0]);
    drawCornerWeb(ctx, w, 0, -1, 1, R, now, this.webs[1]);
    drawCornerWeb(ctx, 0, h, 1, -1, R * 0.85, now, this.webs[2]);
    drawCornerWeb(ctx, w, h, -1, -1, R * 0.85, now, this.webs[3]);

    // crawlers (with a fading silk trail)
    for (const c of this.crawlers) {
      const [ax, ay, bx, by] = c.lane(w, h);
      const laneLen = Math.hypot(bx - ax, by - ay) || 1;
      const boost = 1 + scare * 4.5;
      if (c.pause > 0) {
        c.pause -= dt;
      } else {
        c.s += (c.dir * c.speed * boost * dt) / laneLen;
        if (c.s >= 1 || c.s <= 0) {
          c.s = Math.max(0, Math.min(1, c.s));
          c.dir *= -1;
          c.pause = 0.8 + Math.random() * 2.2;
        } else if (!scare && Math.random() < dt * 0.1) {
          c.pause = 0.6 + Math.random() * 1.8;
        }
      }
      const moving = c.pause <= 0;
      c.phase += dt * (moving ? 13 * boost * 0.5 : 1.2);
      const ux = (bx - ax) / laneLen, uy = (by - ay) / laneLen;
      const wob = Math.sin(c.s * laneLen * 0.04) * 2.5;
      const x = ax + (bx - ax) * c.s - uy * wob;
      const y = ay + (by - ay) * c.s + ux * wob;
      const ang = Math.atan2(uy * c.dir, ux * c.dir);

      c.trailT += dt;
      if (moving && c.trailT > 0.05) {
        c.trailT = 0;
        c.trail.push({ x, y });
        if (c.trail.length > 16) c.trail.shift();
      } else if (!moving && c.trail.length && c.trailT > 0.12) {
        c.trailT = 0;
        c.trail.shift();
      }
      if (c.trail.length > 1) {
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 1; i < c.trail.length; i++) {
          ctx.strokeStyle = `rgba(255,255,255,${(i / c.trail.length) * 0.35})`;
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(c.trail[i - 1].x, c.trail[i - 1].y);
          ctx.lineTo(c.trail[i].x, c.trail[i].y);
          ctx.stroke();
        }
        ctx.restore();
      }
      drawSpider(ctx, x, y, ang, base * c.scale, c.phase, moving ? 1 : 0.15);
    }

    // dangler: abseils down a silk thread from the top edge, hangs, climbs back up
    const d = this.dangler;
    const maxLen = h * 0.2;
    const t = ((now / 1000 + d.offset) % 14);
    let k;
    if (t < 4) { const q = t / 4; k = q * q * (3 - 2 * q); }
    else if (t < 7) k = 1;
    else if (t < 11) { const q = (t - 7) / 4; k = 1 - q * q * (3 - 2 * q); }
    else k = 0;
    const len = 26 + (maxLen - 26) * k * (1 - scare);
    const moving = (t < 4 || (t >= 7 && t < 11)) || scare > 0;
    d.phase += dt * (moving ? 10 : 1.5);
    const swayX = Math.sin(now * 0.0013) * 4 * (0.3 + k);
    const dx = d.x * w + swayX;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(d.x * w, 0);
    ctx.lineTo(dx, len);
    ctx.stroke();
    ctx.restore();
    drawSpider(ctx, dx, len + base * 0.5, Math.PI / 2, base * 0.8, d.phase, moving ? 0.6 : 0.1);
  }
}
