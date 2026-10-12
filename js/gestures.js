// Spider-Man Biometric Hand Scanner & 21-Joint Pose Tracker
// Validates finger joint angles, detects the wrist-flick shoot gesture, and measures the pull.
//
// WHY THE OLD FLICK WAS HARD TO DETECT
//   The old detector only looked for the hand moving DOWN on the screen. A real web-shooter flick
//   (see the reference photos) is a WRIST FLEXION: the palm swings about the wrist, often towards or
//   away from the camera, so the hand barely moves up/down in the image at all.
//   The new detector measures how fast the PALM ROTATES about the wrist (3D and in-plane), which is
//   independent of where the arm is and of which way the flick goes. The old "downward drop" test is
//   kept as a second path so nothing that used to work stops working.
 
// FLICK_SENSITIVITY is the one knob to tune: 1.0 = strict, 1.6 = default, 2.0 = very sensitive.
const FLICK_SENSITIVITY = 1.6;
 
// --- Path A: palm rotation about the wrist (all values BEFORE dividing by FLICK_SENSITIVITY) ---
const FLICK_ROT_DEG = 34;        // palm must swing at least this many degrees ...
const FLICK_ROT_SPEED = 320;     // ... at at least this angular speed (degrees / second)
const FLICK_POINT_FACTOR = 1.35; // finger-direction lever must move this much MORE (fingers also bend on their own)
const FLICK_GLITCH_DEG = 75;     // a jump bigger than this between two frames is a tracking glitch, not a flick
 
// --- Path B: downward translation (the original test) ---
const FLICK_NEED = { wrist: 0.20, palm: 0.16, tip: 0.20 }; // downward travel in palm-lengths
const FLICK_TIP_SPEED = 2.2;     // fingertip downward speed, palm-lengths/second (raised: slow wrist-aiming must not fire)
const FLICK_MIN_SPEED = 1.8;     // slower drifts (aiming, lowering the hand) never count; palm-lengths/second
 
const FLICK_TRAIL_MS = 360;      // how far back we look for the start of the movement
const FLICK_WINDOW_MS = 350;     // how long a detected flick stays "active" (the game polls every frame)
const FLICK_COOLDOWN_MS = 350;   // minimum time between two flicks of the same hand
const TRACK_GAP_MS = 500;        // a longer tracking gap than this wipes the flick history
 
// ---- Grip (fist) / release tuning ----
// "Openness" = mean distance of the 4 fingertips from the palm centre, in palm-lengths.
// A closed fist sits around 0.3-0.7, a flat open hand around 1.3-1.7.
const FIST_ENTER = 0.72;       // openness below this counts as a fist even if the strict joint test fails
const FIST_EXIT = 0.95;        // once gripping, openness must rise above this to stop counting as a fist (hysteresis)
const RELEASE_OPEN = 1.0;      // fingers uncurled past this after a grip = the player let go
const STRONG_OPEN = 1.1;       // clearly past the fist range: react on a single frame instead of two
const CLEAR_OPEN = 1.25;       // "unmistakably open hand" (used for the fast release path)
const FIST_GRACE_MS = 300;     // tracking-dropout grace for "still gripping" (fast fists blur and drop frames)
const RELEASE_FLAG_MS = 350;   // how long isHandReleased stays raised after the grip opens
const AIM_GRACE_MS = 160;      // the Spidey pose is kept alive this long after one bad frame (the flick bends the wrist)
 
// ---- Pull tuning ----
// Pulling is measured as hand SPEED away from the object, accumulated over time (a "ratchet").
//   * Standing still / jitter adds nothing (speed must beat the dead zone).
//   * Moving back toward the object never undoes progress, so you can pull, reset, pull again.
//   * Progress per second is capped, so the reel is smooth and one jerk cannot snap it in.
const PULL_DEADZONE_PALMS = 0.9;  // hand speed (palm-lengths / second) below this is jitter
const PULL_DEADZONE_MIN_PX = 80;  // ... but never less than this many px / second
const PULL_MAX_RATE = 1.1;        // maximum reel progress per second (full reel takes >= ~0.9 s)
const PULL_SCALE_DEADZONE = 0.25; // hand growing (towards the camera) faster than 25 % / second counts as a pull
const PULL_SCALE_FULL = 0.30;     // ... 30 % growth ~ one full reel
const PULL_GAP_MS = 350;          // tracking gap that re-baselines the pull (no jump credit for the jump)
const PULL_MAX_SPEED = 4000;      // px / second, ignore absurd tracking spikes
 
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
 
// unit vector a->b (null when the points coincide)
function unitVec(a, b, sx = 1, sy = 1, sz = 1) {
  const x = (b.x - a.x) * sx;
  const y = (b.y - a.y) * sy;
  const z = ((b.z || 0) - (a.z || 0)) * sz;
  const m = Math.hypot(x, y, z);
  if (m < 1e-6) return null;
  return { x: x / m, y: y / m, z: z / m };
}
 
function unitVec2(a, b, sx = 1, sy = 1, minLen = 0.015) {
  const x = (b.x - a.x) * sx;
  const y = (b.y - a.y) * sy;
  const m = Math.hypot(x, y);
  if (m < minLen) return null; // hand pointing straight at the camera: in-plane direction is meaningless
  return { x: x / m, y: y / m, z: 0 };
}
 
function angleBetween(u, v) {
  if (!u || !v) return 0;
  const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y + u.z * v.z));
  return (Math.acos(dot) * 180) / Math.PI;
}
 
export class GestureAnalyzer {
  constructor() {
    this.history = new Map(); // handId -> smoothed states
  }
 
  reset() {
    this.history.clear();
  }
 
  // aspect = video width / video height (needed so in-plane angles are not stretched)
  analyzeHand(landmarks, worldLandmarks, handedness = 'Right', handId = 0, now = performance.now(), aspect = 1) {
    if (!landmarks || landmarks.length < 21) return null;
 
    const lm = landmarks;
    const wlm = worldLandmarks && worldLandmarks.length >= 21 ? worldLandmarks : null;
    const asp = aspect > 0.2 && aspect < 5 ? aspect : 1;
 
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
 
    // Slightly more forgiving than before: the flick bends the wrist, which foreshortens the fingers
    const isIndexExtended =
      indexAnglePIP > 135 &&
      dist3D(indexTip, wrist) > dist3D(indexPIP, wrist) * 1.1 &&
      dist3D(indexTip, palmCenter) > palmScale * 1.05;
 
    const isPinkyExtended =
      pinkyAnglePIP > 130 &&
      dist3D(pinkyTip, wrist) > dist3D(pinkyPIP, wrist) * 1.08 &&
      dist3D(pinkyTip, palmCenter) > palmScale * 0.95;
 
    const isMiddleCurled =
      middleAnglePIP < 130 ||
      dist3D(middleTip, palmCenter) < palmScale * 0.82 ||
      dist3D(middleTip, wrist) < dist3D(middlePIP, wrist) * 1.05;
 
    const isRingCurled =
      ringAnglePIP < 130 ||
      dist3D(ringTip, palmCenter) < palmScale * 0.82 ||
      dist3D(ringTip, wrist) < dist3D(ringPIP, wrist) * 1.05;
 
    const isThumbExtended = dist3D(thumbTip, indexMCP) > palmScale * 0.65;
 
    // Continuous finger-curl measure used for grip / release (much less jumpy than boolean joint tests)
    const opennessAvg =
      (dist3D(indexTip, palmCenter) +
        dist3D(middleTip, palmCenter) +
        dist3D(ringTip, palmCenter) +
        dist3D(pinkyTip, palmCenter)) /
      (4 * palmScale);
 
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
        clearOpenStreak: 0,
        smoothWrist: { x: wrist.x, y: wrist.y, z: wrist.z || 0 },
        smoothAim: { x: indexTip.x, y: indexTip.y },
        smoothMuzzle: { x: wrist.x, y: wrist.y },
        smoothPalmScale: palmScale,
        prevMuzzle: { x: wrist.x, y: wrist.y },
        prevTime: now,
        velX: 0,
        velY: 0,
        trail: [],
        aimTrail: [],
        glitchStreak: 0,
        flickUntil: 0,
        flickAt: -Infinity,
        lastFlickAt: -Infinity,
        lastSpideyAt: -Infinity,
        lastAimAt: -Infinity,
        lastFistAt: -Infinity,
        openSince: null,
        fistOn: false,
        fistMiss: 0,
        releasedUntil: 0,
      };
      this.history.set(handId, hist);
    }
 
    // ---- Fist with hysteresis ----
    // Enter: strict joint test OR clearly curled fingers. Stay: until the fingers are clearly uncurled.
    // Leave: needs 2 consecutive non-fist frames, or just 1 when the hand is unmistakably open.
    const fistRaw =
      isFistStrict ||
      opennessAvg < FIST_ENTER ||
      (hist.fistOn && opennessAvg < FIST_EXIT && !isOpenPalm);
 
    hist.spideyStreak = isSpideyPoseStrict ? hist.spideyStreak + 1 : 0;
    hist.openStreak = isOpenPalm ? hist.openStreak + 1 : 0;
    hist.clearOpenStreak = opennessAvg >= CLEAR_OPEN && !fistRaw ? hist.clearOpenStreak + 1 : 0;
    if (fistRaw) {
      hist.fistStreak++;
      hist.fistMiss = 0;
    } else {
      hist.fistStreak = 0;
      hist.fistMiss++;
    }
 
    const missNeeded = opennessAvg >= STRONG_OPEN ? 1 : 2;
    // 2 good frames are enough to confirm the aim pose (was 3), and it survives one bad frame
    if (hist.spideyStreak >= 2) hist.lastSpideyAt = now;
    const isSpideyConfirmed =
      hist.spideyStreak >= 2 ||
      (now - hist.lastSpideyAt < AIM_GRACE_MS && !(hist.fistOn || opennessAvg < FIST_ENTER));
    const isOpenConfirmed = hist.openStreak >= 2;
    const isFistConfirmed = hist.fistStreak >= 2 || (hist.fistOn && hist.fistMiss < missNeeded);
    const justUngripped = hist.fistOn && !isFistConfirmed;
    hist.fistOn = isFistConfirmed;
 
    // Timers used by the 4-movement state machine
    if (isSpideyConfirmed) hist.lastAimAt = now;
    if (isFistConfirmed) hist.lastFistAt = now;
    if (isOpenConfirmed) {
      if (hist.openSince == null) hist.openSince = now;
    } else {
      hist.openSince = null;
    }
 
    // Letting go: the grip just ended AND the fingers are uncurling / open.
    if (justUngripped && (isOpenPalm || opennessAvg >= RELEASE_OPEN)) {
      hist.releasedUntil = now + RELEASE_FLAG_MS;
    }
    if (isFistConfirmed) hist.releasedUntil = 0;
 
    const aimRecently = now - hist.lastAimAt < 600;   // aim pose held a moment ago (survives the flick)
    const isHandReleased = now < hist.releasedUntil;
    const fistHeld =
      isFistConfirmed ||
      (now - hist.lastFistAt < FIST_GRACE_MS && !isHandReleased && !isOpenPalm && opennessAvg < FIST_EXIT);
    const openHeld = hist.openSince != null && (now - hist.openSince > 120 || isOpenConfirmed);
    const openForMs = hist.openSince != null ? now - hist.openSince : 0;
    const isClearlyOpen = hist.clearOpenStreak >= 2;
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
 
    // Where the fingertip was pointing BEFORE the flick started (the flick itself drags it off the object)
    hist.aimTrail.push({ t: now, x: indexTip.x, y: indexTip.y });
    while (hist.aimTrail.length > 1 && now - hist.aimTrail[0].t > 800) hist.aimTrail.shift();
    let aimPast = null;
    {
      let sx = 0, sy = 0, n = 0;
      for (const p of hist.aimTrail) {
        const age = now - p.t;
        if (age >= 150 && age <= 500) { sx += p.x; sy += p.y; n++; }
      }
      if (n > 0) aimPast = { x: sx / n, y: sy / n, z: 0 };
    }
 
    // ---- Flick detection ----
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
    }
    if (dt * 1000 >= TRACK_GAP_MS) hist.trail.length = 0; // long dropout: start over
    hist.prevMuzzle.x = rawMuzzleX;
    hist.prevMuzzle.y = rawMuzzleY;
    hist.prevTime = now;
 
    // 3D directions come from the metric world landmarks (independent of camera distance and tilt);
    // if they are missing we fall back to the image landmarks in "width units".
    const src = wlm || lm;
    const sx3 = 1, sy3 = wlm ? 1 : 1 / asp, sz3 = 1;
    const midTips = {
      x: (src[8].x + src[20].x) * 0.5,
      y: (src[8].y + src[20].y) * 0.5,
      z: ((src[8].z || 0) + (src[20].z || 0)) * 0.5,
    };
    const midTips2 = { x: (indexTip.x + pinkyTip.x) * 0.5, y: (indexTip.y + pinkyTip.y) * 0.5 };
 
    const cur = {
      t: now,
      palm3: unitVec(src[0], src[9], sx3, sy3, sz3),
      point3: unitVec(src[0], midTips, sx3, sy3, sz3),
      palm2: unitVec2(wrist, middleMCP, 1, 1 / asp),
      point2: unitVec2(wrist, midTips2, 1, 1 / asp),
      wrist: { x: rawMuzzleX, y: rawMuzzleY },
      palm: { x: palmCenter.x, y: palmCenter.y },
      tip: { x: indexTip.x, y: indexTip.y },
    };
 
    // Tracking glitch guard: one frame where the whole hand "teleports" by a huge angle is noise
    let skipSample = false;
    const prev = hist.trail.length ? hist.trail[hist.trail.length - 1] : null;
    if (prev && now - prev.t < 70) {
      const jump = Math.max(angleBetween(prev.palm3, cur.palm3), angleBetween(prev.palm2, cur.palm2));
      if (jump > FLICK_GLITCH_DEG) {
        hist.glitchStreak++;
        if (hist.glitchStreak <= 2) skipSample = true;       // ignore up to 2 odd frames
        else { hist.trail.length = 0; hist.glitchStreak = 0; } // it stuck: the hand really is there now
      } else {
        hist.glitchStreak = 0;
      }
    }
 
    let flickProgress = 0;
    let flickKind = null;
    if (!skipSample) {
      hist.trail.push(cur);
      while (hist.trail.length > 1 && now - hist.trail[0].t > FLICK_TRAIL_MS) hist.trail.shift();
      if (hist.trail.length > 40) hist.trail.shift();
 
      // ---- Path A: palm swinging about the wrist (any direction, towards / away from the camera too) ----
      const needDeg = FLICK_ROT_DEG / FLICK_SENSITIVITY;
      const needSpeed = FLICK_ROT_SPEED / FLICK_SENSITIVITY;
      let rotProgress = 0;
      for (const s of hist.trail) {
        if (s === cur) continue;
        const dtS = (now - s.t) / 1000;
        if (dtS < 0.03) continue; // too short a baseline: jitter would look like speed
        const test = (ang, factor) => {
          if (ang <= 0) return;
          const r = Math.min(ang / (needDeg * factor), ang / dtS / (needSpeed * factor));
          if (r > rotProgress) rotProgress = r;
        };
        test(angleBetween(s.palm3, cur.palm3), 1);
        test(angleBetween(s.palm2, cur.palm2), 1);
        test(angleBetween(s.point3, cur.point3), FLICK_POINT_FACTOR);
        test(angleBetween(s.point2, cur.point2), FLICK_POINT_FACTOR);
      }
      if (rotProgress > flickProgress) { flickProgress = rotProgress; flickKind = 'rotate'; }
 
      // ---- Path B: small, quick downward movement of wrist, palm centre or fingertip ----
      let dropProgress = 0;
      for (const k of ['wrist', 'palm', 'tip']) {
        let top = cur[k];
        let topT = now;
        for (const p of hist.trail) if (p[k].y <= top.y) { top = p[k]; topT = p.t; } // LAST moment it was highest
        const drop = (cur[k].y - top.y) / scale;
        const side = Math.abs(cur[k].x - top.x) / scale;
        const dropSpeed = drop / Math.max(0.03, (now - topT) / 1000);
        if (drop > side * 0.8 && dropSpeed >= FLICK_MIN_SPEED / FLICK_SENSITIVITY) {
          dropProgress = Math.max(dropProgress, drop / (FLICK_NEED[k] / FLICK_SENSITIVITY));
        }
      }
      const first = hist.trail[0];
      const spanS = (now - first.t) / 1000;
      if (spanS > 0.04) {
        const tipSpeed = (cur.tip.y - first.tip.y) / spanS / scale;
        const tipSide = Math.abs(cur.tip.x - first.tip.x) / spanS / scale;
        if (tipSpeed > tipSide * 0.8) {
          dropProgress = Math.max(dropProgress, tipSpeed / (FLICK_TIP_SPEED / FLICK_SENSITIVITY));
        }
      }
      if (dropProgress > flickProgress) { flickProgress = dropProgress; flickKind = 'drop'; }
 
      if (flickProgress >= 1 && now - hist.lastFlickAt > FLICK_COOLDOWN_MS) {
        hist.flickUntil = now + FLICK_WINDOW_MS;
        hist.flickAt = now;
        hist.lastFlickAt = now;
        hist.flickKind = flickKind;
        hist.trail.length = 0;   // one flick can never count twice ...
        hist.trail.push(cur);    // ... but keep the current pose as the baseline for the next one
      }
    }
    const isFlickDown = now < hist.flickUntil;
 
    return {
      handId,
      handedness,
      landmarks,
      worldLandmarks: worldLandmarks || landmarks,
      sampleTime: now, // timestamp of the tracking frame this state came from (pull maths ignores repeats)
      wrist: { ...hist.smoothWrist },
      shooterMuzzle: { x: hist.smoothMuzzle.x, y: hist.smoothMuzzle.y, z: hist.smoothWrist.z },
      aimTarget: { x: hist.smoothAim.x, y: hist.smoothAim.y, z: 0 },
      aimPast,
      palmCenter,
      palmScale: hist.smoothPalmScale,
      isSpideyPose: isSpideyConfirmed,
      isOpenPalm: isOpenConfirmed,
      isFist: isFistConfirmed,
      isFlickDown,
      flickAt: hist.flickAt,
      flickKind: isFlickDown ? hist.flickKind : null,
      flickProgress: isFlickDown ? 1 : Math.min(1, flickProgress),
      flickSpeed: hist.velY,
      pose,
      aimRecently,
      fistHeld,
      openHeld,
      openForMs,
      isClearlyOpen,
      isHandReleased,
      opennessAvg,
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
 
  // ------------------------------------------------------------------------------------------
  // PULL (movement 4)
  // One pull state per web strand. The state only ever ADVANCES (ratchet): the web is reeled in by
  // hand speed directed away from the object (or the hand growing towards the camera).
  // ------------------------------------------------------------------------------------------
  createPullState(startProgress = 0) {
    return {
      progress: Math.max(0, Math.min(1, startProgress)),
      lastSampleT: null,
      lastT: null,
      lastX: 0,
      lastY: 0,
      lastScale: 0,
      vx: 0,
      vy: 0,
      scaleRate: 0,
      tension: 0,
      along: 0,
    };
  }
 
  // muzzle / objectCenter are SCREEN points, palmPx = palm length on screen, travelPx = hand travel for a full reel.
  // Returns the (mutated) state: state.progress (0..1) and state.tension (0..1).
  updatePull(st, hand, muzzle, objectCenter, palmPx, travelPx) {
    if (!st || !hand) return st;
    const t = hand.sampleTime ?? performance.now();
    if (t === st.lastSampleT) return st; // same tracking frame as last time: nothing new to measure
    st.lastSampleT = t;
 
    const palm = Math.max(20, palmPx || 100);
    const travel = Math.max(80, travelPx || 300);
 
    if (st.lastT == null || t - st.lastT > PULL_GAP_MS) {
      // first sample, or the hand was lost for a moment: re-baseline instead of crediting the jump
      st.lastT = t;
      st.lastX = muzzle.x;
      st.lastY = muzzle.y;
      st.lastScale = hand.palmScale;
      st.vx = 0;
      st.vy = 0;
      st.scaleRate = 0;
      st.along = 0;
      st.tension *= 0.8;
      return st;
    }
 
    const dt = (t - st.lastT) / 1000;
    if (dt < 0.006) return st;
 
    // smoothed velocity (px / s), spikes clipped
    let rvx = (muzzle.x - st.lastX) / dt;
    let rvy = (muzzle.y - st.lastY) / dt;
    const rs = Math.hypot(rvx, rvy);
    if (rs > PULL_MAX_SPEED) { rvx *= PULL_MAX_SPEED / rs; rvy *= PULL_MAX_SPEED / rs; }
    st.vx = st.vx * 0.5 + rvx * 0.5;
    st.vy = st.vy * 0.5 + rvy * 0.5;
 
    // direction of a pull = from the object towards the hand (straight down if they overlap)
    let dx = muzzle.x - objectCenter.x;
    let dy = muzzle.y - objectCenter.y;
    const len = Math.hypot(dx, dy);
    if (len < 60) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
 
    const along = Math.max(st.vx * dx + st.vy * dy, st.vy * 0.6); // away from the object, or simply down
    st.along = along;
 
    const deadzone = Math.max(PULL_DEADZONE_MIN_PX, PULL_DEADZONE_PALMS * palm);
    let gain = (Math.max(0, along - deadzone) * dt) / travel;
 
    // hand growing in the image = hand coming towards the camera = pulling the rope in
    const growth = (hand.palmScale - st.lastScale) / Math.max(0.01, st.lastScale) / dt;
    st.scaleRate = st.scaleRate * 0.5 + growth * 0.5;
    if (st.scaleRate > PULL_SCALE_DEADZONE) {
      gain += ((st.scaleRate - PULL_SCALE_DEADZONE) * dt) / PULL_SCALE_FULL;
    }
 
    gain = Math.min(gain, PULL_MAX_RATE * dt);
    st.progress = Math.min(1, st.progress + gain);
 
    const effort = Math.min(1, along / (4 * palm));
    const tens = 0.2 + 0.45 * st.progress + 0.35 * effort;
    st.tension += (Math.min(1, tens) - st.tension) * 0.3;
 
    st.lastT = t;
    st.lastX = muzzle.x;
    st.lastY = muzzle.y;
    st.lastScale = hand.palmScale;
    return st;
  }
}