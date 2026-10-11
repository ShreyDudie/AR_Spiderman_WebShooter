// Master Spider-Man AR Game Engine
// Features: Wrist down to shoot, Wrist back to pull, Auto Target Lock, Pure AR Object Cutout Reeling

import { sound } from './audio.js';
import { GestureAnalyzer } from './gestures.js';
import { VisionPipeline } from './vision.js';
import { WebSystem } from './web.js';
import { ARObjectManager } from './ar-objects.js';
import { SpiderHUD } from './hud.js';

export class SpideyGame {
  constructor(elements) {
    this.video = elements.video;
    this.canvas = elements.canvas;
    this.ctx = this.canvas.getContext('2d');
    this.ui = elements.ui;

    this.vision = new VisionPipeline(this.video, this.canvas);
    this.gestures = new GestureAnalyzer();
    this.web = new WebSystem();
    this.arObjects = new ARObjectManager();
    this.hud = new SpiderHUD();

    this.running = false;
    this.rafId = null;

    this.handStates = [];
    this.lockedTarget = null;
    this.activeProjectiles = new Set();
    this.touchDrag = null;
    this.touchPullAmount = 0;
    this.lastWhooshTime = 0;
    this.lastShootTime = 0;
  }

  async start() {
    this.updateStatus('STARTING CAMERA…', 'idle');
    sound.init();

    await this.vision.startCamera('environment'); // Rear camera for mobile AR
    this.updateStatus('LOADING VISION AI MODELS…', 'idle');

    await this.vision.initModels((msg) => {
      this.updateStatus(msg, 'idle');
      if (this.ui.startButton) this.ui.startButton.textContent = msg;
    });

    this.running = true;
    this.updateStatus('SCANNING SMALL OBJECTS', 'ready');
    if (this.ui.gate) this.ui.gate.classList.add('hidden');
    this.showToast('Spider-Sense active! Flick wrist DOWN or tap THWIP to shoot web!');

    window.addEventListener('resize', () => this.vision.resizeCanvas());
    this.setupInteractions();

    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  updateStatus(text, state = 'ready') {
    if (this.ui.statusText) this.ui.statusText.textContent = text;
    if (this.ui.statusBadge) this.ui.statusBadge.dataset.state = state;
  }

  showToast(text) {
    if (!this.ui.toast) return;
    this.ui.toast.textContent = text;
    this.ui.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.ui.toast.classList.remove('show'), 2400);
  }

  showCaughtBanner(label) {
    if (!this.ui.caughtBanner) return;
    this.ui.caughtBanner.textContent = `${label.toUpperCase()} REELED IN!`;
    this.ui.caughtBanner.classList.remove('show');
    void this.ui.caughtBanner.offsetWidth;
    this.ui.caughtBanner.classList.add('show');
    this.hud.triggerFlash();
  }

  // Get the best locked target on screen (closest to screen center or hand aim)
  getBestTarget(aimPoint) {
    const detections = this.vision.trackedDetections;
    if (!detections || detections.length === 0) return null;

    let best = null;
    let minScore = Infinity;

    const screenCenterX = this.vision.screenWidth * 0.5;
    const screenCenterY = this.vision.screenHeight * 0.5;
    const refPoint = aimPoint || { x: screenCenterX, y: screenCenterY };

    for (const det of detections) {
      const rect = this.vision.boxToScreen(det.bbox);
      const center = { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.5 };

      const dist = Math.hypot(refPoint.x - center.x, refPoint.y - center.y);
      const priorityBonus = det.manual ? -150 : 0;
      const score = dist + priorityBonus;

      if (score < minScore) {
        minScore = score;
        best = { detection: det, rect, center, distance: dist };
      }
    }

    return best;
  }

  processHandGestures(now) {
    const rawHands = this.vision.detectHands(now);
    this.handStates = [];

    const pullMap = new Map();

    if (rawHands && rawHands.landmarks && rawHands.landmarks.length > 0) {
      for (let i = 0; i < rawHands.landmarks.length; i++) {
        const landmarks = rawHands.landmarks[i];
        const worldLms = rawHands.worldLandmarks?.[i];
        const handedness = rawHands.handednesses?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');

        const handAnalysis = this.gestures.analyzeHand(landmarks, worldLms, handedness, i);
        if (!handAnalysis) continue;

        this.handStates.push(handAnalysis);

        const latched = this.arObjects.latchedTarget;
        if (latched && latched.tethers.has(i)) {
          const tether = latched.tethers.get(i);
          const curMuzzle = this.vision.pointToScreen(handAnalysis.shooterMuzzle);
          const pull = this.gestures.calculatePull(
            tether.initialHand,
            handAnalysis,
            curMuzzle,
            tether.startMuzzle,
            latched.originalCenter
          );

          // Blend with touch pull if active
          if (this.touchPullAmount > 0) {
            pull.pullAmount = Math.max(pull.pullAmount, this.touchPullAmount);
            pull.tension = Math.max(pull.tension, this.touchPullAmount * 1.2);
          }
          pullMap.set(i, pull);
        }
      }
    } else {
      // If hand leaves camera view while tethered without touch pull, release web immediately!
      if (this.arObjects.latchedTarget && this.touchPullAmount === 0) {
        this.releaseWeb('Wrist released');
        return;
      }
    }

    this.vision.pullDataMap = pullMap;

    // Check Open Palm gesture to release web
    for (const hand of this.handStates) {
      if (hand.isOpenPalm && this.arObjects.latchedTarget) {
        this.releaseWeb('Wrist released');
        return;
      }
    }

    // Determine target candidate
    const primaryHand = this.handStates[0];
    const screenAim = primaryHand
      ? this.vision.pointToScreen(primaryHand.aimTarget)
      : { x: this.vision.screenWidth * 0.5, y: this.vision.screenHeight * 0.5 };

    if (!this.arObjects.latchedTarget) {
      const target = this.getBestTarget(screenAim);
      if (target && (!this.lockedTarget || this.lockedTarget.detection.id !== target.detection.id)) {
        sound.playSpiderSense();
      }
      this.lockedTarget = target;
    } else {
      this.lockedTarget = null;
    }

    // Update UI readout
    const latched = this.arObjects.latchedTarget;
    if (latched) {
      if (this.ui.handState) this.ui.handState.textContent = 'WEB TETHER LIVE';
      if (this.ui.handDetail) this.ui.handDetail.textContent = 'PULL WRIST BACK TOWARDS YOU TO REEL';
      if (this.ui.gestureMeter) {
        this.ui.gestureMeter.style.width = `${Math.round(latched.pullProgress * 100)}%`;
      }
    } else if (primaryHand) {
      if (primaryHand.isSpideyPose) {
        if (this.ui.handState) this.ui.handState.textContent = 'SPIDEY POSE READY ✓';
        if (this.ui.handDetail) {
          this.ui.handDetail.textContent = this.lockedTarget
            ? `LOCKED: ${this.lockedTarget.detection.class.toUpperCase()} · WEB FIRED!`
            : 'AIM AT TARGET OBJECT';
        }
        if (this.ui.gestureMeter) this.ui.gestureMeter.style.width = '100%';
      } else {
        const j = primaryHand.jointStates || {};
        let stateHint = 'MAKE SPIDEY POSE';
        if (!j.indexExtended) stateHint = 'EXTEND INDEX FINGER';
        else if (!j.pinkyExtended) stateHint = 'EXTEND PINKY FINGER';
        else if (!j.middleCurled || !j.ringCurled) stateHint = 'CURL MIDDLE & RING';

        if (this.ui.handState) this.ui.handState.textContent = 'BIO-JOINTS SCANNING';
        if (this.ui.handDetail) this.ui.handDetail.textContent = stateHint;
        if (this.ui.gestureMeter) this.ui.gestureMeter.style.width = '45%';
      }

      // Check Shooting Trigger: Shoot ONLY on verified Spidey Pose (no random firing!)
      const shouldShoot =
        primaryHand.isSpideyPose &&
        this.lockedTarget &&
        !this.arObjects.latchedTarget &&
        now - this.lastShootTime > 700;

      if (shouldShoot) {
        this.lastShootTime = now;
        this.tryShootWeb(primaryHand, this.lockedTarget);
      }
    } else {
      if (this.ui.handState) this.ui.handState.textContent = this.lockedTarget ? 'TARGET LOCKED' : 'SEARCHING';
      if (this.ui.handDetail) this.ui.handDetail.textContent = this.lockedTarget ? 'TAP THWIP TO SHOOT' : 'SHOW HAND TO CAMERA';
      if (this.ui.gestureMeter) this.ui.gestureMeter.style.width = '10%';
    }
  }

  // Shoot web action (triggered by gesture, button, or tap)
  triggerShootAction() {
    if (this.arObjects.latchedTarget) {
      this.releaseWeb('Web released');
      return;
    }

    const target = this.lockedTarget || this.getBestTarget();
    if (target) {
      const primaryHand = this.handStates[0];
      this.tryShootWeb(primaryHand, target);
    } else {
      this.showToast('Aim camera at a small object first!');
    }
  }

  tryShootWeb(hand, target) {
    if (!target) return;
    const handId = hand?.handId ?? 0;
    if (this.activeProjectiles.has(handId)) return;

    const screenMuzzle = hand
      ? this.vision.pointToScreen(hand.shooterMuzzle)
      : { x: this.vision.screenWidth * 0.5, y: this.vision.screenHeight * 0.9 };

    const targetPoint = target.center;

    this.activeProjectiles.add(handId);
    sound.playThwip(1.0);
    this.updateStatus('THWIP! WEB IN FLIGHT', 'tracking');

    this.web.shootProjectile({
      start: screenMuzzle,
      end: targetPoint,
      handId,
      onImpact: () => {
        this.activeProjectiles.delete(handId);
        sound.playImpact();

        // Safely extract pure AR cutout texture snapshot
        let snapshot = null;
        try {
          snapshot = this.vision.captureObjectSnapshot(target.rect);
        } catch (err) {
          console.warn('Snapshot capture error:', err);
        }

        // Attach tether
        const attached = this.arObjects.attachWeb({
          detection: target.detection,
          screenBox: target.rect,
          snapshotCanvas: snapshot,
          handId,
          startMuzzle: screenMuzzle,
        });

        const tether = attached.tethers.get(handId);
        if (tether && hand) {
          tether.initialHand = { ...hand };
        }

        this.showToast(`Web attached to ${target.detection.class} — pull wrist BACK to reel!`);
        this.updateStatus('PULL WRIST BACK TO REEL', 'tracking');
      },
    });
  }

  releaseWeb(reason = '') {
    const released = this.arObjects.release();
    this.touchPullAmount = 0;
    try {
      sound.stopTension();
      sound.playWebSnap();
    } catch (e) {}

    if (released) {
      try {
        this.hud.spawnBurst(released.renderPos);
      } catch (e) {}
      this.updateStatus('SCANNING SMALL OBJECTS', 'ready');
      if (reason) this.showToast(reason);
    }
  }

  updateObjectScanning(now) {
    const detections = this.vision.detectObjects(now);
    if (this.ui.objectCount) {
      this.ui.objectCount.textContent = `${detections.length} DETECTED`;
    }
    if (this.ui.objectState) {
      this.ui.objectState.textContent = detections.length > 0 ? 'TARGETS LOCKED' : 'SEARCHING';
    }
  }

  updateReelingPhysics(now) {
    const update = this.arObjects.update(this.handStates, this.vision);
    if (!update) return;

    if (update.status === 'HAND_LOST') {
      this.releaseWeb('Wrist released');
      return;
    }

    if (update.status === 'CAUGHT') {
      sound.stopTension();
      sound.playCatch();
      this.showCaughtBanner(update.target.detection.class);
      this.hud.spawnBurst(update.target.renderPos);
      return;
    }

    if (update.status === 'REELING') {
      sound.updateTension(update.tension);

      if (update.pullProgress > 0.12 && now - this.lastWhooshTime > 550) {
        sound.playReelWhoosh(update.pullProgress);
        this.lastWhooshTime = now;
      }
    }
  }

  render(now) {
    const dpr = this.vision.dpr;
    const w = this.vision.screenWidth;
    const h = this.vision.screenHeight;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);

    const latched = this.arObjects.latchedTarget;

    // 1. Draw detected small objects
    this.hud.drawDetections(
      this.ctx,
      this.vision.trackedDetections,
      this.vision,
      latched?.id,
      this.lockedTarget
    );

    // 2. Draw latched pure AR object cutout
    if (latched) {
      this.arObjects.draw(this.ctx, now);

      for (const [handId, tether] of latched.tethers.entries()) {
        const hand = this.handStates.find((h) => h.handId === handId);
        const screenMuzzle = hand
          ? this.vision.pointToScreen(hand.shooterMuzzle)
          : tether.startMuzzle;
        this.web.drawTether(this.ctx, screenMuzzle, latched.renderPos, latched.lastTension, now);
      }
    }

    // 3. Draw biometric hand skeleton scanner & wrist web-shooter
    this.hud.drawHandSkeleton(this.ctx, this.handStates, this.vision, now);
    for (const hand of this.handStates) {
      const screenMuzzle = this.vision.pointToScreen(hand.shooterMuzzle);
      this.web.drawWristShooter(this.ctx, screenMuzzle, hand.isSpideyPose, now);
    }

    // 4. Update and render web projectiles, splats, sparks
    this.web.update(now);
    this.web.render(this.ctx, now);

    // 5. Draw HUD crosshairs & lock-on reticle
    this.hud.drawCrosshairs(
      this.ctx,
      this.handStates,
      this.vision,
      latched,
      this.lockedTarget,
      now
    );

    // 6. Draw manual drag box if dragging
    if (this.touchDrag && !this.touchDrag.isClick) {
      const { start, cur } = this.touchDrag;
      this.ctx.save();
      this.ctx.strokeStyle = '#d5ff85';
      this.ctx.lineWidth = 2.0;
      this.ctx.setLineDash([6, 4]);
      this.ctx.strokeRect(start.x, start.y, cur.x - start.x, cur.y - start.y);
      this.ctx.restore();
    }

    // 7. Draw screen bursts & flash
    this.hud.drawBursts(this.ctx, now);
    this.hud.drawScreenFlash(this.ctx, w, h);
  }

  loop(now) {
    if (!this.running) return;

    try {
      this.processHandGestures(now);
      this.updateObjectScanning(now);
      this.updateReelingPhysics(now);
      this.render(now);
    } catch (err) {
      console.warn('Frame render error:', err);
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  setupInteractions() {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.running || e.button !== 0) return;
      this.touchDrag = {
        pointerId: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        cur: { x: e.clientX, y: e.clientY },
        isClick: true,
      };
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.touchDrag || this.touchDrag.pointerId !== e.pointerId) return;
      this.touchDrag.cur = { x: e.clientX, y: e.clientY };

      const moveDist = Math.hypot(e.clientX - this.touchDrag.start.x, e.clientY - this.touchDrag.start.y);
      if (moveDist > 12) {
        this.touchDrag.isClick = false;
      }

      // If latched, dragging down on screen pulls the object!
      if (this.arObjects.latchedTarget) {
        const pullDy = e.clientY - this.touchDrag.start.y;
        this.touchPullAmount = Math.max(0, Math.min(1.0, pullDy / 130));
      }
    });

    this.canvas.addEventListener('pointerup', (e) => {
      const drag = this.touchDrag;
      if (!drag || drag.pointerId !== e.pointerId) return;

      if (drag.isClick) {
        // Tapped screen: shoot at locked target or release!
        this.triggerShootAction();
      } else if (!this.arObjects.latchedTarget) {
        // Dragged a custom target box
        const x = Math.min(drag.start.x, drag.cur.x);
        const y = Math.min(drag.start.y, drag.cur.y);
        const w = Math.abs(drag.cur.x - drag.start.x);
        const h = Math.abs(drag.cur.y - drag.start.y);

        if (w >= 28 && h >= 28) {
          this.vision.addManualTarget({ x, y, w, h });
          this.showToast('Custom target locked! Flick wrist DOWN or tap THWIP!');
        }
      }

      this.touchDrag = null;
    });

    this.canvas.addEventListener('pointercancel', () => {
      this.touchDrag = null;
      this.touchPullAmount = 0;
    });
  }

  async switchCamera() {
    this.updateStatus('SWITCHING CAMERA…', 'idle');
    try {
      const mode = await this.vision.switchCamera();
      this.showToast(`Camera switched to ${mode === 'user' ? 'Selfie Camera' : 'Rear Camera'}`);
      this.updateStatus('SCANNING SMALL OBJECTS', 'ready');
      return mode;
    } catch (e) {
      console.error('Camera switch error:', e);
      this.showToast('Could not switch camera');
      this.updateStatus('SCANNING SMALL OBJECTS', 'ready');
      return null;
    }
  }

  rescan() {
    this.releaseWeb();
    this.vision.clearTargets();
    this.showToast('Rescanning area for small objects…');
    this.updateStatus('SCANNING SMALL OBJECTS', 'ready');
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.vision.stop();
    sound.stopTension();
  }
}
