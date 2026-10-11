// Augmented Reality Pure Object Cutout & Reeling Physics
// Brings ONLY the visual cutout of the real object closer with realistic 3D depth (NO bounding boxes!)
// Heavy objects (chairs, laptops, bags...) need TWO web tethers, and BOTH hands must pull.
 
export class ARObjectManager {
  constructor() {
    this.latchedTarget = null;
  }
 
  attachWeb({ detection, screenBox, snapshotCanvas, handId, startMuzzle }) {
    const center = { x: screenBox.x + screenBox.w * 0.5, y: screenBox.y + screenBox.h * 0.5 };
    const heavy = !!detection.heavy;
 
    const tethers = new Map();
    tethers.set(handId, this._makeTether(handId, startMuzzle));
 
    this.latchedTarget = {
      id: detection.id || `target_${Date.now()}`,
      detection,
      heavy,
      requiredTethers: heavy ? 2 : 1,
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
      waitingForHands: heavy,
    };
 
    return this.latchedTarget;
  }
 
  // Adds a second web strand (used by heavy objects) to the already-latched target.
  addTether({ handId, startMuzzle }) {
    const target = this.latchedTarget;
    if (!target) return null;
    if (!target.tethers.has(handId)) {
      target.tethers.set(handId, this._makeTether(handId, startMuzzle));
    }
    return target.tethers.get(handId);
  }
 
  _makeTether(handId, startMuzzle) {
    return {
      handId,
      startMuzzle: { ...startMuzzle },
      curMuzzle: { ...startMuzzle },
      initialHand: null,
      tension: 0,
      pullAmount: 0,
    };
  }
 
  update(handStates, vision) {
    const target = this.latchedTarget;
    if (!target) return null;
 
    let activeTethers = 0;
    let totalTension = 0;
    let primaryMuzzle = null;
    const pulls = [];
 
    for (const [handId, tether] of target.tethers.entries()) {
      const hand = handStates.find((h) => h && h.handId === handId);
      const pullData = vision.pullDataMap?.get(handId);
      const touchDriven = !!(pullData && pullData.touch);
 
      if (!hand && !touchDriven) {
        tether.pullAmount = 0;
        tether.tension = 0;
        pulls.push(0); // a missing hand contributes no pull
        continue;
      }
 
      activeTethers++;
      if (hand) tether.curMuzzle = vision.pointToScreen(hand.shooterMuzzle);
      if (!primaryMuzzle) primaryMuzzle = tether.curMuzzle;
 
      const pd = pullData || { pullAmount: 0, tension: 0 };
      tether.pullAmount = pd.pullAmount;
      tether.tension = pd.tension;
      pulls.push(tether.pullAmount);
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
 
    // Light objects: strongest hand wins. Heavy objects: every required hand must pull,
    // so the effective pull is the WEAKEST strand (and 0 until both strands are attached).
    let effectivePull;
    if (target.heavy) {
      const haveAll = target.tethers.size >= target.requiredTethers && pulls.length >= target.requiredTethers;
      target.waitingForHands = !haveAll || activeTethers < target.requiredTethers;
      effectivePull = haveAll ? Math.min(...pulls) : 0;
    } else {
      target.waitingForHands = false;
      effectivePull = pulls.length ? Math.max(...pulls) : 0;
    }
 
    const targetProgress = Math.max(0, Math.min(1.0, effectivePull));
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
      waitingForHands: target.waitingForHands,
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