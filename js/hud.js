// Marvel Spider-Man Tactical HUD, Magnetic Lock-On Crosshair, and Visual FX

export class SpiderHUD {
  constructor() {
    this.bursts = [];
    this.screenFlashAlpha = 0;
    this.smoothCrosshair = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
  }

  // Draw biometric hand joint skeleton with glowing joints and live pose tracking
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
      const isSpidey = hand.isSpideyPose;
      const jState = hand.jointStates || {};

      const screenPts = lm.map((p) => vision.pointToScreen(p));

      ctx.save();

      // 1. Draw glowing biometric bone lines
      ctx.lineWidth = isSpidey ? 2.4 : 1.5;
      ctx.strokeStyle = isSpidey ? 'rgba(213, 255, 133, 0.75)' : 'rgba(102, 246, 255, 0.4)';
      ctx.shadowColor = isSpidey ? '#d5ff85' : '#66f6ff';
      ctx.shadowBlur = isSpidey ? 10 : 4;

      for (const [from, to] of connections) {
        const p1 = screenPts[from];
        const p2 = screenPts[to];
        if (!p1 || !p2) continue;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      // 2. Draw biometric joint nodes at all 21 landmarks
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
          nodeColor = isSpidey ? '#ff3355' : '#ffffff';
          nodeSize = 5.0;
        }

        ctx.fillStyle = nodeColor;
        ctx.shadowColor = nodeColor;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, nodeSize, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3. Biometric Suit Readout Badge
      const wristPt = screenPts[0];
      if (wristPt) {
        ctx.shadowBlur = 0;
        ctx.font = '700 9.5px Inter, monospace';
        const label = isSpidey ? 'SUIT SCAN: SPIDEY POSE READY ✓' : 'SUIT SCAN: JOINTS TRACKED';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(4, 14, 25, 0.88)';
        ctx.fillRect(wristPt.x - tw / 2 - 6, wristPt.y + 16, tw + 12, 18);
        ctx.fillStyle = isSpidey ? '#d5ff85' : '#66f6ff';
        ctx.fillText(label, wristPt.x - tw / 2, wristPt.y + 28);
      }

      ctx.restore();
    }
  }

  // Draw tactical Spider-Man aiming crosshair with magnetic target lock
  drawCrosshairs(ctx, handStates, vision, lockedTarget, candidateTarget, now) {
    const screenCenter = { x: vision.screenWidth * 0.5, y: vision.screenHeight * 0.5 };

    // Determine target aim position
    let targetAimX = screenCenter.x;
    let targetAimY = screenCenter.y;
    let isHandAiming = false;
    let isShootingPose = false;

    const primaryHand = handStates?.[0];
    if (primaryHand) {
      isHandAiming = true;
      isShootingPose = primaryHand.isSpideyPose;
      const screenAim = vision.pointToScreen(primaryHand.aimTarget);

      // Magnetic snapping: If locked onto candidate, gently snap reticle toward target center
      if (candidateTarget) {
        targetAimX = candidateTarget.center.x;
        targetAimY = candidateTarget.center.y;
      } else {
        targetAimX = screenAim.x;
        targetAimY = screenAim.y;
      }
    } else if (candidateTarget) {
      targetAimX = candidateTarget.center.x;
      targetAimY = candidateTarget.center.y;
    }

    // Smooth crosshair interpolation
    this.smoothCrosshair.x += (targetAimX - this.smoothCrosshair.x) * 0.32;
    this.smoothCrosshair.y += (targetAimY - this.smoothCrosshair.y) * 0.32;

    const cx = this.smoothCrosshair.x;
    const cy = this.smoothCrosshair.y;

    const isLocked = lockedTarget != null;
    const isCandidate = candidateTarget != null;

    ctx.save();
    ctx.translate(cx, cy);

    // Color theme
    const themeColor = isLocked
      ? '#66f6ff'
      : isCandidate
      ? '#d5ff85'
      : isShootingPose
      ? '#ffffff'
      : 'rgba(102, 246, 255, 0.75)';

    // 1. Center Reticle Ring
    const radius = isShootingPose ? 18 : isCandidate ? 22 : 14;
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = isCandidate || isShootingPose ? 2.5 : 1.6;
    ctx.shadowColor = themeColor;
    ctx.shadowBlur = isCandidate || isShootingPose ? 16 : 8;

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Center laser dot
    ctx.fillStyle = themeColor;
    ctx.beginPath();
    ctx.arc(0, 0, isShootingPose ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 2. Rotating Tick Marks (Tactical HUD)
    const rot = now * 0.002 * (isShootingPose ? 2.5 : 1.0);
    ctx.lineWidth = 2.0;
    for (let i = 0; i < 4; i++) {
      const ang = rot + (i * Math.PI) / 2;
      const inner = radius + 3;
      const outer = radius + (isCandidate ? 10 : 7);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * inner, Math.sin(ang) * inner);
      ctx.lineTo(Math.cos(ang) * outer, Math.sin(ang) * outer);
      ctx.stroke();
    }

    // 3. Spider-Sense Warning Arcs (Pulsing around reticle when target locked)
    if (isCandidate || isLocked) {
      ctx.strokeStyle = '#d5ff85';
      ctx.lineWidth = 2.8;
      ctx.shadowColor = '#d5ff85';
      ctx.shadowBlur = 18;

      const pulse = Math.sin(now * 0.016) * 5;
      const arcR = radius + 15 + pulse;

      // Top arc
      ctx.beginPath();
      ctx.arc(0, 0, arcR, -Math.PI * 0.72, -Math.PI * 0.28);
      ctx.stroke();

      // Bottom arc
      ctx.beginPath();
      ctx.arc(0, 0, arcR, Math.PI * 0.28, Math.PI * 0.72);
      ctx.stroke();

      // Locked Target HUD Box Tooltip
      if (candidateTarget) {
        ctx.shadowBlur = 0;
        const text = `TARGET LOCKED // ${candidateTarget.detection.class.toUpperCase()}`;
        ctx.font = '700 10.5px Inter, monospace';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(4, 14, 25, 0.9)';
        ctx.fillRect(-tw / 2 - 10, -radius - 36, tw + 20, 22);

        ctx.strokeStyle = '#d5ff85';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-tw / 2 - 10, -radius - 36, tw + 20, 22);

        ctx.fillStyle = '#d5ff85';
        ctx.fillText(text, -tw / 2, -radius - 21);
      }
    }

    ctx.restore();

    // 4. Draw Laser Aim Trace Ray from hand muzzle to crosshair
    if (primaryHand && !isLocked) {
      const muzzle = vision.pointToScreen(primaryHand.shooterMuzzle);
      ctx.save();
      ctx.strokeStyle = isShootingPose ? 'rgba(213, 255, 133, 0.45)' : 'rgba(102, 246, 255, 0.25)';
      ctx.lineWidth = isShootingPose ? 1.8 : 1.0;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(muzzle.x, muzzle.y);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Draw bounding boxes for detected small objects
  drawDetections(ctx, detections, vision, lockedTargetId, candidateTarget) {
    for (const det of detections) {
      if (lockedTargetId && det.id === lockedTargetId) continue;

      const rect = vision.boxToScreen(det.bbox);
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;

      const isAimCandidate = candidateTarget && candidateTarget.detection.id === det.id;

      ctx.save();
      ctx.strokeStyle = isAimCandidate ? '#d5ff85' : 'rgba(102, 246, 255, 0.75)';
      ctx.lineWidth = isAimCandidate ? 2.4 : 1.4;
      ctx.shadowColor = isAimCandidate ? '#d5ff85' : '#38eaff';
      ctx.shadowBlur = isAimCandidate ? 16 : 8;

      ctx.setLineDash(isAimCandidate ? [] : [6, 5]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.setLineDash([]);

      // Tactical corner brackets
      const c = Math.min(14, rect.w * 0.22, rect.h * 0.22);
      ctx.lineWidth = isAimCandidate ? 3.5 : 2.5;
      [
        [rect.x, rect.y, 1, 1],
        [rect.x + rect.w, rect.y, -1, 1],
        [rect.x, rect.y + rect.h, 1, -1],
        [rect.x + rect.w, rect.y + rect.h, -1, -1],
      ].forEach(([bx, by, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(bx, by + sy * c);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + sx * c, by);
        ctx.stroke();
      });

      // Label badge
      ctx.shadowBlur = 0;
      const label = `${det.class.toUpperCase()} ${isAimCandidate ? '· READY' : ''}`;
      ctx.font = '700 10px Inter, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = isAimCandidate ? 'rgba(15, 35, 20, 0.92)' : 'rgba(4, 14, 25, 0.85)';
      ctx.fillRect(rect.x, Math.max(0, rect.y - 20), tw + 14, 18);
      ctx.fillStyle = isAimCandidate ? '#d5ff85' : '#eef8ff';
      ctx.fillText(label, rect.x + 6, Math.max(13, rect.y - 7));

      ctx.restore();
    }
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
