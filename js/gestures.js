// Spider-Man Biometric Hand Scanner & 21-Joint Pose Tracker
// Validates finger joint angles, detects the wrist-flick shoot gesture, and measures pull.
 
// Flick = a SMALL, quick downward movement of the wrist, palm OR fingertip.
// FLICK_SENSITIVITY is the one knob to tune: 1.0 = default, 1.5 = more sensitive, 0.7 = stricter.
const FLICK_SENSITIVITY = 1.6;
const FLICK_NEED = { wrist: 0.20, palm: 0.16, tip: 0.20 }; // downward travel in palm-lengths (before sensitivity)
const FLICK_TIP_SPEED = 1.2;   // fingertip downward speed in palm-lengths/second (before sensitivity)
const FLICK_MIN_SPEED = 1.0;   // slower drifts (e.g. just moving your hand down to aim) never count; palm-lengths/second, before sensitivity
const FLICK_TRAIL_MS = 360;    // how far back we look for the start of the movement
const FLICK_WINDOW_MS = 350;   // how long a detected flick stays "active" (the game polls every frame)
const FLICK_COOLDOWN_MS = 350; // minimum time between two flicks of the same hand
 
function dist3D(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y, (p1.z || 0) - (p2.z || 0));
}
 
function jointAngle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y, abz = (a.z || 0) - (b.z || 0);
  const cbx = c.x - b.x, cby = c.y - b.y, cbz = (c.z || 0) - (b.z || 0);
  const dot = abx * cbx + aby * cby + abz * cbz;
  const magAB = Math.hypot(abx, aby, abz);
  const magCB = Math.hypot(cbx, cby, cbz);
  if (magAB * magCB < 1e-7) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}
 
export class GestureAnalyzer {
  constructor() {
    this.history = new Map(); // handId -> smoothed states
  }
 
  reset() {
    this.history.clear();
  }
 
  analyzeHand(landmarks, worldLandmarks, handedness = 'Right', handId = 0, now = performance.now()) {
    if (!landmarks || landmarks.length < 21) return null;
 
    const lm = landmarks;
    const wlm = worldLandmarks || landmarks;
 
    const wrist = lm[0];
    const thumbTip = lm[4];
    const indexMCP = lm[5], indexPIP = lm[6], indexDIP = lm[7], indexTip = lm[8];
    const middleMCP = lm[9], middlePIP = lm[10], middleDIP = lm[11], middleTip = lm[12];
    const ringMCP = lm[13], ringPIP = lm[14], ringDIP = lm[15], ringTip = lm[16];
    const pinkyMCP = lm[17], pinkyPIP = lm[18], pinkyDIP = lm[19], pinkyTip = lm[20];
 
    const palmCenter = {
      x: (wrist.x + middleMCP.x) * 0.5,
      y: (wrist.y + middleMCP.y) * 0.5,
      z: ((wrist.z || 0) + (middleMCP.z || 0)) * 0.5,
    };
    const palmScale = Math.max(0.04, dist3D(wrist, middleMCP));
 
    // Joint angles for each finger
    const indexAnglePIP = jointAngle(indexMCP, indexPIP, indexDIP);
    const middleAnglePIP = jointAngle(middleMCP, middlePIP, middleDIP);
    const ringAnglePIP = jointAngle(ringMCP, ringPIP, ringDIP);
    const pinkyAnglePIP = jointAngle(pinkyMCP, pinkyPIP, pinkyDIP);
 
    const isIndexExtended =
      indexAnglePIP > 140 &&
      dist3D(indexTip, wrist) > dist3D(indexPIP, wrist) * 1.15 &&
      dist3D(indexTip, palmCenter) > palmScale * 1.1;
 
    const isPinkyExtended =
      pinkyAnglePIP > 135 &&
      dist3D(pinkyTip, wrist) > dist3D(pinkyPIP, wrist) * 1.12 &&
      dist3D(pinkyTip, palmCenter) > palmScale * 1.0;
 
    const isMiddleCurled =
      middleAnglePIP < 130 ||
      dist3D(middleTip, palmCenter) < palmScale * 0.82 ||
      dist3D(middleTip, wrist) < dist3D(middlePIP, wrist) * 1.05;
 
    const isRingCurled =
      ringAnglePIP < 130 ||
      dist3D(ringTip, palmCenter) < palmScale * 0.82 ||
      dist3D(ringTip, wrist) < dist3D(ringPIP, wrist) * 1.05;
 
    const isThumbExtended = dist3D(thumbTip, indexMCP) > palmScale * 0.65;

    // Finger extension checks
    const isMiddleExtended = middleAnglePIP > 135 && dist3D(middleTip, palmCenter) > palmScale * 1.0;
    const isRingExtended = ringAnglePIP > 135 && dist3D(ringTip, palmCenter) > palmScale * 1.0;

    const isSpideyPoseStrict = isIndexExtended && isPinkyExtended && isMiddleCurled && isRingCurled;
    const isOpenPalmStrict = isIndexExtended && !isMiddleCurled && !isRingCurled && isPinkyExtended;
    const isFistStrict = !isIndexExtended && isMiddleCurled && isRingCurled && !isPinkyExtended;

    // Natural open / released hand: fingers uncurled from palm (not a fist)
    const isOpenPalmNatural =
      !isFistStrict &&
      dist3D(middleTip, palmCenter) > palmScale * 0.88 &&
      dist3D(ringTip, palmCenter) > palmScale * 0.88 &&
      (isIndexExtended || isMiddleExtended || isRingExtended || isPinkyExtended);

    const isOpenPalm = isOpenPalmStrict || isOpenPalmNatural;

    // Temporal smoothing across consecutive frames
    let hist = this.history.get(handId);
    if (!hist) {
      hist = {
        spideyStreak: 0,
        openStreak: 0,
        fistStreak: 0,
        smoothWrist: { x: wrist.x, y: wrist.y, z: wrist.z || 0 },
        smoothAim: { x: indexTip.x, y: indexTip.y },
        smoothMuzzle: { x: wrist.x, y: wrist.y },
        smoothPalmScale: palmScale,
        prevMuzzle: { x: wrist.x, y: wrist.y },
        prevTime: now,
        velX: 0,
        velY: 0,
        trail: [],
        flickUntil: 0,
        lastFlickAt: -Infinity,
        lastAimAt: -Infinity,
        lastFistAt: -Infinity,
        openSince: null,
      };
      this.history.set(handId, hist);
    }

    hist.spideyStreak = isSpideyPoseStrict ? hist.spideyStreak + 1 : 0;
    hist.openStreak = isOpenPalm ? hist.openStreak + 1 : 0;
    hist.fistStreak = isFistStrict ? hist.fistStreak + 1 : 0;

    const isSpideyConfirmed = hist.spideyStreak >= 3;
    const isOpenConfirmed = hist.openStreak >= 2;
    const isFistConfirmed = hist.fistStreak >= 2;

    // Timers used by the 4-movement state machine
    if (isSpideyConfirmed) hist.lastAimAt = now;
    if (isFistConfirmed) hist.lastFistAt = now;
    if (isOpenConfirmed) {
      if (hist.openSince == null) hist.openSince = now;
    } else {
      hist.openSince = null;
    }
    const aimRecently = now - hist.lastAimAt < 600;   // aim pose held a moment ago (survives the flick)
    const fistHeld = now - hist.lastFistAt < 250;     // fist, with a short grace for tracking dropouts
    const openHeld = hist.openSince != null && (now - hist.openSince > 120 || isOpenConfirmed); // fast, responsive open palm
    const wasFisting = now - hist.lastFistAt < 500 && !isFistConfirmed;
    const isHandReleased = wasFisting && (isOpenConfirmed || isOpenPalm || !isFistStrict);
    const pose = isSpideyConfirmed ? 'AIM' : isFistConfirmed ? 'FIST' : isOpenConfirmed ? 'OPEN' : 'IDLE';
 
    hist.smoothWrist.x += (wrist.x - hist.smoothWrist.x) * 0.35;
    hist.smoothWrist.y += (wrist.y - hist.smoothWrist.y) * 0.35;
    hist.smoothWrist.z += ((wrist.z || 0) - hist.smoothWrist.z) * 0.35;
 
    const rawMuzzleX = wrist.x * 0.75 + palmCenter.x * 0.25;
    const rawMuzzleY = wrist.y * 0.75 + palmCenter.y * 0.25;
    hist.smoothMuzzle.x += (rawMuzzleX - hist.smoothMuzzle.x) * 0.45;
    hist.smoothMuzzle.y += (rawMuzzleY - hist.smoothMuzzle.y) * 0.45;
 
    hist.smoothPalmScale += (palmScale - hist.smoothPalmScale) * 0.25;
 
    hist.smoothAim.x += (indexTip.x - hist.smoothAim.x) * 0.4;
    hist.smoothAim.y += (indexTip.y - hist.smoothAim.y) * 0.4;
 
    // ---- Flick detection: small downward motion of wrist, palm centre or fingertip ----
    // A gentle wrist flick often moves the fingertips far more than the wrist, so all three
    // are watched (raw positions, no smoothing lag), each normalised by hand size.
    const scale = hist.smoothPalmScale;
    const dt = (now - hist.prevTime) / 1000;
    if (dt > 0.005 && dt < 0.25) {
      const vx = (rawMuzzleX - hist.prevMuzzle.x) / dt / scale;
      const vy = (rawMuzzleY - hist.prevMuzzle.y) / dt / scale;
      hist.velX = hist.velX * 0.4 + vx * 0.6;
      hist.velY = hist.velY * 0.4 + vy * 0.6;
    } else {
      hist.velX = 0;
      hist.velY = 0;
      hist.trail.length = 0;
    }
    hist.prevMuzzle.x = rawMuzzleX;
    hist.prevMuzzle.y = rawMuzzleY;
    hist.prevTime = now;
 
    const cur = {
      t: now,
      wrist: { x: rawMuzzleX, y: rawMuzzleY },
      palm: { x: palmCenter.x, y: palmCenter.y },
      tip: { x: indexTip.x, y: indexTip.y },
    };
    hist.trail.push(cur);
    while (hist.trail.length > 1 && now - hist.trail[0].t > FLICK_TRAIL_MS) hist.trail.shift();
 
    // progress 0..1+ : how close the best of the three points is to counting as a flick
    let flickProgress = 0;
    for (const k of ['wrist', 'palm', 'tip']) {
      let top = cur[k];
      let topT = now;
      for (const p of hist.trail) if (p[k].y <= top.y) { top = p[k]; topT = p.t; } // <= so we pick the LAST moment the point was at its highest
      const drop = (cur[k].y - top.y) / scale;
      const side = Math.abs(cur[k].x - top.x) / scale;
      const dropSpeed = drop / Math.max(0.03, (now - topT) / 1000);
      if (drop > side * 0.8 && dropSpeed >= FLICK_MIN_SPEED / FLICK_SENSITIVITY) {
        flickProgress = Math.max(flickProgress, drop / (FLICK_NEED[k] / FLICK_SENSITIVITY));
      }
    }
 
    // fast fingertip drop also counts (very short, snappy flicks)
    const first = hist.trail[0];
    const spanS = (now - first.t) / 1000;
    if (spanS > 0.04) {
      const tipSpeed = (cur.tip.y - first.tip.y) / spanS / scale;
      const tipSide = Math.abs(cur.tip.x - first.tip.x) / spanS / scale;
      if (tipSpeed > tipSide * 0.8) {
        flickProgress = Math.max(flickProgress, tipSpeed / (FLICK_TIP_SPEED / FLICK_SENSITIVITY));
      }
    }
 
    if (flickProgress >= 1 && now - hist.lastFlickAt > FLICK_COOLDOWN_MS) {
      hist.flickUntil = now + FLICK_WINDOW_MS;
      hist.lastFlickAt = now;
      hist.trail.length = 0; // start fresh so one flick can't count twice
    }
    const isFlickDown = now < hist.flickUntil;
 
    return {
      handId,
      handedness,
      landmarks,
      worldLandmarks: wlm,
      wrist: { ...hist.smoothWrist },
      shooterMuzzle: { x: hist.smoothMuzzle.x, y: hist.smoothMuzzle.y, z: hist.smoothWrist.z },
      aimTarget: { x: hist.smoothAim.x, y: hist.smoothAim.y, z: 0 },
      palmCenter,
      palmScale: hist.smoothPalmScale,
      isSpideyPose: isSpideyConfirmed,
      isOpenPalm: isOpenConfirmed,
      isFist: isFistConfirmed,
      isFlickDown,
      flickProgress: now < hist.flickUntil ? 1 : Math.min(1, flickProgress),
      flickSpeed: hist.velY,
      pose,
      aimRecently,
      fistHeld,
      openHeld,
      isHandReleased,
      jointStates: {
        indexExtended: isIndexExtended,
        pinkyExtended: isPinkyExtended,
        middleCurled: isMiddleCurled,
        ringCurled: isRingCurled,
        thumbExtended: isThumbExtended,
      },
      angles: {
        index: indexAnglePIP,
        middle: middleAnglePIP,
        ring: ringAnglePIP,
        pinky: pinkyAnglePIP,
      },
    };
  }
 
  // Pull = wrist moving BACK toward the player (away from the object) or the hand growing in view.
  calculatePull(anchor, currentHand, screenMuzzle, anchorMuzzle, objectCenter) {
    if (!anchor || !currentHand) return { pullAmount: 0, tension: 0 };
 
    const toHandX = anchorMuzzle.x - objectCenter.x;
    const toHandY = anchorMuzzle.y - objectCenter.y;
    const len = Math.hypot(toHandX, toHandY) || 1;
    const dirX = toHandX / len;
    const dirY = toHandY / len;
 
    const moveX = screenMuzzle.x - anchorMuzzle.x;
    const moveY = screenMuzzle.y - anchorMuzzle.y;
 
    // Only motion away from the object counts; sideways jitter or pushing toward it does not.
    const directionalPull = moveX * dirX + moveY * dirY;
    const downwardPull = moveY * 0.6;
 
    const motionPull = Math.max(0, Math.max(directionalPull, downwardPull) / 110);
 
    const anchorScale = Math.max(0.04, anchor.palmScale);
    const curScale = Math.max(0.04, currentHand.palmScale);
    const depthGrowth = Math.max(0, (curScale - anchorScale) / (anchorScale * 0.3));
 
    const rawPull = Math.max(motionPull, depthGrowth);
    const clampedPull = Math.max(0, Math.min(1.0, rawPull));
 
    return {
      pullAmount: clampedPull,
      tension: Math.min(1.0, clampedPull * 1.3),
    };
  }
}