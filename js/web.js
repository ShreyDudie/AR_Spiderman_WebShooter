// Hyper-Realistic Spider-Man Web Physics, Braided Silk Graphics, and Shooter FX

// A proper orb-web: radial spokes plus concentric rings whose chords sag inward between spokes.
function drawWebMesh(ctx, x, y, r, angles, rings, alpha) {
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.92})`;
  ctx.shadowColor = 'rgba(160, 230, 255, 0.7)';
  ctx.shadowBlur = 7;

  ctx.lineWidth = 1.3;
  for (const ang of angles) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    ctx.stroke();
  }

  ctx.lineWidth = 0.9;
  const n = angles.length;
  for (let ring = 1; ring <= rings; ring++) {
    const rr = (ring / rings) * r;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a0 = angles[i];
      let a1 = angles[(i + 1) % n];
      if (a1 < a0) a1 += Math.PI * 2;
      const am = (a0 + a1) / 2;
      const sag = rr * 0.8;
      if (i === 0) ctx.moveTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr);
      ctx.quadraticCurveTo(x + Math.cos(am) * sag, y + Math.sin(am) * sag, x + Math.cos(a1) * rr, y + Math.sin(a1) * rr);
    }
    ctx.stroke();
  }

  // dewy knots where the silk crosses
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  for (let ring = 1; ring <= rings; ring++) {
    const rr = (ring / rings) * r;
    for (const ang of angles) {
      ctx.beginPath();
      ctx.arc(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export class WebSystem {
  constructor() {
    this.projectiles = [];
    this.impactSplats = [];
    this.webPatches = [];
    this.sparks = [];
    this.muzzleFlashes = [];
    this.shockwaves = [];
  }

  shootProjectile({ start, end, handId, onImpact }) {
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const speed = Math.max(4200, dist * 9.0);
    const duration = Math.max(0.08, Math.min(0.15, dist / speed));

    const projectile = {
      id: `proj_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      start: { ...start },
      current: { ...start },
      end: { ...end },
      handId,
      progress: 0,
      duration,
      startTime: performance.now(),
      onImpact,
    };

    this.projectiles.push(projectile);
    this.muzzleFlashes.push({ x: start.x, y: start.y, born: performance.now(), life: 140 });

    return projectile;
  }

  addImpactSplat(point, radius = 46) {
    const spokesCount = 11;
    const angles = [];
    for (let i = 0; i < spokesCount; i++) {
      const base = (i / spokesCount) * Math.PI * 2;
      angles.push(base + (Math.random() - 0.5) * 0.18);
    }
    this.impactSplats.push({
      x: point.x,
      y: point.y,
      radius,
      angles,
      rings: 4,
      born: performance.now(),
      life: 650,
    });

    this.shockwaves.push({ x: point.x, y: point.y, born: performance.now(), life: 420, maxRadius: radius * 2.6 });

    for (let i = 0; i < 16; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 30 + Math.random() * 110;
      this.sparks.push({
        x: point.x,
        y: point.y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        size: 1.2 + Math.random() * 2.2,
        color: '#ffffff',
        born: performance.now(),
        life: 280 + Math.random() * 200,
      });
    }
  }

  spawnSparksAlongLine(start, end, count = 2) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    for (let i = 0; i < count; i++) {
      const t = 0.08 + Math.random() * 0.84;
      this.sparks.push({
        x: start.x + dx * t + (Math.random() - 0.5) * 6,
        y: start.y + dy * t + (Math.random() - 0.5) * 6,
        vx: (Math.random() - 0.5) * 45,
        vy: (Math.random() - 0.5) * 45,
        size: 1.0 + Math.random() * 2.0,
        color: Math.random() > 0.4 ? '#66f6ff' : '#ffffff',
        born: performance.now(),
        life: 200 + Math.random() * 180,
      });
    }
  }

  // Sticky web residue that stays glued to the object: it tracks the latched target's live
  // render transform (position / scale / tilt) every frame, so it travels with the object
  // instead of staying pinned to the screen point where the web first struck.
  attachWebPatch(target, impactPoint) {
    if (!target) return null;
    const scale = target.currentScale || 1;
    const angle = target.tiltAngle || 0;
    const dx = impactPoint.x - target.renderPos.x;
    const dy = impactPoint.y - target.renderPos.y;
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    const localX = (dx * cos - dy * sin) / scale;
    const localY = (dx * sin + dy * cos) / scale;

    const spokesCount = 10;
    const angles = Array.from({ length: spokesCount }, (_, i) =>
      (i / spokesCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.15
    );

    const patch = {
      target,
      localX,
      localY,
      radius: Math.max(26, Math.min(86, Math.min(target.screenBox.w, target.screenBox.h) * 0.4)),
      angles,
      rings: 4,
      born: performance.now(),
      life: 700,
    };
    this.webPatches.push(patch);
    return patch;
  }

  // Called when the object is released / collected: freeze the patch's last screen position and
  // let it fade out quickly instead of continuing to track a target that no longer exists.
  detachWebPatches(target) {
    const now = performance.now();
    for (const patch of this.webPatches) {
      if (patch.target === target) {
        const pos = this._webPatchScreenPos(patch);
        patch.x = pos.x;
        patch.y = pos.y;
        patch.radius *= pos.scale;
        patch.target = null;
        patch.born = now;
        patch.life = 420;
      }
    }
  }

  _webPatchScreenPos(patch) {
    const t = patch.target;
    if (!t) return { x: patch.x, y: patch.y, scale: 1 };
    const scale = t.currentScale || 1;
    const angle = t.tiltAngle || 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const lx = patch.localX * scale;
    const ly = patch.localY * scale;
    return {
      x: t.renderPos.x + lx * cos - ly * sin,
      y: t.renderPos.y + lx * sin + ly * cos,
      scale,
    };
  }

  update(now) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const elapsed = (now - p.startTime) / 1000;
      p.progress = Math.min(1.0, elapsed / p.duration);

      const t = p.progress;
      p.current.x = p.start.x + (p.end.x - p.start.x) * t;
      p.current.y = p.start.y + (p.end.y - p.start.y) * t;

      if (p.progress >= 1.0) {
        this.addImpactSplat(p.end);
        if (p.onImpact) p.onImpact();
        this.projectiles.splice(i, 1);
      }
    }

    this.impactSplats = this.impactSplats.filter((s) => now - s.born < s.life);
    this.muzzleFlashes = this.muzzleFlashes.filter((m) => now - m.born < m.life);
    this.shockwaves = this.shockwaves.filter((s) => now - s.born < s.life);
    // Patches still attached to a target live forever (until detachWebPatches fades them out)
    this.webPatches = this.webPatches.filter((p) => p.target || now - p.born < p.life);

    const dt = 1 / 60;
    this.sparks = this.sparks.filter((s) => {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      return now - s.born < s.life;
    });
  }

  drawWristShooter(ctx, muzzlePoint, isReady, now) {
    ctx.save();
    ctx.translate(muzzlePoint.x, muzzlePoint.y);

    const pulse = Math.sin(now * 0.012) * 0.5 + 0.5;

    ctx.strokeStyle = isReady ? 'rgba(255, 51, 85, 0.85)' : 'rgba(102, 246, 255, 0.65)';
    ctx.lineWidth = 2.0;
    ctx.shadowColor = isReady ? '#ff3355' : '#66f6ff';
    ctx.shadowBlur = isReady ? 12 : 6;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = isReady ? '#ff3355' : 'rgba(255, 51, 85, 0.5)';
    ctx.shadowColor = '#ff3355';
    ctx.shadowBlur = 10 + pulse * 6;
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#ffffff';
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2 + now * 0.002;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * 11, Math.sin(ang) * 11);
      ctx.lineTo(Math.cos(ang) * 15, Math.sin(ang) * 15);
      ctx.stroke();
    }

    ctx.restore();
  }

  // A real web shot is a single tapered strand of silk — thick where it leaves the shooter,
  // whipping thin at the tip — not a bundle of parallel neon lines. Drawn as a filled ribbon
  // whose width tapers along its length, plus a couple of hair-thin twist threads for texture.
  drawProjectiles(ctx, now) {
    for (const p of this.projectiles) {
      const { start, current, end } = p;
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len;
      const py = dx / len;
      const segments = 18;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(160, 230, 255, 0.55)';
      ctx.shadowBlur = 10;

      // tapered ribbon body (filled polygon, wide at muzzle -> thin at tip)
      ctx.beginPath();
      const topPts = [];
      const botPts = [];
      for (let s = 0; s <= segments; s++) {
        const t = s / segments;
        const wave = Math.sin(t * 20 + now * 0.05) * (1 - t) * 5;
        const width = (1 - t * 0.82) * 3.4;
        const cx = start.x + dx * t + px * wave;
        const cy = start.y + dy * t + py * wave;
        topPts.push({ x: cx + px * width, y: cy + py * width });
        botPts.push({ x: cx - px * width, y: cy - py * width });
      }
      ctx.moveTo(topPts[0].x, topPts[0].y);
      for (const pt of topPts) ctx.lineTo(pt.x, pt.y);
      for (let i = botPts.length - 1; i >= 0; i--) ctx.lineTo(botPts[i].x, botPts[i].y);
      ctx.closePath();
      const grad = ctx.createLinearGradient(start.x, start.y, current.x, current.y);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(1, 'rgba(255,255,255,0.78)');
      ctx.fillStyle = grad;
      ctx.fill();

      // fine twist thread for silk texture
      ctx.shadowBlur = 4;
      ctx.strokeStyle = 'rgba(190, 235, 255, 0.8)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (let s = 0; s <= segments; s++) {
        const t = s / segments;
        const spiral = Math.sin(t * 34 + now * 0.08) * 2.2 * (1 - t);
        const x = start.x + dx * t + px * spiral;
        const y = start.y + dy * t + py * spiral;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // bright tip glob (the silk wad right as it leaves the hand / flies)
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 16;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(current.x, current.y, 4.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  // Realistic sticky silk tether: one tapered rope (thicker at the wrist, thin at the object)
  // with a fine inner twist thread and a soft cyan rim-light, instead of several neon strands.
  drawTether(ctx, start, end, tension = 0, now = performance.now()) {
    if (!start || !end || isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) return;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.hypot(dx, dy) || 1;
    const px = -dy / dist;
    const py = dx / dist;

    const sag = (1 - tension) * Math.min(46, dist * 0.1);
    const vibrationAmp = tension > 0.04
      ? (Math.sin(now * 0.09) * 2.6 + Math.cos(now * 0.15) * 1.6) * tension
      : 0;

    if (tension > 0.35 && Math.random() < 0.45) {
      this.spawnSparksAlongLine(start, end, 1);
    }

    const segments = 26;
    const curve = (strandOffset) => {
      const pts = [];
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const envelope = Math.sin(t * Math.PI);
        const gravitySag = envelope * sag;
        const helix = Math.sin(t * 30 + now * 0.02 + strandOffset) * 2.6 * envelope * (1 - tension * 0.6);
        const harmonic = Math.sin(t * 70 + now * 0.11) * vibrationAmp * envelope;
        pts.push({
          x: start.x + dx * t + px * (helix + harmonic),
          y: start.y + dy * t + py * (helix + harmonic) + gravitySag,
          width: (1 - t * 0.55) * (2.0 + tension * 1.4),
        });
      }
      return pts;
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // tapered rope body (wrist-thick -> object-thin), filled for a solid silk look
    const body = curve(0);
    ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const pt = body[i];
      const ox = px * pt.width, oy = py * pt.width;
      if (i === 0) ctx.moveTo(pt.x + ox, pt.y + oy);
      else ctx.lineTo(pt.x + ox, pt.y + oy);
    }
    for (let i = segments; i >= 0; i--) {
      const pt = body[i];
      ctx.lineTo(pt.x - px * pt.width, pt.y - py * pt.width);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(248, 252, 255, 0.92)';
    ctx.fill();

    // faint cyan rim-light twist thread for a touch of suit-HUD cohesion, kept subtle
    ctx.shadowBlur = 6;
    ctx.strokeStyle = `rgba(150, 225, 255, ${0.35 + tension * 0.25})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rim = curve(2.1);
    for (let i = 0; i <= segments; i++) {
      const pt = rim[i];
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();

    // cross-links between the two twisted threads: reads as braided silk
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let i = 1; i < segments; i += 2) {
      ctx.moveTo(body[i].x, body[i].y);
      ctx.lineTo(rim[i].x, rim[i].y);
    }
    ctx.stroke();

    // light pulses racing along the silk toward the hand (faster the harder you pull)
    const pulseSpeed = 0.0006 * (1 + tension * 3.5);
    for (let k = 0; k < 3; k++) {
      const t = 1 - ((now * pulseSpeed + k / 3) % 1);
      const pt = body[Math.max(0, Math.min(segments, Math.round(t * segments)))];
      ctx.shadowColor = '#9fefff';
      ctx.shadowBlur = 16;
      ctx.fillStyle = 'rgba(220, 250, 255, 0.95)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2 + tension * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // stuck end nub on the object
    ctx.beginPath();
    ctx.arc(end.x, end.y, 5 + tension * 3, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 10;
    ctx.stroke();

    // shooter-end anchor dot
    ctx.beginPath();
    ctx.arc(start.x, start.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.fill();

    ctx.restore();
  }

  drawSplats(ctx, now) {
    for (const splat of this.impactSplats) {
      const age = now - splat.born;
      const grow = Math.min(1, age / 110);
      const alpha = Math.max(0, 1 - age / splat.life);
      if (alpha <= 0) continue;
      ctx.save();
      drawWebMesh(ctx, splat.x, splat.y, splat.radius * (0.55 + 0.45 * grow), splat.angles, splat.rings, alpha);
      ctx.restore();
    }
  }

  drawMuzzleFlashes(ctx, now) {
    for (const m of this.muzzleFlashes) {
      const age = now - m.born;
      const progress = age / m.life;
      if (progress >= 1) continue;

      const alpha = 1 - progress;
      const rad = 14 + progress * 24;

      ctx.save();
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.shadowColor = '#66f6ff';
      ctx.shadowBlur = 24;
      ctx.beginPath();
      ctx.arc(m.x, m.y, rad * 0.45, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(102, 246, 255, ${alpha * 0.8})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(m.x, m.y, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawSparks(ctx, now) {
    if (this.sparks.length === 0) return;
    ctx.save();
    for (const s of this.sparks) {
      const age = now - s.born;
      const alpha = Math.max(0, 1 - age / s.life);
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Expanding ring shockwave at the moment of impact — sells the "thwip-SMACK" weight.
  drawShockwaves(ctx, now) {
    if (this.shockwaves.length === 0) return;
    ctx.save();
    for (const sw of this.shockwaves) {
      const t = Math.max(0, Math.min(1, (now - sw.born) / sw.life));
      const alpha = (1 - t) * 0.8;
      if (alpha <= 0.01) continue;
      const r = sw.maxRadius * (0.25 + t * 0.75);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.lineWidth = 2.2 * (1 - t) + 0.4;
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Sticky web patch glued to the object — an orb-web that rides along on the object's live
  // transform (see attachWebPatch), fading only after release.
  drawWebPatches(ctx, now) {
    if (this.webPatches.length === 0) return;
    for (const patch of this.webPatches) {
      const pos = this._webPatchScreenPos(patch);
      const age = now - patch.born;
      const alpha = patch.target ? 0.92 : Math.max(0, 1 - age / patch.life);
      if (alpha <= 0.01) continue;
      const grow = patch.target ? Math.min(1, age / 140) : 1;
      ctx.save();
      drawWebMesh(ctx, pos.x, pos.y, patch.radius * pos.scale * (0.5 + 0.5 * grow), patch.angles, patch.rings, alpha);
      ctx.restore();
    }
  }

  render(ctx, now) {
    this.drawWebPatches(ctx, now);
    this.drawSplats(ctx, now);
    this.drawShockwaves(ctx, now);
    this.drawProjectiles(ctx, now);
    this.drawMuzzleFlashes(ctx, now);
    this.drawSparks(ctx, now);
  }
}