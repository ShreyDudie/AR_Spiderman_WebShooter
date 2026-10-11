// Hyper-Realistic Spider-Man Web Physics, Braided Silk Graphics, and Shooter FX

export class WebSystem {
  constructor() {
    this.projectiles = [];
    this.impactSplats = [];
    this.sparks = [];
    this.muzzleFlashes = [];
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

  addImpactSplat(point, radius = 32) {
    const spokesCount = 10;
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
      life: 6000,
    });

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

  drawProjectiles(ctx, now) {
    for (const p of this.projectiles) {
      const { start, current, end } = p;
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len;
      const py = dx / len;

      ctx.save();
      ctx.lineCap = 'round';

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3.5;
      ctx.shadowColor = '#66f6ff';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      const segments = 16;
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        const wave = Math.sin(t * 22 + now * 0.06) * (1 - t) * 7;
        ctx.lineTo(start.x + dx * t + px * wave, start.y + dy * t + py * wave);
      }
      ctx.stroke();

      ctx.strokeStyle = 'rgba(102, 246, 255, 0.7)';
      ctx.lineWidth = 6.5;
      ctx.shadowBlur = 24;
      ctx.stroke();

      for (let w = -1; w <= 1; w += 2) {
        ctx.beginPath();
        for (let s = 0; s <= segments; s++) {
          const t = s / segments;
          const spiral = Math.sin(t * 30 + now * 0.08) * w * 5 * (1 - t);
          const x = start.x + dx * t + px * spiral;
          const y = start.y + dy * t + py * spiral;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = 'rgba(213, 255, 133, 0.8)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(current.x, current.y, 6.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  drawTether(ctx, start, end, tension = 0, now = performance.now()) {
    if (!start || !end || isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) return;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.hypot(dx, dy) || 1;
    const px = -dy / dist;
    const py = dx / dist;

    const sag = (1 - tension) * Math.min(50, dist * 0.12);
    const vibrationAmp = tension > 0.04
      ? (Math.sin(now * 0.09) * 3.5 + Math.cos(now * 0.15) * 2.2) * tension
      : 0;

    if (tension > 0.35 && Math.random() < 0.45) {
      this.spawnSparksAlongLine(start, end, 1);
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const strands = [
      { offset: 0, color: '#ffffff', width: 2.8 + tension * 1.2, blur: 16, glow: '#ffffff' },
      { offset: 1, color: 'rgba(102, 246, 255, 0.9)', width: 1.8, blur: 12, glow: '#66f6ff' },
      { offset: -1, color: 'rgba(213, 255, 133, 0.85)', width: 1.5, blur: 10, glow: '#d5ff85' },
      { offset: 0.5, color: 'rgba(255, 255, 255, 0.7)', width: 1.2, blur: 8, glow: '#ffffff' },
    ];

    const segments = 28;

    for (const strand of strands) {
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const envelope = Math.sin(t * Math.PI);

        const gravitySag = envelope * sag;
        const helix = Math.sin(t * 36 + now * 0.025 + strand.offset * 2.0) * 4.0 * envelope * (1 - tension * 0.6);
        const harmonic = Math.sin(t * 75 + now * 0.11) * vibrationAmp * envelope;

        const x = start.x + dx * t + px * (helix + harmonic);
        const y = start.y + dy * t + py * (helix + harmonic) + gravitySag;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = strand.color;
      ctx.lineWidth = strand.width;
      ctx.shadowColor = strand.glow;
      ctx.shadowBlur = strand.blur;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(end.x, end.y, 7 + tension * 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.6;
    ctx.shadowColor = '#66f6ff';
    ctx.shadowBlur = 16;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(start.x, start.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.restore();
  }

  drawSplats(ctx, now) {
    for (const splat of this.impactSplats) {
      const age = now - splat.born;
      const alpha = Math.max(0, 1 - age / splat.life);
      if (alpha <= 0) continue;

      ctx.save();
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
      ctx.shadowColor = '#66f6ff';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1.6;

      for (const ang of splat.angles) {
        ctx.beginPath();
        ctx.moveTo(splat.x, splat.y);
        ctx.lineTo(splat.x + Math.cos(ang) * splat.radius, splat.y + Math.sin(ang) * splat.radius);
        ctx.stroke();
      }

      for (let r = 1; r <= splat.rings; r++) {
        const ringRad = (r / splat.rings) * splat.radius;
        ctx.beginPath();
        for (let i = 0; i < splat.angles.length; i++) {
          const ang = splat.angles[i];
          const px = splat.x + Math.cos(ang) * ringRad;
          const py = splat.y + Math.sin(ang) * ringRad;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }

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

  render(ctx, now) {
    this.drawSplats(ctx, now);
    this.drawProjectiles(ctx, now);
    this.drawMuzzleFlashes(ctx, now);
    this.drawSparks(ctx, now);
  }
}