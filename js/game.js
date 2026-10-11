// Master Spider-Man AR Game Engine
 
import { sound } from './audio.js';
import { GestureAnalyzer } from './gestures.js';
import { VisionPipeline } from './vision.js';
import { WebSystem } from './web.js';
import { ARObjectManager } from './ar-objects.js';
import { SpiderHUD } from './hud.js';
 
const HAND_HOLD_MS = 300;      // keep last known hands this long when a frame has no new result
const SHOOT_COOLDOWN_MS = 750;
 
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
    this.listenersBound = false;
 
    this.handStates = [];
    this.lastHandsSeenAt = -Infinity;
    this.lockedTarget = null;
    this.activeProjectiles = new Set();
    this.shotToken = 0; // bumps on release so in-flight webs from an old shot are ignored
    this.touchDrag = null;
    this.touchPullAmount = 0;
    this.lastWhooshTime = 0;
    this.lastShootTime = 0;
    this.lastHeavyHintTime = 0;
    this.phase = 'IDLE'; // IDLE -> AIM -> FIRE -> LATCH -> REEL
  }
 
  async start() {
    this.updateStatus('STARTING CAMERA…', 'idle');
    sound.init();
 
    await this.vision.startCamera('environment');
    this.updateStatus('LOADING VISION AI MODELS…', 'idle');
 
    await this.vision.initModels((msg) => {
      this.updateStatus(msg, 'idle');
      if (this.ui.startButton) this.ui.startButton.textContent = msg;
    });
 
    this.running = true;
    this.updateStatus('SCANNING OBJECTS', 'ready');
    if (this.ui.gate) this.ui.gate.classList.add('hidden');
    this.showToast('Spidey pose to AIM · flick wrist DOWN to SHOOT · FIST + pull to REEL');
 
    if (!this.listenersBound) {
      window.addEventListener('resize', () => this.vision.resizeCanvas());
      this.setupInteractions();
      this.listenersBound = true;
    }
 
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
 
  // aimPoint: screen point to aim at (defaults to screen centre).
  // maxRectDist: only lock objects whose box is within this many px of the aim point.
  getBestTarget(aimPoint, maxRectDist = Infinity) {
    const detections = this.vision.trackedDetections;
    if (!detections || detections.length === 0) return null;
 
    let best = null;
    let minScore = Infinity;
 
    const ref = aimPoint || { x: this.vision.screenWidth * 0.5, y: this.vision.screenHeight * 0.5 };
 
    for (const det of detections) {
      const rect = this.vision.boxToScreen(det.bbox);
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;
      const center = { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.5 };
 
      const dx = Math.max(rect.x - ref.x, 0, ref.x - (rect.x + rect.w));
      const dy = Math.max(rect.y - ref.y, 0, ref.y - (rect.y + rect.h));
      const rectDist = Math.hypot(dx, dy);
      if (rectDist > maxRectDist) continue;
 
      const centerDist = Math.hypot(ref.x - center.x, ref.y - center.y);
      const score = rectDist * 2 + centerDist + (det.manual ? -150 : 0);
 
      if (score < minScore) {
        minScore = score;
        best = { detection: det, rect, center, distance: centerDist };
      }
    }
 
    return best;
  }
 
  // Turn a fresh MediaPipe result into analysed hand states
  analyzeHands(rawHands, now) {
    const states = [];
    for (let i = 0; i < rawHands.landmarks.length; i++) {
      const landmarks = rawHands.landmarks[i];
      const worldLms = rawHands.worldLandmarks?.[i];
      const handedness = rawHands.handednesses?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
      const analysis = this.gestures.analyzeHand(landmarks, worldLms, handedness, i, now);
      if (analysis) states.push(analysis);
    }
    return states;
  }
 
  updateHandStates(now) {
    const rawHands = this.vision.detectHands(now); // null on throttled frames
 
    if (rawHands && rawHands.landmarks && rawHands.landmarks.length > 0) {
      this.handStates = this.analyzeHands(rawHands, now);
      this.lastHandsSeenAt = now;
    }
 
    // Drop the hands only after they have been missing for a moment (avoids flicker/false release)
    if (this.handStates.length > 0 && now - this.lastHandsSeenAt > HAND_HOLD_MS) {
      this.handStates = [];
      this.gestures.reset();
    }
  }
 
  // Movement 4: PULL. Only counts while the hand is a FIST; measured from where the fist closed.
  buildPullMap() {
    const pullMap = new Map();
    const latched = this.arObjects.latchedTarget;
    if (!latched) return pullMap;
 
    for (const [id, tether] of latched.tethers.entries()) {
      const hand = this.handStates.find((h) => h.handId === id);
      let pull = { pullAmount: 0, tension: 0, active: false };
 
      const fist = hand && (hand.isFist || hand.fistHeld);
      if (fist) {
        const curMuzzle = this.vision.pointToScreen(hand.shooterMuzzle);
        if (!tether.pullAnchor) {
          tether.pullAnchor = {
            hand: { ...hand },
            muzzle: curMuzzle,
            base: latched.pullProgress, // continue from wherever the object already is
          };
        }
        const raw = this.gestures.calculatePull(
          tether.pullAnchor.hand,
          hand,
          curMuzzle,
          tether.pullAnchor.muzzle,
          latched.originalCenter
        );
        const total = Math.min(1, tether.pullAnchor.base + raw.pullAmount);
        pull = { pullAmount: total, tension: Math.min(1, Math.max(raw.tension, total * 0.5)), active: true };
      } else {
        tether.pullAnchor = null; // fist opened: re-anchor next time
      }
 
      // Touch-drag pulling works with or without hands (counts as every strand)
      if (this.touchPullAmount > 0) {
        pull = {
          pullAmount: Math.max(pull.pullAmount, this.touchPullAmount),
          tension: Math.max(pull.tension, this.touchPullAmount * 1.2),
          active: true,
          touch: true,
        };
      }
      pullMap.set(id, pull);
    }
    return pullMap;
  }
 
  isAimHand(h) {
    return !!(h && (h.isSpideyPose || h.aimRecently));
  }
 
  setStep(n) {
    const steps = this.ui.steps;
    if (!steps) return;
    steps.forEach((el, i) => el.classList.toggle('active', i === n - 1));
  }
 
  setHandText(state, detail, meter) {
    if (this.ui.handState) this.ui.handState.textContent = state;
    if (this.ui.handDetail) this.ui.handDetail.textContent = detail;
    if (this.ui.gestureMeter) this.ui.gestureMeter.style.width = `${meter}%`;
  }
 
  processHandGestures(now) {
    this.updateHandStates(now);
    this.vision.pullDataMap = this.buildPullMap();
 
    const latched = this.arObjects.latchedTarget;
 
    // Deliberate open palm while attached = let go
    if (latched && this.handStates.some((h) => h.openHeld)) {
      this.releaseWeb('Web released');
      return;
    }
 
    const aimHands = this.handStates.filter((h) => this.isAimHand(h));
 
    // ---- Work out which of the 4 movements we are in ----
    let phase;
    if (latched) phase = latched.pullProgress > 0.05 ? 'REEL' : 'LATCH';
    else if (this.activeProjectiles.size > 0) phase = 'FIRE';
    else if (aimHands.length > 0) phase = 'AIM';
    else phase = 'IDLE';
    this.phase = phase;
    this.setStep({ IDLE: 1, AIM: 2, FIRE: 3, LATCH: 4, REEL: 4 }[phase]);
 
    // ---- Target locking (only while aiming) ----
    if (phase === 'AIM') {
      const lead = aimHands.find((h) => h.isSpideyPose) || aimHands[0];
      // freeze the lock while the wrist is flicking so the shot can't slide to another object
      if (lead.isSpideyPose && lead.flickSpeed < 1.0) {
        const aim = this.vision.pointToScreen(lead.aimTarget);
        const target = this.getBestTarget(aim, 90);
        if (target && (!this.lockedTarget || this.lockedTarget.detection.id !== target.detection.id)) {
          sound.playSpiderSense();
        }
        this.lockedTarget = target;
      }
    } else if (phase === 'IDLE' || latched) {
      this.lockedTarget = null;
    }
 
    // ---- HUD text per movement ----
    if (phase === 'REEL' || phase === 'LATCH') {
      const anyFist = this.handStates.some((h) => h.isFist || h.fistHeld);
      let detail;
      if (latched.heavy && latched.tethers.size < latched.requiredTethers) detail = 'SECOND WEB INCOMING…';
      else if (latched.heavy) detail = anyFist ? 'HEAVY! BOTH HANDS: FIST + PULL BACK' : 'HEAVY! MAKE A FIST WITH BOTH HANDS';
      else detail = anyFist ? 'PULLING… KEEP PULLING BACK' : 'MAKE A FIST & PULL BACK TO REEL';
      this.setHandText('4 · PULL', detail, Math.round(latched.pullProgress * 100));
      return;
    }
 
    if (phase === 'FIRE') {
      this.setHandText('3 · SHOOT', 'WEB IN FLIGHT…', 100);
      return;
    }
 
    if (phase === 'AIM') {
      const t = this.lockedTarget;
      if (t) {
        const need2 = t.detection.heavy && aimHands.length < 2;
        this.setHandText(
          '2 · AIM LOCKED',
          need2
            ? `${t.detection.class.toUpperCase()} IS HEAVY — AIM WITH BOTH HANDS`
            : `${t.detection.class.toUpperCase()} · FLICK WRIST DOWN TO SHOOT`,
          75
        );
      } else {
        this.setHandText('2 · AIMING', 'MOVE CROSSHAIR ONTO AN OBJECT', 40);
      }
      this.tryGestureShoot(now, aimHands);
      return;
    }
 
    // IDLE: hands may be visible, but nothing happens
    this.setHandText(
      '1 · IDLE',
      this.handStates.length ? 'MAKE SPIDEY POSE (☝ + 🤙) TO AIM' : 'SHOW HAND TO CAMERA',
      10
    );
  }
 
  // Movement 3: from the AIM pose, a quick wrist flick DOWN fires the web at the locked target
  tryGestureShoot(now, aimHands) {
    const target = this.lockedTarget;
    if (!target || this.arObjects.latchedTarget) return;
    if (now - this.lastShootTime < SHOOT_COOLDOWN_MS) return;
    if (!aimHands.some((h) => h.isFlickDown)) return;
 
    if (target.detection.heavy) {
      if (aimHands.length < 2) {
        if (now - this.lastHeavyHintTime > 2500) {
          this.lastHeavyHintTime = now;
          this.showToast('Heavy object! Aim with BOTH hands, then flick.');
        }
        return;
      }
      this.lastShootTime = now;
      this.tryShootWeb(aimHands.slice(0, 2), target);
    } else {
      const shooter = aimHands.find((h) => h.isFlickDown) || aimHands[0];
      this.lastShootTime = now;
      this.tryShootWeb([shooter], target);
    }
  }
 
  // THWIP button / screen tap
  triggerShootAction() {
    if (this.arObjects.latchedTarget) {
      this.releaseWeb('Web released');
      return;
    }
 
    const target = this.lockedTarget || this.getBestTarget(null, Infinity);
    if (!target) {
      this.showToast('Aim camera at an object first!');
      return;
    }
 
    if (target.detection.heavy) {
      if (this.handStates.length < 2) {
        this.showToast('Heavy object! Show BOTH hands to the camera, then tap THWIP.');
        return;
      }
      this.tryShootWeb(this.handStates.slice(0, 2), target);
    } else {
      this.tryShootWeb(this.handStates.length ? [this.handStates[0]] : [], target);
    }
  }
 
  // hands: array of analysed hand states (empty array = fire from the bottom of the screen)
  tryShootWeb(hands, target) {
    if (!target) return;
    const shooters = hands.length ? hands : [null];
    const token = this.shotToken;
 
    shooters.forEach((hand, idx) => {
      const handId = hand?.handId ?? 0;
      if (this.activeProjectiles.has(handId)) return;
 
      const screenMuzzle = hand
        ? this.vision.pointToScreen(hand.shooterMuzzle)
        : { x: this.vision.screenWidth * 0.5, y: this.vision.screenHeight * 0.9 };
 
      // Fan two strands slightly apart so heavy shots read as two webs
      const spread = shooters.length > 1 ? (idx === 0 ? -10 : 10) : 0;
      const targetPoint = { x: target.center.x + spread, y: target.center.y };
 
      this.activeProjectiles.add(handId);
      sound.playThwip(1.0);
      this.updateStatus('THWIP! WEB IN FLIGHT', 'tracking');
 
      this.web.shootProjectile({
        start: screenMuzzle,
        end: targetPoint,
        handId,
        onImpact: () => {
          this.activeProjectiles.delete(handId);
          if (token !== this.shotToken) return; // released/rescanned while in flight
          sound.playImpact();
 
          let latched = this.arObjects.latchedTarget;
          if (!latched || latched.id !== target.detection.id) {
            let snapshot = null;
            try {
              snapshot = this.vision.captureObjectSnapshot(target.rect);
            } catch (err) {
              console.warn('Snapshot capture error:', err);
            }
            latched = this.arObjects.attachWeb({
              detection: target.detection,
              screenBox: target.rect,
              snapshotCanvas: snapshot,
              handId,
              startMuzzle: screenMuzzle,
            });
          } else {
            this.arObjects.addTether({ handId, startMuzzle: screenMuzzle });
          }
 
          if (latched.heavy && latched.tethers.size < latched.requiredTethers) {
            this.showToast('First web attached — second strand incoming!');
          } else if (latched.heavy) {
            this.showToast(`Both webs stuck to ${target.detection.class} — FIST + pull BOTH hands back!`);
            this.updateStatus('BOTH HANDS: FIST + PULL', 'tracking');
          } else {
            this.showToast(`Web stuck to ${target.detection.class} — make a FIST and pull back!`);
            this.updateStatus('FIST + PULL BACK TO REEL', 'tracking');
          }
        },
      });
    });
  }
 
  releaseWeb(reason = '') {
    this.shotToken++;
    this.activeProjectiles.clear();
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
      this.updateStatus('SCANNING OBJECTS', 'ready');
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
      this.releaseWeb('Hand lost — web released');
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
 
    // 1. Draw target detections (only on camera view before latching)
    this.hud.drawDetections(
      this.ctx,
      this.vision.trackedDetections,
      this.vision,
      latched?.id,
      this.lockedTarget,
      this.phase
    );
 
    // 2. Draw latched object cutout and its web tethers
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
 
    // 3. Draw wrist web-shooter & biometric skeleton
    this.hud.drawHandSkeleton(this.ctx, this.handStates, this.vision, now);
    if (this.phase !== 'IDLE') {
      for (const hand of this.handStates) {
        const screenMuzzle = this.vision.pointToScreen(hand.shooterMuzzle);
        this.web.drawWristShooter(this.ctx, screenMuzzle, this.isAimHand(hand), now);
      }
    }
 
    // 4. Update and render web projectiles & impact visual effects
    this.web.update(now);
    this.web.render(this.ctx, now);
 
    // 5. Draw HUD reticles and aiming crosshairs
    this.hud.drawCrosshairs(
      this.ctx,
      this.handStates,
      this.vision,
      latched,
      this.lockedTarget,
      now,
      this.phase
    );
 
    // 6. Draw manual drag selection if active
    if (this.touchDrag && !this.touchDrag.isClick && !this.arObjects.latchedTarget) {
      const { start, cur } = this.touchDrag;
      this.ctx.save();
      this.ctx.strokeStyle = '#d5ff85';
      this.ctx.lineWidth = 2.0;
      this.ctx.setLineDash([6, 4]);
      this.ctx.strokeRect(start.x, start.y, cur.x - start.x, cur.y - start.y);
      this.ctx.restore();
    }
 
    // 7. Visual FX bursts & screen flashes
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
 
      if (this.arObjects.latchedTarget) {
        const pullDy = e.clientY - this.touchDrag.start.y;
        this.touchPullAmount = Math.max(0, Math.min(1.0, pullDy / 130));
      }
    });
 
    this.canvas.addEventListener('pointerup', (e) => {
      const drag = this.touchDrag;
      if (!drag || drag.pointerId !== e.pointerId) return;
 
      this.touchPullAmount = 0; // finger lifted: stop pulling
 
      if (drag.isClick) {
        this.triggerShootAction();
      } else if (!this.arObjects.latchedTarget) {
        const x = Math.min(drag.start.x, drag.cur.x);
        const y = Math.min(drag.start.y, drag.cur.y);
        const w = Math.abs(drag.cur.x - drag.start.x);
        const h = Math.abs(drag.cur.y - drag.start.y);
 
        if (w >= 28 && h >= 28) {
          this.vision.addManualTarget({ x, y, w, h });
          this.showToast('Custom target added! Aim at it with Spidey pose.');
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
    this.releaseWeb();
    try {
      const mode = await this.vision.switchCamera();
      this.showToast(`Camera switched to ${mode === 'user' ? 'Selfie Camera' : 'Rear Camera'}`);
      this.updateStatus('SCANNING OBJECTS', 'ready');
      return mode;
    } catch (e) {
      this.showToast('Could not switch camera');
      this.updateStatus('SCANNING OBJECTS', 'ready');
      return null;
    }
  }
 
  rescan() {
    this.releaseWeb();
    this.vision.clearTargets();
    this.lockedTarget = null;
    this.showToast('Rescanning area for objects…');
    this.updateStatus('SCANNING OBJECTS', 'ready');
  }
 
  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.vision.stop();
    sound.stopTension();
  }
}