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
      isPulling: false,
      lastPullTime: performance.now(),
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
      pullAnchor: null, // set when the fist closes; pull is measured from here
      tension: 0,
      pullAmount: 0,
    };
  }
 
  update(handStates, vision, now = performance.now()) {
    const target = this.latchedTarget;
    if (!target) return null;
 
    let presentTethers = 0;
    let totalTension = 0;
    let tensionCount = 0;
    let primaryMuzzle = null;
    const activePulls = [];
 
    for (const [handId, tether] of target.tethers.entries()) {
      const hand = handStates.find((h) => h && h.handId === handId);
      const pd = vision.pullDataMap?.get(handId);
      const touchDriven = !!(pd && pd.touch);
 
      if (!hand && !touchDriven) {
        tether.pullAmount = 0;
        tether.tension = 0;
        continue;
      }
 
      presentTethers++;
      if (hand) tether.curMuzzle = vision.pointToScreen(hand.shooterMuzzle);
      if (!primaryMuzzle) primaryMuzzle = tether.curMuzzle;
 
      // Movement 4 (pull) only counts while this strand's hand is making a fist (or touch-dragging)
      if (pd && pd.active) {
        tether.pullAmount = pd.pullAmount;
        tether.tension = pd.tension;
        activePulls.push(pd.pullAmount);
        totalTension += pd.tension;
        tensionCount++;
      } else {
        tether.pullAmount = 0;
        tether.tension = 0;
      }
    }
 
    if (presentTethers === 0) {
      target.lostHandFrames = (target.lostHandFrames || 0) + 1;
      if (target.lostHandFrames > 15) {
        return { status: 'HAND_LOST', target };
      }
      primaryMuzzle = target.lastValidMuzzle || target.renderPos;
    } else {
      target.lostHandFrames = 0;
      target.lastValidMuzzle = { ...primaryMuzzle };
    }
 
    // Light objects: any fist pulling moves it. Heavy objects: EVERY required strand must be
    // attached AND pulling (both fists), so the effective pull is the weakest strand.
    // When nobody is pulling the object simply HOLDS where it is.
    let targetProgress = target.pullProgress;
    if (target.heavy) {
      const haveAll = target.tethers.size >= target.requiredTethers;
      const allPulling = haveAll && activePulls.length >= target.requiredTethers;
      target.waitingForHands = !allPulling;
      if (allPulling) targetProgress = Math.min(...activePulls);
    } else {
      target.waitingForHands = false;
      if (activePulls.length) targetProgress = Math.max(...activePulls);
    }
    target.isPulling = tensionCount > 0 && !target.waitingForHands;

    if (activePulls.length > 0 && tensionCount > 0) {
      target.lastPullTime = now;
    }
    if (!target.lastPullTime) target.lastPullTime = now;

    // Inactivity release: if latched and not pulling for 2.5 seconds, release the object
    if (!target.isCaught && now - target.lastPullTime > 2500) {
      return { status: 'IDLE_TIMEOUT', target };
    }

    targetProgress = Math.max(0, Math.min(1.0, targetProgress));
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
 
    const avgTension = tensionCount ? Math.min(1.0, totalTension / tensionCount) : 0;
    target.lastTension = target.isPulling ? avgTension : target.lastTension * 0.85;
 
    if (target.pullProgress >= 0.85 && !target.isCaught) {
      target.isCaught = true;
      return { status: 'CAUGHT', target };
    }

    if (target.isCaught) {
      return {
        status: 'CAUGHT',
        target,
        pullProgress: target.pullProgress,
        tension: target.lastTension,
        activeTethers: presentTethers,
        waitingForHands: false,
      };
    }

    return {
      status: 'REELING',
      target,
      pullProgress: target.pullProgress,
      tension: target.lastTension,
      activeTethers: presentTethers,
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