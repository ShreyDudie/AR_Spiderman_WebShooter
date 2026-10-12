// Basic, lightweight visuals for reeling an object in.
// No shadowBlur, no per-pixel work, at most ~20 simple strokes per frame, so it cannot slow hand tracking down.
//   * progress ring around the object (fills as you reel, turns warm as tension rises)
//   * a few speed streaks trailing behind the object, pointing back to where it started
//   * 3 faint "ghost" copies of the object along its path
//   * a pulsing anchor ring where the web is stuck
//   * a shockwave ring when the object is caught
 
const MAX_STREAKS = 12;
const GHOST_COUNT = 3;
const GHOST_EVERY_MS = 55;
 
export class PullFX {
  constructor() {
    this.streaks = [];
    this.ghosts = [];
    this.rings = [];
    this.lastGhostAt = 0;
    this.lastPos = null;
    this.lastT = 0;
    this.speed = 0;
    this.sparks = [];
    this.retract = null;
    this.last = null;
    this.burstDone = false;
  }

  reset() {
    // cancelled / released mid-pull: the web snaps back to the hand (not when the object was caught)
    if (this.last && !this.last.caught && this.last.progress > 0.02) {
      this.retract = { from: this.last.pos, to: this.last.muzzle, born: performance.now(), life: 240 };
    }
    this.streaks.length = 0;
    this.ghosts.length = 0;
    this.sparks.length = 0;
    this.lastPos = null;
    this.last = null;
    this.burstDone = false;
    this.speed = 0;
    // shockwave rings are left to finish on their own
  }
 
  onCaught(pos) {
    if (!pos) return;
    const now = performance.now();
    this.rings.push({ x: pos.x, y: pos.y, born: now, life: 420 });
    for (let i = 0; i < 10; i++) this.addSpark(pos.x, pos.y, Math.random() * 6.283, 120 + Math.random() * 160, now);
    this.last = null; // caught: nothing to retract
  }
 
  // Called every frame when nothing is latched, so a finishing shockwave still plays after release.
  idle(ctx, now) {
    this.drawRetract(ctx, now);
    this.drawSparks(ctx, now);
    this.drawRings(ctx, now);
  }

  addSpark(x, y, ang, speed, now) {
    if (this.sparks.length >= 24) this.sparks.shift();
    this.sparks.push({ x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, born: now, life: 300 + Math.random() * 200 });
  }

  // Tiny web-fibre flecks (plain 2-point lines, max 24)
  drawSparks(ctx, now) {
    if (!this.sparks.length) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      const t = (now - s.born) / s.life;
      if (t >= 1) { this.sparks.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - t, 2); // ease-out travel
      const x = s.x + s.vx * e * 0.35;
      const y = s.y + s.vy * e * 0.35;
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - s.vx * 0.04 * (1 - t), y - s.vy * 0.04 * (1 - t));
      ctx.stroke();
    }
    ctx.restore();
  }

  // Released / cancelled: the strand whips back to the hand and fades.
  drawRetract(ctx, now) {
    const r = this.retract;
    if (!r) return;
    const t = (now - r.born) / r.life;
    if (t >= 1) { this.retract = null; return; }
    const e = t * t; // accelerates like a snapped rubber band
    const hx = r.to.x, hy = r.to.y;
    const x = r.from.x + (hx - r.from.x) * e;
    const y = r.from.y + (hy - r.from.y) * e;
    const dx = x - hx, dy = y - hy;
    const d = Math.hypot(dx, dy) || 1;
    const wob = Math.sin(t * 38) * 9 * (1 - t);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.4 * (1 - t) + 0.8;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.quadraticCurveTo((hx + x) / 2 - (dy / d) * wob, (hy + y) / 2 + (dx / d) * wob, x, y);
    ctx.stroke();
    ctx.restore();
  }
 
  draw(ctx, now, latched) {
    if (!latched) return;
    const pos = latched.renderPos;
    const box = latched.screenBox;
    const progress = Math.max(0, Math.min(1, latched.pullProgress || 0));
    const tension = Math.max(0, Math.min(1, latched.lastTension || 0));
 
    // --- how fast the object is moving on screen (px / s), smoothed ---
    if (this.lastPos && now > this.lastT) {
      const dt = Math.max(0.001, (now - this.lastT) / 1000);
      const v = Math.hypot(pos.x - this.lastPos.x, pos.y - this.lastPos.y) / dt;
      this.speed += (Math.min(v, 3000) - this.speed) * 0.25;
    }
    this.lastPos = { x: pos.x, y: pos.y };
    this.lastT = now;
 
    const baseR = Math.max(24, Math.max(box.w, box.h) * 0.5 * (latched.currentScale || 1) * 0.85);
    const alpha = Math.max(0, Math.min(1, latched.alpha ?? 1));
 
    const muzzle = latched.lastValidMuzzle || pos;
    this.last = { pos: { x: pos.x, y: pos.y }, muzzle: { x: muzzle.x, y: muzzle.y }, progress, caught: !!latched.isCaught };

    ctx.save();
    ctx.lineCap = 'round';
 
    // anchor: a soft pulse where the web is stuck to the original spot
    if (!latched.isCaught) {
      const o = latched.originalCenter;
      const pulse = (Math.sin(now * 0.008) + 1) * 0.5;
      ctx.globalAlpha = 0.25 + 0.35 * tension;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(o.x, o.y, 10 + pulse * (4 + tension * 8), 0, Math.PI * 2);
      ctx.stroke();
    }
 
    // anchor fibres: web strands pulling taut where the web is stuck, plus a one-off tear burst
    if (!latched.isCaught) {
      const o = latched.originalCenter;
      if (progress > 0.04 && !this.burstDone) {
        this.burstDone = true;
        for (let i = 0; i < 8; i++) this.addSpark(o.x, o.y, Math.random() * 6.283, 90 + Math.random() * 130, now);
      }
      const fl = 10 + 26 * Math.max(tension, progress);
      const bx0 = o.x - pos.x, by0 = o.y - pos.y;
      const base = Math.atan2(by0, bx0);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = (0.3 + 0.4 * tension) * alpha;
      for (let i = -2; i <= 2; i++) {
        const a = base + i * 0.5;
        const l = fl * (1 - Math.abs(i) * 0.18);
        ctx.beginPath();
        ctx.moveTo(o.x, o.y);
        ctx.lineTo(o.x + Math.cos(a) * l, o.y + Math.sin(a) * l);
        ctx.stroke();
      }
      // beads of light running along the strand towards the hand (faster as the reel progresses)
      const mx = muzzle.x, my = muzzle.y;
      if (Math.hypot(mx - pos.x, my - pos.y) > 40) {
        ctx.fillStyle = '#9ffcff';
        for (let i = 0; i < 4; i++) {
          const u = ((now * (0.0009 + 0.0016 * Math.max(tension, progress)) + i / 4) % 1);
          ctx.globalAlpha = Math.sin(u * Math.PI) * 0.85 * alpha;
          ctx.beginPath();
          ctx.arc(pos.x + (mx - pos.x) * u, pos.y + (my - pos.y) * u, 2.2, 0, 6.283);
          ctx.fill();
        }
      }
    }

    // ghosts: faint copies of the cutout along its path (3 drawImage calls at most)
    if (latched.snapshotCanvas && this.speed > 120 && now - this.lastGhostAt > GHOST_EVERY_MS) {
      this.lastGhostAt = now;
      this.ghosts.unshift({ x: pos.x, y: pos.y, s: latched.currentScale || 1, r: latched.tiltAngle || 0 });
      if (this.ghosts.length > GHOST_COUNT) this.ghosts.pop();
    } else if (this.speed <= 120 && this.ghosts.length) {
      this.ghosts.pop(); // fade them out one by one when the object slows down
    }
    if (latched.snapshotCanvas) {
      for (let i = 0; i < this.ghosts.length; i++) {
        const g = this.ghosts[i];
        ctx.save();
        ctx.globalAlpha = alpha * (0.16 - i * 0.045);
        ctx.translate(g.x, g.y);
        ctx.rotate(g.r);
        ctx.scale(g.s, g.s);
        ctx.drawImage(latched.snapshotCanvas, -box.w * 0.5, -box.h * 0.5, box.w, box.h);
        ctx.restore();
      }
    }
 
    // streaks: short lines behind the object, pointing back toward where it started
    const o = latched.originalCenter;
    const bx = o.x - pos.x;
    const by = o.y - pos.y;
    const bl = Math.hypot(bx, by);
    if (bl > 20 && this.speed > 160 && !latched.isCaught && this.streaks.length < MAX_STREAKS) {
      const nx = bx / bl;
      const ny = by / bl;
      const count = this.speed > 700 ? 2 : 1;
      for (let i = 0; i < count && this.streaks.length < MAX_STREAKS; i++) {
        const side = (Math.random() - 0.5) * 2 * baseR * 0.9;
        this.streaks.push({
          x: pos.x - ny * side,
          y: pos.y + nx * side,
          dx: nx,
          dy: ny,
          len: 18 + Math.random() * 26 + Math.min(40, this.speed * 0.02),
          born: now,
          life: 260,
        });
      }
    }
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      const age = (now - s.born) / s.life;
      if (age >= 1) { this.streaks.splice(i, 1); continue; }
      const drift = age * 22;
      const x0 = s.x + s.dx * drift;
      const y0 = s.y + s.dy * drift;
      ctx.globalAlpha = alpha * (1 - age) * 0.7;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + s.dx * s.len, y0 + s.dy * s.len);
      ctx.stroke();
    }
 
    // progress ring: faint full circle + bright arc that fills with the reel
    if (progress > 0.01 && !latched.isCaught) {
      const r = baseR + 12;
      const hue = Math.round(185 - 185 * Math.max(progress * 0.6, tension)); // cyan -> red as it tightens
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.stroke();
 
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = `hsl(${hue}, 100%, 62%)`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress / 0.85));
      ctx.stroke();
    }
 
    ctx.restore();
    this.drawRetract(ctx, now);
    this.drawSparks(ctx, now);
    this.drawRings(ctx, now);
  }
 
  drawRings(ctx, now) {
    if (!this.rings.length) return;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const t = (now - r.born) / r.life;
      if (t >= 1) { this.rings.splice(i, 1); continue; }
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 20 + t * 90, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}