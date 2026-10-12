// Master Spider-Man AR Game Engine
 
import { sound } from './audio.js';
import { GestureAnalyzer } from './gestures.js';
import { VisionPipeline } from './vision.js';
import { WebSystem } from './web.js';
import { ARObjectManager } from './ar-objects.js';
import { SpiderHUD } from './hud.js';
import { VirtualObjects } from './virtual-objects.js';
import { AmbientLife } from './ambient.js';
 
const HAND_HOLD_MS = 280;      // keep last known hands briefly when a frame has no new result
const SHOOT_COOLDOWN_MS = 750;
const LOCK_GRACE_MS = 750;        // keep the aim lock this long after the fingertip drifts off the object (the flick itself moves it)
const RELEASE_ARM_MS = 600;       // after latching, an open palm is ignored this long (the hand is still settling after the flick)
const GIVE_UP_OPEN_MS = 450;      // never gripped + open palm held this long = player gave up -> release
const HAND_ID_MEMORY_MS = 1500;   // how long a hand's identity (id 0 / 1) is remembered after it leaves tracking
const HAND_ID_MATCH_DIST = 0.4;   // max normalised wrist travel between frames to count as the same hand
 
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
    this.virtuals = new VirtualObjects();
    this.ambient = new AmbientLife();
    this.objectMode = 'REAL'; // REAL | VIRTUAL | BOTH
    this.handMemory = new Map(); // handId -> { state, t } so one dropped frame never loses a hand
    this.aimNoLockSince = 0;
 
    this.running = false;
    this.rafId = null;
    this.listenersBound = false;
 
    this.handStates = [];
    this.lastHandsSeenAt = -Infinity;
    this.lockedTarget = null;
    this.lockSeenAt = 0;
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
 
  vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
  }

  showCaughtBanner(label) {
    if (!this.ui.caughtBanner) return;
    this.ui.caughtBanner.textContent = 'TARGET REELED IN!';
    this.ui.caughtBanner.classList.remove('show');
    void this.ui.caughtBanner.offsetWidth;
    this.ui.caughtBanner.classList.add('show');
    this.hud.triggerFlash();
  }
 
  // Pointing ray from the aiming hand: finger base -> fingertip, extended ahead of the finger.
  computeAimRay(hand) {
    const tip = this.vision.pointToScreen(hand.aimTarget);
    const base = this.vision.pointToScreen(hand.aimBase || hand.aimTarget);
    let dx = tip.x - base.x, dy = tip.y - base.y;
    const len = Math.hypot(dx, dy);
    if (len < 4) return { tip, end: tip, dir: { x: 0, y: -1 }, reach: 0 };
    dx /= len; dy /= len;
    const reach = Math.max(90, Math.min(this.vision.screenWidth * 0.42, len * 2.4));
    return { tip, dir: { x: dx, y: dy }, end: { x: tip.x + dx * reach, y: tip.y + dy * reach }, reach };
  }

  // Picks the object the player means. Priority: the object under the fingertip, then objects the
  // finger is pointing at (sampled along the pointing ray), then the nearest one. The current lock
  // gets a loyalty bonus so the crosshair never flickers between neighbours.
  getBestTarget(aimPoint, maxRectDist = Infinity, ray = null) {
    const detections = this.vision.trackedDetections;
    if (!detections || detections.length === 0) return null;

    let best = null;
    let minScore = Infinity;

    const ref = aimPoint || { x: this.vision.screenWidth * 0.5, y: this.vision.screenHeight * 0.5 };
    const stickyId = this.lockedTarget?.detection?.id;
    const samples = [ref];
    if (ray && ray.reach > 0) {
      for (let k = 1; k <= 4; k++) samples.push({ x: ref.x + ray.dir.x * ray.reach * (k / 4), y: ref.y + ray.dir.y * ray.reach * (k / 4) });
    }

    for (const det of detections) {
      const rect = this.vision.boxToScreen(det.bbox);
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;

      // Never target the player's own hand
      if (!det.virtual && this.vision.isHandDetection(rect, this.handStates)) continue;

      const center = { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.5 };

      let score = Infinity;
      samples.forEach((pt, k) => {
        const dx = Math.max(rect.x - pt.x, 0, pt.x - (rect.x + rect.w));
        const dy = Math.max(rect.y - pt.y, 0, pt.y - (rect.y + rect.h));
        const d = Math.hypot(dx, dy);
        const limit = k === 0 ? maxRectDist : maxRectDist * 0.55;
        if (d > limit) return;
        let sc = d * (2.2 + k * 0.7) + k * 30;
        if (d <= 0.0001) sc -= k === 0 ? 500 : 300 - k * 45;
        if (sc < score) score = sc;
      });
      if (score === Infinity) continue;

      const centerDist = Math.hypot(ref.x - center.x, ref.y - center.y);
      score += centerDist * 0.25 + (det.manual ? -150 : 0);
      if (det.id === stickyId) score -= 90;

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
        // The hand jumped (fast motion / tracking gap). With a single hand in view it is almost
        // certainly the same player's hand, so keep the most recently tracked id - otherwise a web
        // tethered to that id would silently stop responding to the pull.
        let rt = -Infinity;
        for (const id of [0, 1]) {
          const p = this.handTrack.get(id);
          if (p && p.t > rt) { rt = p.t; best = id; }
        }
        if (best == null) best = 0;
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
    for (let i = 0; i < ids.length; i++) {
      const landmarks = rawHands.landmarks[i];
      const worldLms = rawHands.worldLandmarks?.[i];
      const handedness = rawHands.handednesses?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
      const analysis = this.gestures.analyzeHand(landmarks, worldLms, handedness, ids[i], now);
      if (analysis) states.push(analysis);
    }
    return states;
  }

  // Each hand is remembered on its own for a short while, so when tracking drops ONE of two hands
  // for a frame (common with far-away or fast hands) the other one - and the two-hand heavy logic -
  // keeps working.
  updateHandStates(now) {
    const rawHands = this.vision.detectHands(now); // null on throttled frames

    if (rawHands && rawHands.landmarks && rawHands.landmarks.length > 0) {
      for (const st of this.analyzeHands(rawHands, now)) this.handMemory.set(st.handId, { state: st, t: now });
      this.lastHandsSeenAt = now;
    }

    const live = [];
    for (const [id, m] of this.handMemory) {
      if (now - m.t > HAND_HOLD_MS) this.handMemory.delete(id);
      else live.push(m.state);
    }
    live.sort((a, b) => a.handId - b.handId);
    if (live.length === 0 && this.handStates.length > 0) this.gestures.reset();
    this.handStates = live;
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
          latched.originalCenter,
          this.vision.screenWidth
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
        if (hand.isHandReleased || hand.isOpenPalm) return true;
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
 
  setCoach(title, sub) {
    if (this.ui.hintTitle && this.ui.hintTitle.textContent !== title) this.ui.hintTitle.textContent = title;
    if (this.ui.hintSub && this.ui.hintSub.textContent !== sub) this.ui.hintSub.textContent = sub;
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
    this.hud.aimRay = null;
    if (phase === 'AIM') {
      const lead = aimHands.find((h) => h.isSpideyPose) || aimHands[0];
      const ray = this.computeAimRay(lead);
      this.hud.aimRay = ray;
      // freeze the lock while the wrist is flicking so the shot can't slide to another object
      if (lead.isSpideyPose && lead.flickProgress < 0.25 && lead.flickSpeed < 1.0) {
        const snapRadius = Math.max(80, Math.min(170, this.vision.screenWidth * 0.2));
        let target = this.getBestTarget(ray.tip, snapRadius, ray);
        // Newcomer assist: held the pose for a moment with nothing close? Snap to the nearest object.
        if (!target) {
          if (!this.aimNoLockSince) this.aimNoLockSince = now;
          if (now - this.aimNoLockSince > 900) target = this.getBestTarget(ray.tip, Infinity, ray);
        } else {
          this.aimNoLockSince = 0;
        }
        if (target) {
          if (!this.lockedTarget || this.lockedTarget.detection.id !== target.detection.id) {
            sound.playSpiderSense();
            this.vibrate(8);
          }
          this.lockedTarget = target;
          this.lockSeenAt = now;
        } else if (this.lockedTarget && now - this.lockSeenAt > LOCK_GRACE_MS) {
          this.lockedTarget = null; // crosshair has been off the object for a while
        }
      }
      this.refreshLockedTarget();
    } else {
      this.aimNoLockSince = 0;
      if (phase === 'IDLE' || latched) this.lockedTarget = null;
    }

    // ---- HUD text + beginner coaching per movement ----
    if (phase === 'REEL' || phase === 'LATCH') {
      const anyFist = this.handStates.some((h) => h.isFist || h.fistHeld);
      let detail;
      if (latched.heavy && latched.tethers.size < latched.requiredTethers) detail = 'SECOND WEB INCOMING…';
      else if (latched.heavy) detail = anyFist ? 'HEAVY! BOTH HANDS: FIST + PULL BACK' : 'HEAVY! MAKE A FIST WITH BOTH HANDS';
      else detail = anyFist ? 'PULLING… KEEP PULLING BACK' : 'MAKE A FIST & PULL BACK TO REEL';
      this.setHandText('4 · PULL', detail, Math.round(latched.pullProgress * 100));
      this.setCoach(
        latched.heavy ? '✊✊ CLOSE BOTH FISTS · PULL BACK' : '✊ CLOSE YOUR FIST · PULL BACK',
        'Pull toward your body like reeling in a rope. Open your hand to let go.'
      );
      return;
    }

    if (phase === 'FIRE') {
      this.setHandText('3 · SHOOT', 'WEB IN FLIGHT…', 100);
      this.setCoach('🕸️ THWIP!', 'Web is on its way…');
      return;
    }

    if (phase === 'AIM') {
      const t = this.lockedTarget;
      if (t) {
        const need2 = t.detection.heavy && this.handStates.length < 2;
        this.setHandText(
          '2 · AIM LOCKED',
          need2 ? 'HEAVY TARGET — SHOW BOTH HANDS' : t.detection.heavy ? 'HEAVY · FLICK EITHER WRIST DOWN' : 'FLICK YOUR WRIST DOWN TO SHOOT',
          Math.round(20 + 80 * Math.max(...aimHands.map((h) => h.flickProgress || 0)))
        );
        this.setCoach(
          need2 ? '🙌 HEAVY! BRING BOTH HANDS IN VIEW' : '🎯 LOCKED · FLICK WRIST DOWN',
          need2 ? 'Heavy targets need both hands on camera. Make the Spidey pose with each.' : 'A quick snap of the wrist downward fires the web.'
        );
      } else {
        this.setHandText('2 · AIMING', 'POINT YOUR INDEX FINGER AT AN OBJECT', 40);
        this.setCoach('☝ POINT AT A TARGET', 'Aim your index finger at an object — the crosshair will snap on to it.');
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
    this.setCoach(
      this.handStates.length ? '🤟 MAKE THE SPIDEY POSE' : '🖐 SHOW YOUR HAND',
      this.handStates.length ? 'Index + pinky up, middle + ring fingers folded down.' : "Hold a hand up to the camera. Works at arm's length or further."
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
    if (!det.virtual && this.vision.isHandDetection(rect, this.handStates)) return;
    t.detection = det;
    t.rect = rect;
    t.center = { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.5 };
  }

  // Movement 3: from the AIM pose, a quick wrist flick DOWN fires the web at the locked target.
  // Heavy targets: both hands must be visible; a flick from EITHER hand fires BOTH webs.
  tryGestureShoot(now, aimHands) {
    const target = this.lockedTarget;
    if (!target || this.arObjects.latchedTarget) return;
    if (now - this.lastShootTime < SHOOT_COOLDOWN_MS) return;
    if (!aimHands.some((h) => h.isFlickDown)) return;

    if (target.detection.heavy) {
      if (this.handStates.length < 2) {
        if (now - this.lastHeavyHintTime > 2500) {
          this.lastHeavyHintTime = now;
          this.showToast('Heavy target! Show BOTH hands, then flick.');
        }
        return;
      }
      this.lastShootTime = now;
      this.tryShootWeb(this.handStates.slice(0, 2), target);
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
      this.showToast('No target yet — point the camera at something or enable virtual objects.');
      return;
    }

    if (target.detection.heavy) {
      if (this.handStates.length < 2) {
        this.showToast('Heavy target! Show BOTH hands to the camera, then tap THWIP.');
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
      this.ambient.scare(performance.now());
      this.vibrate(12);
      this.updateStatus('THWIP! WEB IN FLIGHT', 'tracking');

      this.web.shootProjectile({
        start: screenMuzzle,
        end: targetPoint,
        handId,
        onImpact: () => {
          this.activeProjectiles.delete(handId);
          if (token !== this.shotToken) return; // released/rescanned while in flight
          sound.playImpact();
          this.hud.triggerShake(5, 140);
          this.vibrate(25);

          let latched = this.arObjects.latchedTarget;
          if (!latched || latched.id !== target.detection.id) {
            let snapshot = null;
            try {
              snapshot = target.detection.virtual ? target.detection.sprite : this.vision.captureObjectSnapshot(target.rect);
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
          this.web.attachWebPatch(latched, targetPoint);

          if (latched.heavy && latched.tethers.size < latched.requiredTethers) {
            this.showToast('First web attached — second strand incoming!');
          } else if (latched.heavy) {
            this.showToast('Both webs stuck — FIST + pull BOTH hands back!');
            this.updateStatus('BOTH HANDS: FIST + PULL', 'tracking');
          } else {
            this.showToast('Web stuck — make a FIST and pull back!');
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
    if (released) this.web.detachWebPatches(released);
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
 
  setObjectMode(mode) {
    this.objectMode = mode;
    if (this.arObjects.latchedTarget || this.activeProjectiles.size) this.releaseWeb();
    this.lockedTarget = null;
    this.vision.setRealEnabled(mode !== 'VIRTUAL');
    this.virtuals.setEnabled(mode !== 'REAL');
    this.showToast(
      mode === 'REAL' ? 'Real objects only' : mode === 'VIRTUAL' ? 'Virtual objects only — great for practice!' : 'Real + virtual objects'
    );
  }

  cycleObjectMode() {
    const order = ['REAL', 'VIRTUAL', 'BOTH'];
    const next = order[(order.indexOf(this.objectMode) + 1) % order.length];
    this.setObjectMode(next);
    return next;
  }

  updateObjectScanning(now) {
    // The object detector runs on the main thread (~tens of ms per pass). While a web is in flight or
    // latched we don't need new detections, and running it caused the stutter while reeling in.
    const webBusy = !!this.arObjects.latchedTarget || this.activeProjectiles.size > 0;
    this.virtuals.update(now, this.vision, this.arObjects.latchedTarget?.id);
    const detections = webBusy || this.objectMode === 'VIRTUAL' ? this.vision.trackedDetections : this.vision.detectObjects(now);
    if (this.ui.objectCount) {
      this.ui.objectCount.textContent = `${this.collectedCount} COLLECTED`;
    }
    if (this.ui.objectState) {
      this.ui.objectState.textContent = detections.length > 0 ? `${detections.length} TARGETS` : 'SEARCHING';
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
      this.hud.triggerShake(4, 120);
      this.vibrate([30, 40, 60]);
      this.showCaughtBanner();
      this.web.shockwaves.push({ x: update.target.renderPos.x, y: update.target.renderPos.y, born: now, life: 650, maxRadius: 150 });
      this.hud.spawnBurst(update.target.renderPos);
      return;
    }

    if (update.status === 'COLLECTED') {
      if (update.target.detection.virtual) this.virtuals.remove(update.target.detection.id);
      this.releaseWeb(`Target collected · total ${this.collectedCount}`);
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

    const shake = this.hud.getShakeOffset(now);
    if (shake.x || shake.y) this.ctx.translate(shake.x, shake.y);

    const latched = this.arObjects.latchedTarget;
 
    // Ambient corner webs + crawling spiders sit furthest back
    this.ambient.draw(this.ctx, w, h, now);

    // 0. Virtual objects live in the scene underneath the targeting overlay
    this.virtuals.draw(this.ctx, now, latched?.id);

    // 1. Draw target detections (only on camera view before latching)
    this.hud.drawDetections(
      this.ctx,
      this.vision.trackedDetections,
      this.vision,
      latched?.id,
      this.lockedTarget,
      this.phase,
      now
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
 
    // 6b. Speed lines while reeling in
    if (latched && latched.isPulling) this.hud.drawSpeedLines(this.ctx, w, h, Math.min(1, latched.lastTension * 0.6 + latched.pullProgress * 0.6), now);

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
    this.virtuals.setEnabled(false);
    this.virtuals.setEnabled(this.objectMode !== 'REAL');
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