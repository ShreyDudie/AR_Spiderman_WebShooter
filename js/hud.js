// Marvel Spider-Man Tactical HUD, Magnetic Lock-On Crosshair, and Visual FX
// Phase-aware: nothing aims/locks while IDLE; crosshair + guidelines appear only while AIMING.
 
const POSE_LABELS = {
  AIM: 'MOVE 2 · AIM',
  FIST: 'MOVE 4 · FIST',
  OPEN: 'OPEN PALM',
  IDLE: 'MOVE 1 · IDLE',
};
 
export class SpiderHUD {
  constructor() {
    this.bursts = [];
    this.screenFlashAlpha = 0;
    this.smoothCrosshair = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
    this.crosshairWasActive = false;
    this.shakeUntil = 0;
    this.shakeMag = 0;
    this.shakeDuration = 1;
    this.aimRay = null;
  }

  // Brief camera-shake impulse (e.g. on web impact). mag = pixels, ms = duration.
  triggerShake(mag = 6, ms = 160) {
    this.shakeUntil = performance.now() + ms;
    this.shakeMag = mag;
    this.shakeDuration = ms;
  }

  getShakeOffset(now) {
    const remaining = this.shakeUntil - now;
    if (remaining <= 0) return { x: 0, y: 0 };
    const decay = remaining / this.shakeDuration;
    return {
      x: (Math.random() - 0.5) * 2 * this.shakeMag * decay,
      y: (Math.random() - 0.5) * 2 * this.shakeMag * decay,
    };
  }
 
  drawHandSkeleton(ctx, handStates, vision, now) {
    if (!handStates || handStates.length === 0) return;
 
    const connections = [
      [0, 1], [1, 2], [2, 3], [3, 4],
      [0, 5], [5, 6], [6, 7], [7, 8],
      [0, 9], [9, 10], [10, 11], [11, 12],
      [0, 13], [13, 14], [14, 15], [15, 16],
      [0, 17], [17, 18], [18, 19], [19, 20],
      [5, 9], [9, 13], [13, 17]
    ];
 
    for (const hand of handStates) {
      if (!hand || !hand.landmarks || hand.landmarks.length < 21) continue;
      const lm = hand.landmarks;
      const isAim = hand.pose === 'AIM';
      const isFist = hand.pose === 'FIST';
      const hot = isAim || isFist;
      const jState = hand.jointStates || {};
 
      const screenPts = lm.map((p) => vision.pointToScreen(p));
 
      ctx.save();
 
      ctx.lineWidth = hot ? 2.4 : 1.5;
      ctx.strokeStyle = isAim ? 'rgba(213, 255, 133, 0.75)' : isFist ? 'rgba(255, 51, 85, 0.75)' : 'rgba(102, 246, 255, 0.4)';
      ctx.shadowColor = isAim ? '#d5ff85' : isFist ? '#ff3355' : '#66f6ff';
      ctx.shadowBlur = hot ? 10 : 4;
 
      for (const [from, to] of connections) {
        const p1 = screenPts[from];
        const p2 = screenPts[to];
        if (!p1 || !p2) continue;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
 
      for (let i = 0; i < 21; i++) {
        const pt = screenPts[i];
        if (!pt) continue;
 
        let nodeColor = '#66f6ff';
        let nodeSize = 2.8;
 
        if (i === 8 || i === 20) {
          nodeColor = jState.indexExtended || jState.pinkyExtended ? '#d5ff85' : '#66f6ff';
          nodeSize = 4.2;
        } else if (i === 12 || i === 16) {
          nodeColor = jState.middleCurled && jState.ringCurled ? '#d5ff85' : '#ff8597';
          nodeSize = 3.8;
        } else if (i === 0) {
          nodeColor = hot ? '#ff3355' : '#ffffff';
          nodeSize = 5.0;
        }
 
        ctx.fillStyle = nodeColor;
        ctx.shadowColor = nodeColor;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, nodeSize, 0, Math.PI * 2);
        ctx.fill();
      }
 
      const wristPt = screenPts[0];
      if (wristPt) {
        ctx.shadowBlur = 0;
        ctx.font = '700 9.5px Inter, monospace';
        const label = `SUIT SCAN: ${POSE_LABELS[hand.pose] || POSE_LABELS.IDLE}${hand.isFlickDown ? ' · FLICK!' : ''}`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(4, 14, 25, 0.88)';
        ctx.fillRect(wristPt.x - tw / 2 - 6, wristPt.y + 16, tw + 12, 18);
        ctx.fillStyle = isAim ? '#d5ff85' : isFist ? '#ff8597' : '#66f6ff';
        ctx.fillText(label, wristPt.x - tw / 2, wristPt.y + 28);
      }
 
      ctx.restore();
    }
  }
 
  // Movement 2: crosshair + guide lines. Drawn ONLY while phase === 'AIM'.
  drawCrosshairs(ctx, handStates, vision, latched, candidateTarget, now, phase = 'AIM') {
    if (phase !== 'AIM') {
      this.crosshairWasActive = false;
      return;
    }
 
    const aimHand = handStates?.find((h) => h.isSpideyPose) || handStates?.find((h) => h.aimRecently);
    if (!aimHand) return;
 
    const screenAim = vision.pointToScreen(aimHand.aimTarget);
    let targetAimX = screenAim.x;
    let targetAimY = screenAim.y;
    if (candidateTarget) {
      targetAimX = candidateTarget.center.x;
      targetAimY = candidateTarget.center.y;
    }
 
    // jump to the finger when the crosshair first appears, then glide / snap to the target
    if (!this.crosshairWasActive) {
      this.smoothCrosshair.x = screenAim.x;
      this.smoothCrosshair.y = screenAim.y;
      this.crosshairWasActive = true;
    }
    this.smoothCrosshair.x += (targetAimX - this.smoothCrosshair.x) * 0.32;
    this.smoothCrosshair.y += (targetAimY - this.smoothCrosshair.y) * 0.32;
 
    const cx = this.smoothCrosshair.x;
    const cy = this.smoothCrosshair.y;
    const W = vision.screenWidth;
    const H = vision.screenHeight;
    const isLocked = candidateTarget != null;
    const themeColor = isLocked ? '#d5ff85' : 'rgba(102, 246, 255, 0.9)';
    const radius = isLocked ? 22 : 16;
 
    // ---- full-screen guide lines through the crosshair (with a gap around the reticle) ----
    ctx.save();
    ctx.strokeStyle = isLocked ? 'rgba(213, 255, 133, 0.35)' : 'rgba(102, 246, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    const gap = radius + 18;
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(W, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.setLineDash([]);
 
    // range ticks along the guide lines
    ctx.strokeStyle = isLocked ? 'rgba(213, 255, 133, 0.55)' : 'rgba(102, 246, 255, 0.4)';
    for (let i = 1; i <= 5; i++) {
      const d = gap + i * 26;
      const len = i % 2 ? 5 : 8;
      ctx.beginPath();
      ctx.moveTo(cx + d, cy - len); ctx.lineTo(cx + d, cy + len);
      ctx.moveTo(cx - d, cy - len); ctx.lineTo(cx - d, cy + len);
      ctx.moveTo(cx - len, cy + d); ctx.lineTo(cx + len, cy + d);
      ctx.moveTo(cx - len, cy - d); ctx.lineTo(cx + len, cy - d);
      ctx.stroke();
    }
    ctx.restore();
 
    // ---- launch line from the wrist shooter to the crosshair ----
    const shooters = candidateTarget && candidateTarget.detection.heavy && handStates.length > 1 ? handStates : [aimHand];
    ctx.save();
    ctx.strokeStyle = isLocked ? 'rgba(213, 255, 133, 0.65)' : 'rgba(102, 246, 255, 0.4)';
    ctx.lineWidth = isLocked ? 2 : 1.2;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = -now * 0.04;
    for (const h of shooters) {
      const muzzle = vision.pointToScreen(h.shooterMuzzle);
      ctx.beginPath();
      ctx.moveTo(muzzle.x, muzzle.y);
      ctx.lineTo(cx, cy);
      ctx.stroke();
    }
    ctx.restore();

    // ---- pointing ray: shows exactly where the finger is aiming (newcomer-friendly) ----
    if (this.aimRay && this.aimRay.reach > 0 && !isLocked) {
      const r = this.aimRay;
      ctx.save();
      const grad = ctx.createLinearGradient(r.tip.x, r.tip.y, r.end.x, r.end.y);
      grad.addColorStop(0, 'rgba(102, 246, 255, 0.85)');
      grad.addColorStop(1, 'rgba(102, 246, 255, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.shadowColor = '#66f6ff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(r.tip.x, r.tip.y);
      ctx.lineTo(r.end.x, r.end.y);
      ctx.stroke();
      ctx.restore();
    }
 
    // ---- reticle ----
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = isLocked ? 2.6 : 1.8;
    ctx.shadowColor = themeColor;
    ctx.shadowBlur = isLocked ? 16 : 8;
 
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
 
    ctx.fillStyle = themeColor;
    ctx.beginPath();
    ctx.arc(0, 0, isLocked ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
 
    const rot = now * 0.002 * (isLocked ? 2.5 : 1.0);
    ctx.lineWidth = 2.0;
    for (let i = 0; i < 4; i++) {
      const ang = rot + (i * Math.PI) / 2;
      const inner = radius + 3;
      const outer = radius + (isLocked ? 10 : 7);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
      ctx.lineTo(Math.cos(ang) * outer, Math.sin(ang) * outer);
      ctx.stroke();
    }
 
    if (isLocked) {
      ctx.strokeStyle = '#d5ff85';
      ctx.lineWidth = 2.8;
      ctx.shadowColor = '#d5ff85';
      ctx.shadowBlur = 18;
 
      const pulse = Math.sin(now * 0.016) * 5;
      const arcR = radius + 15 + pulse;
 
      ctx.beginPath();
      ctx.arc(0, 0, arcR, -Math.PI * 0.72, -Math.PI * 0.28);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, arcR, Math.PI * 0.28, Math.PI * 0.72);
      ctx.stroke();
 
      ctx.shadowBlur = 0;
      const tag = candidateTarget.detection.heavy ? ' · HEAVY · 2 HANDS' : '';
      const text = `TARGET LOCKED${tag}`;
      ctx.font = '700 10.5px Inter, monospace';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(4, 14, 25, 0.9)';
      ctx.fillRect(-tw / 2 - 10, -radius - 36, tw + 20, 22);
      ctx.strokeStyle = '#d5ff85';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-tw / 2 - 10, -radius - 36, tw + 20, 22);
      ctx.fillStyle = '#d5ff85';
      ctx.fillText(text, -tw / 2, -radius - 21);
 
      ctx.font = '700 9.5px Inter, monospace';
      const hint = 'FLICK WRIST DOWN TO SHOOT';
      const hw = ctx.measureText(hint).width;
      ctx.fillStyle = 'rgba(4, 14, 25, 0.85)';
      ctx.fillRect(-hw / 2 - 8, radius + 14, hw + 16, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(hint, -hw / 2, radius + 27);
    }
 
    ctx.restore();
  }
 
  // Target markers: sleek corner brackets + a tiny centre pip. No object names — just detection.
  // phase === 'IDLE' draws them dimly; the aim candidate gets a bright lime frame and spinning ring.
  drawDetections(ctx, detections, vision, lockedTargetId, candidateTarget, phase = 'AIM', now = performance.now()) {
    const idle = phase === 'IDLE';
    for (const det of detections) {
      if (lockedTargetId && det.id === lockedTargetId) continue;

      const rect = vision.boxToScreen(det.bbox);
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;

      const isAimCandidate = !idle && candidateTarget && candidateTarget.detection.id === det.id;
      const color = isAimCandidate ? '#d5ff85' : det.heavy ? '#ff8aa0' : '#66f6ff';
      const pad = 4;
      const x = rect.x - pad, y = rect.y - pad, w = rect.w + pad * 2, h = rect.h + pad * 2;
      const breathe = isAimCandidate ? Math.sin(now * 0.012) * 2 : 0;

      ctx.save();
      ctx.globalAlpha = idle ? 0.45 : 1;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = isAimCandidate ? 18 : idle ? 0 : 9;
      ctx.lineCap = 'round';

      if (isAimCandidate) {
        ctx.fillStyle = 'rgba(213, 255, 133, 0.07)';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = color;
      }

      const c = Math.min(isAimCandidate ? 22 : 16, w * 0.28, h * 0.28);
      ctx.lineWidth = isAimCandidate ? 3.6 : 2.4;
      const o = breathe;
      [
        [x - o, y - o, 1, 1],
        [x + w + o, y - o, -1, 1],
        [x - o, y + h + o, 1, -1],
        [x + w + o, y + h + o, -1, -1],
      ].forEach(([bx, by, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(bx, by + sy * c);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + sx * c, by);
        ctx.stroke();
      });

      // scanning line sweeping through a candidate
      if (isAimCandidate) {
        const sweep = ((now * 0.0016) % 1) * h;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 4, y + sweep);
        ctx.lineTo(x + w - 4, y + sweep);
        ctx.stroke();
      }

      // centre pip
      ctx.globalAlpha = idle ? 0.35 : 0.9;
      ctx.beginPath();
      ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, isAimCandidate ? 3.5 : 2.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  // Radial speed lines + soft edge glow while an object is being reeled in.
  drawSpeedLines(ctx, w, h, intensity, now) {
    if (intensity < 0.08) return;
    const cx = w / 2, cy = h / 2;
    const diag = Math.hypot(w, h) / 2;
    ctx.save();
    ctx.lineCap = 'round';
    const count = Math.round(14 + intensity * 26);
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r0 = diag * (0.55 + Math.random() * 0.25);
      const r1 = r0 + diag * (0.12 + Math.random() * 0.3) * intensity;
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.05 + Math.random() * 0.22 * intensity})`;
      ctx.lineWidth = 0.8 + Math.random() * 1.8;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }
    const vg = ctx.createRadialGradient(cx, cy, diag * 0.55, cx, cy, diag * 1.05);
    vg.addColorStop(0, 'rgba(255, 51, 85, 0)');
    vg.addColorStop(1, `rgba(255, 51, 85, ${0.22 * intensity})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  triggerFlash() {
    this.screenFlashAlpha = 0.55;
  }
 
  spawnBurst(point) {
    const x = point?.x ?? window.innerWidth * 0.5;
    const y = point?.y ?? window.innerHeight * 0.5;
    this.bursts.push({
      x,
      y,
      born: performance.now(),
      particles: Array.from({ length: 24 }, () => ({
        angle: Math.random() * Math.PI * 2,
        speed: 40 + Math.random() * 180,
        size: 1.5 + Math.random() * 3.5,
        color: Math.random() > 0.4 ? '#66f6ff' : '#d5ff85',
      })),
    });
  }
 
  drawBursts(ctx, now) {
    if (this.bursts.length === 0) return;
    this.bursts = this.bursts.filter((b) => now - b.born < 650);
 
    for (const b of this.bursts) {
      const age = (now - b.born) / 650;
      const alpha = 1 - age;
      ctx.save();
      for (const p of b.particles) {
        const dist = p.speed * age;
        const px = b.x + Math.cos(p.angle) * dist;
        const py = b.y + Math.sin(p.angle) * dist;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(px, py, p.size * alpha, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
 
  drawScreenFlash(ctx, width, height) {
    if (this.screenFlashAlpha <= 0.005) return;
    ctx.save();
    ctx.fillStyle = `rgba(102, 246, 255, ${this.screenFlashAlpha})`;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    this.screenFlashAlpha *= 0.86;
  }
}