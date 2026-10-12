// Augmented Reality Pure Object Cutout & Reeling Physics
// Brings ONLY the visual cutout of the real object closer with realistic 3D depth (NO bounding boxes!)
// Heavy objects (chairs, laptops, bags...) need TWO web tethers, and BOTH hands must pull.
 
const CATCH_PROGRESS = 0.85;   // pull progress at which the object counts as reeled in
const COLLECT_MS = 420;        // length of the "zip into the hand" collection animation
const HAND_LOST_MS = 650;      // how long a pulling hand may vanish from tracking before the web drops
const IDLE_RELEASE_MS = 4000;  // latched but nobody gripping for this long -> let go

// Wrap the cutout in silk: thin white strands criss-crossing the object, clipped to its exact
// silhouette (source-atop), so it looks bound by the web instead of just tethered to it.
function wrapInWeb(snapshot) {
  if (!snapshot) return null;
  const w = snapshot.width, h = snapshot.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.drawImage(snapshot, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.lineCap = 'round';
  const lw = Math.max(1, Math.min(w, h) / 120);
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * Math.PI * 2;
    const cx = w * (0.2 + Math.random() * 0.6), cy = h * (0.2 + Math.random() * 0.6);
    const len = Math.max(w, h);
    g.strokeStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.4})`;
    g.lineWidth = lw * (0.6 + Math.random() * 0.9);
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len);
    g.quadraticCurveTo(cx + (Math.random() - 0.5) * w * 0.3, cy + (Math.random() - 0.5) * h * 0.3, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    g.stroke();
  }
  const fog = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
  fog.addColorStop(0, 'rgba(255,255,255,0.22)');
  fog.addColorStop(1, 'rgba(255,255,255,0.05)');
  g.fillStyle = fog;
  g.fillRect(0, 0, w, h);
  return c;
}

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
      webbedCanvas: wrapInWeb(snapshotCanvas),
      tethers,
      pullProgress: 0,
      currentScale: 1.0,
      tiltAngle: 0,
      isCaught: false,
      attachTime: performance.now(),
      lastTension: 0,
      handLostSince: null,
      lastValidMuzzle: { ...startMuzzle },
      lastUpdate: performance.now(),
      alpha: 1,
      caughtAt: 0,
      collectFrom: null,
      waitingForHands: heavy,
      isPulling: false,
      lastPullTime: performance.now(),
      trail: [],
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
      engaged: false,   // true once this strand's hand has made a fist (so opening it later = release)
      openSince: null,  // when the hand started showing an open palm without ever gripping
      pullAnchor: null, // set when the fist closes; pull is measured from here
      tension: 0,
      pullAmount: 0,
    };
  }
 
  update(handStates, vision, now = performance.now()) {
    const target = this.latchedTarget;
    if (!target) return null;

    // Frame-rate independent timing (dt clamped so a tab stall can't teleport the object)
    const dt = Math.max(0.001, Math.min(0.05, (now - (target.lastUpdate ?? now)) / 1000));
    target.lastUpdate = now;
    const frames60 = dt * 60;

    let presentTethers = 0;
    let totalTension = 0;
    let tensionCount = 0;
    const muzzles = [];
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
      muzzles.push(tether.curMuzzle);

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

    // Where the object is being pulled to: the average of all present hands (no jumping between hands)
    let primaryMuzzle = null;
    if (muzzles.length) {
      primaryMuzzle = {
        x: muzzles.reduce((sum, m) => sum + m.x, 0) / muzzles.length,
        y: muzzles.reduce((sum, m) => sum + m.y, 0) / muzzles.length,
      };
    }

    if (presentTethers === 0) {
      // Hand tracking drops out a lot when a fist moves fast toward the camera, so be forgiving (by time, not frames)
      if (target.handLostSince == null) target.handLostSince = now;
      if (!target.isCaught && now - target.handLostSince > HAND_LOST_MS) {
        return { status: 'HAND_LOST', target };
      }
      primaryMuzzle = target.lastValidMuzzle || target.renderPos;
    } else {
      target.handLostSince = null;
      target.lastValidMuzzle = { ...primaryMuzzle };
    }

    // ---- Collection: object zips into the hand, shrinking and fading ----
    if (target.isCaught) {
      const t = Math.max(0, Math.min(1, (now - target.caughtAt) / COLLECT_MS));
      const e = t * t * (3 - 2 * t); // smoothstep
      const from = target.collectFrom;
      const prevX = target.renderPos.x;
      target.renderPos.x = from.x + (primaryMuzzle.x - from.x) * e;
      target.renderPos.y = from.y + (primaryMuzzle.y - from.y) * e;
      target.velocity.x = (target.renderPos.x - prevX) / Math.max(0.5, frames60);
      target.currentScale = from.scale * (1 - 0.72 * e);
      target.alpha = 1 - Math.max(0, Math.min(1, (t - 0.55) / 0.45));
      target.tiltAngle *= 0.9;
      target.lastTension *= 0.85;
      target.isPulling = false;

      if (t >= 1) return { status: 'COLLECTED', target };
      return {
        status: 'COLLECTING',
        target,
        pullProgress: target.pullProgress,
        tension: target.lastTension,
        activeTethers: presentTethers,
        waitingForHands: false,
      };
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

    // Inactivity release: latched but nobody has been gripping for a while -> let the object go
    if (now - target.lastPullTime > IDLE_RELEASE_MS) {
      return { status: 'IDLE_TIMEOUT', target };
    }

    targetProgress = Math.max(0, Math.min(1.0, targetProgress));
    // Same feel as the old 0.25-per-frame easing at 60fps, but independent of the frame rate
    target.pullProgress += (targetProgress - target.pullProgress) * (1 - Math.pow(0.75, frames60));

    const destX = target.originalCenter.x + (primaryMuzzle.x - target.originalCenter.x) * target.pullProgress * 0.8;
    const destY = target.originalCenter.y + (primaryMuzzle.y - target.originalCenter.y) * target.pullProgress * 0.8;

    // Critically-damped follow (no spring overshoot / wobble, and hand jitter gets smoothed out)
    const follow = 1 - Math.exp(-dt / 0.07);
    const prevX = target.renderPos.x;
    target.renderPos.x += (destX - target.renderPos.x) * follow;
    target.renderPos.y += (destY - target.renderPos.y) * follow;
    target.velocity.x = (target.renderPos.x - prevX) / Math.max(0.5, frames60);
    target.velocity.y = 0;

    target.currentScale = 1.0 + target.pullProgress * 1.8;
    target.tiltAngle = Math.max(-0.25, Math.min(0.25, target.velocity.x * 0.015));

    // Speed-blur trail: recorded only while actually moving fast, for a believable motion smear.
    if (Math.abs(target.velocity.x) > 1.2) {
      target.trail.push({ x: target.renderPos.x, y: target.renderPos.y, scale: target.currentScale, angle: target.tiltAngle });
      if (target.trail.length > 5) target.trail.shift();
    } else if (target.trail.length) {
      target.trail.shift();
    }

    const avgTension = tensionCount ? Math.min(1.0, totalTension / tensionCount) : 0;
    target.lastTension = target.isPulling ? avgTension : target.lastTension * 0.85;

    if (target.pullProgress >= CATCH_PROGRESS) {
      target.isCaught = true;
      target.caughtAt = now;
      target.collectFrom = { x: target.renderPos.x, y: target.renderPos.y, scale: target.currentScale };
      return { status: 'CAUGHT', target }; // reported exactly ONCE; COLLECTING / COLLECTED follow
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
    ctx.globalAlpha = Math.max(0, Math.min(1, target.alpha ?? 1)); // fades out while being collected
    ctx.imageSmoothingQuality = 'high';
 
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
 
    // Motion-blur ghost trail while the object is whipping toward the hand
    if (snapshotCanvas && target.trail && target.trail.length > 1) {
      const halfW0 = screenBox.w * 0.5;
      const halfH0 = screenBox.h * 0.5;
      const n = target.trail.length;
      for (let i = 0; i < n - 1; i++) {
        const g = target.trail[i];
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, (target.alpha ?? 1))) * (0.08 + (i / n) * 0.1);
        ctx.translate(g.x, g.y);
        ctx.rotate(g.angle);
        ctx.scale(g.scale, g.scale);
        ctx.drawImage(snapshotCanvas, -halfW0, -halfH0, screenBox.w, screenBox.h);
        ctx.restore();
      }
    }

    ctx.save();
    ctx.translate(renderPos.x, renderPos.y);
    ctx.rotate(tiltAngle);
    ctx.scale(currentScale, currentScale);

    const halfW = screenBox.w * 0.5;
    const halfH = screenBox.h * 0.5;

    if (snapshotCanvas) {
      ctx.save();
      // soft glow hugging the exact silhouette (shadow follows the cutout's alpha)
      ctx.shadowColor = target.heavy ? 'rgba(255, 120, 150, 0.85)' : 'rgba(120, 235, 255, 0.85)';
      ctx.shadowBlur = 8 + pullProgress * 18;
      ctx.drawImage(target.webbedCanvas || snapshotCanvas, -halfW, -halfH, screenBox.w, screenBox.h);
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