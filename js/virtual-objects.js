// Virtual (synthetic) targets: glossy procedurally-drawn objects floating in the scene.
// They behave exactly like detected objects (aim, lock, shoot, reel) but are always reliable,
// so they make a great training mode for newcomers and a fallback when the room has nothing to grab.

const KINDS = [
  { kind: 'orb', heavy: false, size: 0.15 },
  { kind: 'cube', heavy: false, size: 0.16 },
  { kind: 'crystal', heavy: false, size: 0.17 },
  { kind: 'canister', heavy: false, size: 0.17 },
  { kind: 'crate', heavy: true, size: 0.27 },
];

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function paintOrb(g, S) {
  const c = S / 2, r = S * 0.44;
  const body = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
  body.addColorStop(0, '#ffe7ea');
  body.addColorStop(0.25, '#ff5b78');
  body.addColorStop(0.7, '#a3112b');
  body.addColorStop(1, '#3a0510');
  g.fillStyle = body;
  g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = S * 0.012;
  g.beginPath(); g.ellipse(c, c, r, r * 0.32, -0.35, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.beginPath(); g.ellipse(c - r * 0.38, c - r * 0.45, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2); g.fill();
}

function paintCube(g, S) {
  const c = S / 2, a = S * 0.38;
  const top = [[c, c - a], [c + a * 0.87, c - a * 0.5], [c, c], [c - a * 0.87, c - a * 0.5]];
  const left = [[c - a * 0.87, c - a * 0.5], [c, c], [c, c + a], [c - a * 0.87, c + a * 0.5]];
  const right = [[c + a * 0.87, c - a * 0.5], [c, c], [c, c + a], [c + a * 0.87, c + a * 0.5]];
  const face = (pts, c1, c2) => {
    const gr = g.createLinearGradient(pts[0][0], pts[0][1], pts[2][0], pts[2][1]);
    gr.addColorStop(0, c1); gr.addColorStop(1, c2);
    g.fillStyle = gr;
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(160,240,255,0.9)'; g.lineWidth = S * 0.014; g.stroke();
  };
  face(top, '#9cf3ff', '#2aa7c9');
  face(left, '#1b6f95', '#0b3550');
  face(right, '#2790b8', '#0e4468');
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath(); g.arc(c, c - a * 0.5, S * 0.018, 0, Math.PI * 2); g.fill();
}

function paintCrystal(g, S) {
  const c = S / 2, h = S * 0.44, w = S * 0.3;
  const pts = { t: [c, c - h], l: [c - w, c - h * 0.2], r: [c + w, c - h * 0.2], b: [c, c + h], ml: [c - w * 0.45, c - h * 0.2], mr: [c + w * 0.45, c - h * 0.2] };
  const tri = (p, q, r, col) => {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.lineTo(...r); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = S * 0.01; g.stroke();
  };
  tri(pts.t, pts.l, pts.ml, '#c9a8ff');
  tri(pts.t, pts.ml, pts.mr, '#f1e6ff');
  tri(pts.t, pts.mr, pts.r, '#9a6cff');
  tri(pts.l, pts.ml, pts.b, '#6a3fd1');
  tri(pts.ml, pts.mr, pts.b, '#8f63ff');
  tri(pts.mr, pts.r, pts.b, '#4a24a8');
}

function paintCanister(g, S) {
  const x = S * 0.26, y = S * 0.1, w = S * 0.48, h = S * 0.8, rad = S * 0.08;
  const gr = g.createLinearGradient(x, 0, x + w, 0);
  gr.addColorStop(0, '#3b4c5c'); gr.addColorStop(0.35, '#b9cfe0'); gr.addColorStop(0.55, '#8aa3b8'); gr.addColorStop(1, '#2a3947');
  g.fillStyle = gr;
  g.beginPath(); g.roundRect(x, y, w, h, rad); g.fill();
  g.fillStyle = '#ff3355';
  g.fillRect(x, y + h * 0.3, w, h * 0.12);
  g.fillStyle = '#66f6ff';
  g.fillRect(x, y + h * 0.62, w, h * 0.05);
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fillRect(x + w * 0.18, y + rad, w * 0.08, h - rad * 2);
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = S * 0.012;
  g.beginPath(); g.roundRect(x, y, w, h, rad); g.stroke();
}

function paintCrate(g, S) {
  const m = S * 0.08, w = S - m * 2;
  const gr = g.createLinearGradient(0, m, 0, S - m);
  gr.addColorStop(0, '#5a6b7a'); gr.addColorStop(1, '#27323d');
  g.fillStyle = gr;
  g.beginPath(); g.roundRect(m, m, w, w, S * 0.04); g.fill();
  g.strokeStyle = '#ff3355'; g.lineWidth = S * 0.035;
  g.strokeRect(m + S * 0.04, m + S * 0.04, w - S * 0.08, w - S * 0.08);
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = S * 0.02;
  g.beginPath(); g.moveTo(m + S * 0.06, m + S * 0.06); g.lineTo(S - m - S * 0.06, S - m - S * 0.06);
  g.moveTo(S - m - S * 0.06, m + S * 0.06); g.lineTo(m + S * 0.06, S - m - S * 0.06); g.stroke();
  g.fillStyle = '#66f6ff';
  for (const [px, py] of [[0.16, 0.16], [0.84, 0.16], [0.16, 0.84], [0.84, 0.84]]) {
    g.beginPath(); g.arc(S * px, S * py, S * 0.022, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.font = `900 ${S * 0.12}px sans-serif`;
  g.textAlign = 'center';
  g.fillText('HEAVY', S / 2, S / 2 + S * 0.04);
}

const PAINTERS = { orb: paintOrb, cube: paintCube, crystal: paintCrystal, canister: paintCanister, crate: paintCrate };

function makeSprite(kind) {
  const S = 256;
  const c = makeCanvas(S, S);
  PAINTERS[kind](c.getContext('2d'), S);
  return c;
}

export class VirtualObjects {
  constructor() {
    this.items = [];
    this.enabled = false;
    this.nextId = 1;
    this.sprites = {};
    this.respawnAt = [];
    this.targetCount = 4;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.items = [];
      this.respawnAt = [];
    } else if (this.items.length === 0) {
      this.fill(true);
    }
  }

  _spriteFor(kind) {
    if (!this.sprites[kind]) this.sprites[kind] = makeSprite(kind);
    return this.sprites[kind];
  }

  _pickKind() {
    const hasHeavy = this.items.some((i) => i.heavy);
    const pool = KINDS.filter((k) => !(k.heavy && hasHeavy));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _spawn() {
    const spec = this._pickKind();
    for (let attempt = 0; attempt < 24; attempt++) {
      const fx = 0.16 + Math.random() * 0.68;
      const fy = 0.36 + Math.random() * 0.34;
      const clear = this.items.every((o) => Math.hypot(o.fx - fx, (o.fy - fy) * 1.6) > 0.24);
      if (clear || attempt === 23) {
        this.items.push({
          id: `virt_${this.nextId++}_${spec.kind}`,
          kind: spec.kind,
          heavy: spec.heavy,
          sizeFrac: spec.size,
          fx, fy,
          phase: Math.random() * Math.PI * 2,
          sprite: this._spriteFor(spec.kind),
          born: performance.now(),
        });
        return;
      }
    }
  }

  fill(instant = false) {
    while (this.items.length < this.targetCount) this._spawn();
    if (!instant) this.respawnAt = [];
  }

  remove(id, respawnDelay = 1400) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.enabled && this.items.length < before) this.respawnAt.push(performance.now() + respawnDelay);
  }

  _rect(item, vision, now) {
    const base = Math.min(vision.screenWidth, vision.screenHeight);
    const sz = base * item.sizeFrac * 1.55;
    const bob = Math.sin(now * 0.0016 + item.phase) * 7;
    const cx = item.fx * vision.screenWidth;
    const cy = item.fy * vision.screenHeight + bob;
    const popT = Math.min(1, (now - item.born) / 350);
    const pop = popT < 1 ? 0.4 + 0.6 * (1 - Math.pow(1 - popT, 3)) : 1;
    const s = sz * pop;
    return { x: cx - s / 2, y: cy - s / 2, w: s, h: s };
  }

  // Returns detections in the same shape as real ones. Call every frame.
  update(now, vision, latchedId) {
    if (!this.enabled) {
      vision.setVirtualDetections([]);
      return;
    }
    if (this.respawnAt.length && now >= this.respawnAt[0]) {
      this.respawnAt.shift();
      this._spawn();
    }
    const dets = [];
    for (const item of this.items) {
      if (item.id === latchedId) continue;
      const rect = this._rect(item, vision, now);
      item.rect = rect;
      dets.push({
        id: item.id,
        bbox: vision.screenToBox(rect),
        class: 'virtual',
        score: 1,
        manual: false,
        virtual: true,
        heavy: item.heavy,
        sprite: item.sprite,
        item,
      });
    }
    vision.setVirtualDetections(dets);
  }

  draw(ctx, now, latchedId) {
    if (!this.enabled) return;
    for (const item of this.items) {
      if (item.id === latchedId || !item.rect) continue;
      const r = item.rect;
      const cx = r.x + r.w / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(cx, r.y + r.h * 1.02, r.w * 0.34, r.h * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = item.heavy ? 'rgba(255,51,85,0.55)' : 'rgba(102,246,255,0.5)';
      ctx.shadowBlur = 18;
      ctx.translate(cx, r.y + r.h / 2);
      ctx.rotate(Math.sin(now * 0.001 + item.phase) * 0.06);
      ctx.drawImage(item.sprite, -r.w / 2, -r.h / 2, r.w, r.h);
      ctx.restore();
    }
  }
}
