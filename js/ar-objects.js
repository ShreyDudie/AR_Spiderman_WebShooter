// Augmented Reality Pure Object Cutout & Reeling Physics
// Brings ONLY the visual cutout of the real object closer with realistic 3D depth (NO bounding boxes!)

export class ARObjectManager {
  constructor() {
    this.latchedTarget = null;
  }

  attachWeb({ detection, screenBox, snapshotCanvas, handId, startMuzzle }) {
    const center = { x: screenBox.x + screenBox.w * 0.5, y: screenBox.y + screenBox.h * 0.5 };

    const tethers = new Map();
    tethers.set(handId, {
      handId,
      startMuzzle: { ...startMuzzle },
      curMuzzle: { ...startMuzzle },
      tension: 0,
      pullAmount: 0,
    });

    this.latchedTarget = {
      id: detection.id || `target_${Date.now()}`,
      detection,
      screenBox: { ...screenBox },
      originalCenter: { ...center },
      renderPos: { ...center },
      velocity: { x: 0, y: 0 },
      snapshotCanvas,
      tethers,
      pullProgress: 0,
      currentScale: 1.0,
      tiltAngle: 0,
      isCaught: false,
      attachTime: performance.now(),
      lastTension: 0,
      lostHandFrames: 0,
      lastValidMuzzle: { ...startMuzzle },
    };

    return this.latchedTarget;
  }

  update(handStates, vision) {
    const target = this.latchedTarget;
    if (!target) return null;

    let activeTethers = 0;
    let maxHandPull = 0;
    let totalTension = 0;
    let primaryMuzzle = null;

    for (const [handId, tether] of target.tethers.entries()) {
      const hand = handStates.find((h) => h && h.handId === handId);
      if (!hand) continue;

      activeTethers++;
      const screenMuzzle = vision.pointToScreen(hand.shooterMuzzle);
      tether.curMuzzle = screenMuzzle;
      if (!primaryMuzzle) primaryMuzzle = screenMuzzle;

      const pullData = vision.pullDataMap?.get(handId) || { pullAmount: 0, tension: 0 };
      tether.pullAmount = pullData.pullAmount;
      tether.tension = pullData.tension;
      maxHandPull = Math.max(maxHandPull, tether.pullAmount);
      totalTension += tether.tension;
    }

    if (activeTethers === 0) {
      target.lostHandFrames = (target.lostHandFrames || 0) + 1;
      if (target.lostHandFrames > 40) {
        return { status: 'HAND_LOST', target };
      }
      primaryMuzzle = target.lastValidMuzzle || target.renderPos;
    } else {
      target.lostHandFrames = 0;
      target.lastValidMuzzle = { ...primaryMuzzle };
    }

    const targetProgress = Math.max(0, Math.min(1.0, maxHandPull));
    target.pullProgress += (targetProgress - target.pullProgress) * 0.25;

    const destX = target.originalCenter.x + (primaryMuzzle.x - target.originalCenter.x) * target.pullProgress * 0.8;
    const destY = target.originalCenter.y + (primaryMuzzle.y - target.originalCenter.y) * target.pullProgress * 0.8;

    const kSpring = 0.4;
    const cDamping = 0.7;
    const fx = (destX - target.renderPos.x) * kSpring;
    const fy = (destY - target.renderPos.y) * kSpring;

    target.velocity.x = (target.velocity.x + fx) * cDamping;
    target.velocity.y = (target.velocity.y + fy) * cDamping;

    target.renderPos.x += target.velocity.x;
    target.renderPos.y += target.velocity.y;

    target.currentScale = 1.0 + target.pullProgress * 1.8;
    target.tiltAngle = Math.max(-0.25, Math.min(0.25, target.velocity.x * 0.015));
    target.lastTension = Math.min(1.0, totalTension / Math.max(1, activeTethers));

    if (target.pullProgress >= 0.85 && !target.isCaught) {
      target.isCaught = true;
      return { status: 'CAUGHT', target };
    }

    return {
      status: 'REELING',
      target,
      pullProgress: target.pullProgress,
      tension: target.lastTension,
      activeTethers,
    };
  }

  // Render ONLY the contour cutout of the object without rectangular boxes
  draw(ctx, now) {
    const target = this.latchedTarget;
    if (!target) return;

    const { renderPos, originalCenter, screenBox, snapshotCanvas, currentScale, tiltAngle, pullProgress } = target;

    ctx.save();

    if (pullProgress > 0.03) {
      ctx.save();
      ctx.strokeStyle = 'rgba(102, 246, 255, 0.45)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(originalCenter.x, originalCenter.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (pullProgress > 0.02) {
      const shadowY = renderPos.y + pullProgress * 40;
      ctx.save();
      ctx.translate(renderPos.x, shadowY);
      ctx.scale(currentScale * 0.9, currentScale * 0.45);
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.55, 0.15 + pullProgress * 0.4)})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, screenBox.w * 0.5, screenBox.h * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(renderPos.x, renderPos.y);
    ctx.rotate(tiltAngle);
    ctx.scale(currentScale, currentScale);

    const halfW = screenBox.w * 0.5;
    const halfH = screenBox.h * 0.5;

    if (snapshotCanvas) {
      ctx.save();
      ctx.drawImage(snapshotCanvas, -halfW, -halfH, screenBox.w, screenBox.h);
      ctx.restore();
    }

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#66f6ff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.restore();
  }

  release() {
    const latched = this.latchedTarget;
    this.latchedTarget = null;
    return latched;
  }
}