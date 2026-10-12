// Master Spider-Man AR Game Engine
 
import { sound } from './audio.js';
import { GestureAnalyzer } from './gestures.js';
import { VisionPipeline } from './vision.js';
import { WebSystem } from './web.js';
import { ARObjectManager } from './ar-objects.js';
import { SpiderHUD } from './hud.js';
import { PullFX } from './pull-fx.js';
 
const HAND_HOLD_MS = 220;      // keep last known hands briefly when a frame has no new result
const SHOOT_COOLDOWN_MS = 750;
const LOCK_GRACE_MS = 400;        // keep the aim lock this long after the fingertip drifts off the object (the flick itself moves it)
const RELEASE_ARM_MS = 600;       // after latching, an open palm is ignored this long (the hand is still settling after the flick)
const GIVE_UP_OPEN_MS = 450;      // never gripped + open palm held this long = player gave up -> release
const HAND_ID_MEMORY_MS = 1500;   // how long a hand's identity (id 0 / 1) is remembered after it leaves tracking
const HAND_ID_MATCH_DIST = 0.4;   // max normalised wrist travel between frames to count as the same hand
const HAND_ID_RECENT_MS = 900;    // a lone hand that reappears far away is still the hand seen most recently within this time
const LOCK_RADIUS_PX = 110;       // fingertip must be within this many px of an object's box to lock it
const LOCK_SWITCH_MS = 140;       // a different object must stay the best candidate this long before the lock moves to it
const LOCK_MEMORY_MS = 900;       // a flick may fire at the last locked object this long after the lock was lost
const RELEASE_OPEN_MS = 200;      // a gripping hand must stay open this long before the web drops (single noisy frames are ignored)
const PULL_TRAVEL_PALMS = 2.2;    // hand travel (in palm-lengths) for one full reel ... (about a third of the screen)
const PULL_TRAVEL_MIN = 0.25;     // ... clamped to this fraction of the smaller screen side
const PULL_TRAVEL_MAX = 0.60;     // ... and this fraction
const SCAN_INTERVAL_MS = 200;     // object detection interval normally
const SCAN_INTERVAL_AIM_MS = 700; // slower while aiming at a locked object: the detector blocks the main thread and starves hand tracking mid-flick
 
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
    this.pullFx = new PullFX();
 
    this.running = false;
    this.rafId = null;
    this.listenersBound = false;
 
    this.handStates = [];
    this.lastHandsSeenAt = -Infinity;
    this.lockedTarget = null;
    this.lockSeenAt = 0;
    this.lastLock = null;   // { target, t } the most recent lock, kept briefly so a flick that drags the finger off the object still fires
    this.pendingLock = null; // { id, since } candidate waiting to replace the current lock
    this.collectedCount = 0;
    this.handTrack = new Map(); // stable handId -> { x, y, t } (last wrist position)
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
    this.showToast('Spidey pose to AIM · flick your wrist to SHOOT · FIST + pull to REEL');
 
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
 
      // Never target the player's own hand
      if (this.vision.isHandDetection(rect, this.handStates)) continue;
 
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
 
  // MediaPipe returns hands in an arbitrary order that can swap between frames. A web is tied to a
  // handId, so a swap used to make the wrong hand pull / release it. Match hands to the previous
  // frame by wrist position so each physical hand keeps the same id (0 or 1).
  assignHandIds(rawHands, now) {
    const n = Math.min(2, rawHands.landmarks.length);
    for (const [id, p] of this.handTrack) {
      if (now - p.t > HAND_ID_MEMORY_MS) this.handTrack.delete(id);
    }
    const wrists = [];
    for (let i = 0; i < n; i++) wrists.push({ x: rawHands.landmarks[i][0].x, y: rawHands.landmarks[i][0].y });
 
    const dist = (i, id) => {
      const p = this.handTrack.get(id);
      return p ? Math.hypot(wrists[i].x - p.x, wrists[i].y - p.y) : null;
    };
 
    const ids = [];
    if (n === 1) {
      let best = null;
      let bestD = HAND_ID_MATCH_DIST;
      for (const id of [0, 1]) {
        const d = dist(0, id);
        if (d != null && d < bestD) { bestD = d; best = id; }
      }
      if (best == null) {
        // Too far from where either hand was last seen (fast pull, tracking dropout). Before: the hand was
        // handed a NEW id, so the web's tether never found its hand again and the pull silently died.
        // Now: it is the hand seen most recently, if that was a moment ago.
        let recent = null;
        let recentT = -Infinity;
        for (const id of [0, 1]) {
          const p = this.handTrack.get(id);
          if (p && now - p.t < HAND_ID_RECENT_MS && p.t > recentT) { recentT = p.t; recent = id; }
        }
        best = recent != null ? recent : !this.handTrack.has(0) ? 0 : !this.handTrack.has(1) ? 1 : (dist(0, 0) <= dist(0, 1) ? 0 : 1);
      }
      ids.push(best);
    } else if (n === 2) {
      const c = (i, id) => dist(i, id) ?? 0.5; // unknown history = neutral cost
      const straight = c(0, 0) + c(1, 1);
      const swapped = c(0, 1) + c(1, 0);
      if (swapped < straight - 0.02) ids.push(1, 0);
      else ids.push(0, 1);
    }
    for (let i = 0; i < n; i++) this.handTrack.set(ids[i], { ...wrists[i], t: now });
    return ids;
  }
 
  // Turn a fresh MediaPipe result into analysed hand states
  analyzeHands(rawHands, now) {
    const states = [];
    const ids = this.assignHandIds(rawHands, now);
    const aspect = this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 1;
 
    // One light web + exactly one hand in view: that hand IS the web's hand, whatever id tracking gave it.
    const latchedNow = this.arObjects.latchedTarget;
    if (latchedNow && latchedNow.tethers.size === 1 && ids.length === 1) {
      const tetherId = latchedNow.tethers.keys().next().value;
      if (ids[0] !== tetherId) {
        this.handTrack.delete(ids[0]);
        this.gestures.history.delete(ids[0]);
        ids[0] = tetherId;
        this.handTrack.set(tetherId, { x: rawHands.landmarks[0][0].x, y: rawHands.landmarks[0][0].y, t: now });
      }
    }
    for (let i = 0; i < ids.length; i++) {
      const landmarks = rawHands.landmarks[i];
      const worldLms = rawHands.worldLandmarks?.[i];
      const handedness = rawHands.handednesses?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
      const analysis = this.gestures.analyzeHand(landmarks, worldLms, handedness, ids[i], now, aspect);
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
        // continue from wherever the object already is; the state only ever moves forward (ratchet)
        if (!tether.pull) tether.pull = this.gestures.createPullState(latched.pullProgress);
        const palmPx = this.palmLengthPx(hand);
        const minDim = Math.min(this.vision.screenWidth, this.vision.screenHeight);
        const travel = Math.max(
          PULL_TRAVEL_MIN * minDim,
          Math.min(PULL_TRAVEL_MAX * minDim, PULL_TRAVEL_PALMS * palmPx)
        );
        this.gestures.updatePull(tether.pull, hand, curMuzzle, latched.originalCenter, palmPx, travel);
        pull = {
          pullAmount: tether.pull.progress,
          tension: Math.min(1, Math.max(tether.pull.tension, tether.pull.progress * 0.5)),
          active: true,
        };
      } else {
        tether.pull = null; // fist opened / hand missing: next grip restarts from the object's current progress
      }
 
      // Touch-drag pulling works with or without hands (counts as every strand)
      if (this.touchPullAmount > 0) {
        pull = {
          pullAmount: Math.max(pull.pullAmount, this.touchPullAmount),
          tension: Math.min(1, Math.max(pull.tension, this.touchPullAmount * 1.2)),
          active: true,
          touch: true,
        };
      }
      pullMap.set(id, pull);
    }
    return pullMap;
  }
 
  // Palm length (wrist -> middle knuckle) on screen, in px. Used to scale pull distances to the hand's size.
  palmLengthPx(hand) {
    const lm = hand.landmarks;
    if (!lm || lm.length < 21) return 120;
    const a = this.vision.pointToScreen(lm[0]);
    const b = this.vision.pointToScreen(lm[9]);
    return Math.max(40, Math.min(400, Math.hypot(a.x - b.x, a.y - b.y)));
  }
 
  // Decides whether the player has let go of the web.
  //  - Only the hands actually tethered to the object count (an idle open hand elsewhere used to drop the web).
  //  - A hand that has gripped (fist) and then opens releases IMMEDIATELY, no timers.
  //  - A hand that never gripped is ignored right after the flick; if it then stays open ~0.45s the
  //    player has given up, so the web is released.
  checkGestureRelease(now, latched) {
    const age = now - latched.attachTime;
    let anyGripping = false;
    let giveUp = false;
 
    for (const [handId, tether] of latched.tethers.entries()) {
      const hand = this.handStates.find((h) => h.handId === handId);
      if (!hand) continue;
 
      if (hand.isFist || hand.fistHeld) {
        tether.engaged = true;
        tether.openSince = null;
        anyGripping = true;
        continue;
      }
 
      if (tether.engaged) {
        // A fast fist moving towards the camera blurs and can look "open" for a frame or two. Only a hand that
        // stays open for a moment (or is unmistakably wide open) lets go.
        if (hand.isClearlyOpen || (hand.isOpenPalm && hand.openForMs >= RELEASE_OPEN_MS)) return true;
      } else if (age > RELEASE_ARM_MS && hand.isOpenPalm) {
        if (tether.openSince == null) tether.openSince = now;
        if (now - tether.openSince > GIVE_UP_OPEN_MS) giveUp = true;
      } else {
        tether.openSince = null;
      }
    }
    return giveUp && !anyGripping;
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
 
    // Release the instant the pulling hand lets go (see checkGestureRelease)
    if (latched && this.checkGestureRelease(now, latched)) {
      this.releaseWeb('Hand released');
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
      // Freeze the lock as soon as the wrist starts to flick (the flick drags the fingertip off the object,
      // so the first frames of it must not re-aim the shot at something else or drop the lock).
      const flicking = lead.flickProgress >= 0.15 || lead.isFlickDown || lead.flickSpeed >= 1.6;
      if (lead.isSpideyPose && !flicking) {
        const aim = this.vision.pointToScreen(lead.aimTarget);
        const target = this.getBestTarget(aim, LOCK_RADIUS_PX);
        const cur = this.lockedTarget;
        if (target) {
          if (!cur || cur.detection.id === target.detection.id) {
            if (!cur) sound.playSpiderSense();
            this.lockedTarget = target;
            this.pendingLock = null;
          } else {
            // another object is closer to the fingertip: switch only if it stays the best candidate for a moment
            if (!this.pendingLock || this.pendingLock.id !== target.detection.id) {
              this.pendingLock = { id: target.detection.id, since: now };
            }
            if (now - this.pendingLock.since >= LOCK_SWITCH_MS) {
              sound.playSpiderSense();
              this.lockedTarget = target;
              this.pendingLock = null;
            }
          }
          this.lockSeenAt = now;
        } else {
          this.pendingLock = null;
          if (cur && now - this.lockSeenAt > LOCK_GRACE_MS) {
            this.lockedTarget = null; // crosshair has been off the object for a while
          }
        }
      }
      this.refreshLockedTarget();
      if (this.lockedTarget) this.lastLock = { target: this.lockedTarget, t: now };
    } else if (phase === 'IDLE' || latched) {
      this.lockedTarget = null;
      this.pendingLock = null;
      if (phase === 'IDLE') this.lastLock = null;
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
            : `${t.detection.class.toUpperCase()} · FLICK WRIST TO SHOOT`,
          Math.round(20 + 80 * Math.max(...aimHands.map((h) => h.flickProgress || 0)))
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
 
  // Keep the locked target's box in step with the tracker (it moves if the object / camera moves)
  refreshLockedTarget() {
    const t = this.lockedTarget;
    if (!t) return;
    const det = this.vision.trackedDetections.find((d) => d.id === t.detection.id);
    if (!det) return;
    const rect = this.vision.boxToScreen(det.bbox);
    if (!rect || rect.w <= 0 || rect.h <= 0) return;
    if (this.vision.isHandDetection(rect, this.handStates)) return;
    t.detection = det;
    t.rect = rect;
    t.center = { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.5 };
  }
 
  // Movement 3: from the AIM pose, a quick wrist flick DOWN fires the web at the locked target
  tryGestureShoot(now, aimHands) {
    if (this.arObjects.latchedTarget) return;
    if (now - this.lastShootTime < SHOOT_COOLDOWN_MS) return;
    const flickHand = aimHands.find((h) => h.isFlickDown);
    if (!flickHand) return;
 
    // The flick moves the fingertip, so the live lock can be gone by the time the flick is recognised.
    // Fall back to the last lock, then to whatever the fingertip pointed at just BEFORE the flick started.
    let target = this.lockedTarget;
    if (!target && this.lastLock && now - this.lastLock.t < LOCK_MEMORY_MS) {
      target = this.lastLock.target;
      this.lockedTarget = target;
      this.refreshLockedTarget();
      target = this.lockedTarget;
    }
    if (!target && flickHand.aimPast) {
      const past = this.getBestTarget(this.vision.pointToScreen(flickHand.aimPast), LOCK_RADIUS_PX);
      if (past) { this.lockedTarget = past; target = past; }
    }
    if (!target) return;
 
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
    if (target === this.lockedTarget) this.refreshLockedTarget(); // aim + snapshot use the freshest box
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
    this.pullFx.reset();
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
    // The object detector runs on the main thread (~tens of ms per pass). While a web is in flight or
    // latched we don't need new detections, and running it caused the stutter while reeling in.
    const webBusy = !!this.arObjects.latchedTarget || this.activeProjectiles.size > 0;
    const aimingLocked = this.phase === 'AIM' && !!this.lockedTarget;
    const flicking = this.handStates.some((h) => h.flickProgress >= 0.1 || h.isFlickDown);
    const detections = webBusy || flicking
      ? this.vision.trackedDetections
      : this.vision.detectObjects(now, aimingLocked ? SCAN_INTERVAL_AIM_MS : SCAN_INTERVAL_MS);
    if (this.ui.objectCount) {
      this.ui.objectCount.textContent = `${detections.length} DETECTED`;
    }
    if (this.ui.objectState) {
      this.ui.objectState.textContent = detections.length > 0 ? 'TARGETS LOCKED' : 'SEARCHING';
    }
  }
 
  updateReelingPhysics(now) {
    const update = this.arObjects.update(this.handStates, this.vision, now);
    if (!update) return;
 
    if (update.status === 'HAND_LOST') {
      this.releaseWeb('Hand lost — web released');
      return;
    }
 
    if (update.status === 'IDLE_TIMEOUT') {
      this.releaseWeb('Web released');
      return;
    }
 
    if (update.status === 'CAUGHT') {
      // Reported exactly once per object (it used to repeat every frame: sound spam + banner restarts)
      this.collectedCount++;
      sound.stopTension();
      sound.playCatch();
      this.showCaughtBanner(update.target.detection.class);
      this.hud.spawnBurst(update.target.renderPos);
      this.pullFx.onCaught(update.target.renderPos);
      return;
    }
 
    if (update.status === 'COLLECTED') {
      const label = update.target.detection.class;
      this.releaseWeb(`${label} collected · total ${this.collectedCount}`);
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
 
      this.pullFx.draw(this.ctx, now, latched);
 
      for (const [handId, tether] of latched.tethers.entries()) {
        const hand = this.handStates.find((h) => h.handId === handId);
        const screenMuzzle = hand
          ? this.vision.pointToScreen(hand.shooterMuzzle)
          : tether.curMuzzle || tether.startMuzzle;
        this.web.drawTether(this.ctx, screenMuzzle, latched.renderPos, latched.lastTension, now);
      }
    }
 
    if (!latched) this.pullFx.idle(this.ctx, now);
 
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
        this.touchPullAmount = Math.max(0, Math.min(1.0, pullDy / 240));
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