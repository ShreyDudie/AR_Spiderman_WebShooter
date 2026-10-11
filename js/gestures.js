// Spider-Man Biometric Hand Scanner & 21-Joint Pose Tracker
// Validates finger joint angles, detects the wrist-flick shoot gesture, and measures pull.
 
// Flick = a SMALL, quick downward wrist movement. Either of these triggers it:
const FLICK_DISTANCE = 0.28;   // downward travel within the trail window, in palm-lengths (smaller = easier)
const FLICK_SPEED = 1.6;       // or downward speed in palm-lengths per second (smaller = easier)
const FLICK_TRAIL_MS = 320;    // how far back we look for the start of the movement
const FLICK_WINDOW_MS = 320;   // how long a detected flick stays "active" (the game polls every frame)
const FLICK_COOLDOWN_MS = 450; // minimum time between two flicks of the same hand
 
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
 
    const isSpideyPoseStrict = isIndexExtended && isPinkyExtended && isMiddleCurled && isRingCurled;
    const isOpenPalmStrict = isIndexExtended && !isMiddleCurled && !isRingCurled && isPinkyExtended;
    const isFistStrict = !isIndexExtended && isMiddleCurled && isRingCurled && !isPinkyExtended;
 
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
    hist.openStreak = isOpenPalmStrict ? hist.openStreak + 1 : 0;
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
    const aimRecently = now - hist.lastAimAt < 450;   // aim pose held a moment ago (survives the flick)
    const fistHeld = now - hist.lastFistAt < 250;     // fist, with a short grace for tracking dropouts
    const openHeld = hist.openSince != null && now - hist.openSince > 450; // deliberate open palm
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
 
    // ---- Wrist flick detection (small downward motion, normalised by hand size) ----
    // Uses the RAW muzzle point (no smoothing lag) so even a short, gentle flick registers.
    const dt = (now - hist.prevTime) / 1000;
    if (dt > 0.005 && dt < 0.25) {
      const vx = (rawMuzzleX - hist.prevMuzzle.x) / dt / hist.smoothPalmScale;
      const vy = (rawMuzzleY - hist.prevMuzzle.y) / dt / hist.smoothPalmScale;
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
 
    hist.trail.push({ t: now, x: rawMuzzleX, y: rawMuzzleY });
    while (hist.trail.length > 1 && now - hist.trail[0].t > FLICK_TRAIL_MS) hist.trail.shift();
 
    // how far the wrist has dropped from its highest point in the last ~0.3 s
    let topY = rawMuzzleY;
    let topX = rawMuzzleX;
    for (const p of hist.trail) {
      if (p.y < topY) { topY = p.y; topX = p.x; }
    }
    const dropDist = (rawMuzzleY - topY) / hist.smoothPalmScale;
    const sideDist = Math.abs(rawMuzzleX - topX) / hist.smoothPalmScale;
 
    const mostlyDown = (dx, dy) => dy > Math.abs(dx) * 0.8;
    const bigEnoughDrop = dropDist > FLICK_DISTANCE && mostlyDown(sideDist, dropDist);
    const fastEnoughDrop = hist.velY > FLICK_SPEED && mostlyDown(hist.velX, hist.velY);
 
    if ((bigEnoughDrop || fastEnoughDrop) && now - hist.lastFlickAt > FLICK_COOLDOWN_MS) {
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
      flickSpeed: Math.max(hist.velY, dropDist * 4), // used by game.js to freeze the aim lock mid-flick
      pose,
      aimRecently,
      fistHeld,
      openHeld,
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