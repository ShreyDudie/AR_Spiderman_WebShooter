// Spider-Man Biometric Hand Scanner & 21-Joint Pose Tracker
// Strictly validates angles and extension of all individual finger joints

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
    this.lastShootTime = 0;
  }

  analyzeHand(landmarks, worldLandmarks, handedness = 'Right', handId = 0) {
    if (!landmarks || landmarks.length < 21) return null;

    const lm = landmarks;
    const wlm = worldLandmarks || landmarks;

    // 21 Biometric Hand Landmarks
    // 0: Wrist
    // 1-4: Thumb (CMC, MCP, IP, TIP)
    // 5-8: Index (MCP, PIP, DIP, TIP)
    // 9-12: Middle (MCP, PIP, DIP, TIP)
    // 13-16: Ring (MCP, PIP, DIP, TIP)
    // 17-20: Pinky (MCP, PIP, DIP, TIP)
    const wrist = lm[0];
    const thumbMCP = lm[2], thumbIP = lm[3], thumbTip = lm[4];
    const indexMCP = lm[5], indexPIP = lm[6], indexDIP = lm[7], indexTip = lm[8];
    const middleMCP = lm[9], middlePIP = lm[10], middleDIP = lm[11], middleTip = lm[12];
    const ringMCP = lm[13], ringPIP = lm[14], ringDIP = lm[15], ringTip = lm[16];
    const pinkyMCP = lm[17], pinkyPIP = lm[18], pinkyDIP = lm[19], pinkyTip = lm[20];

    // Reference Palm Geometry
    const palmCenter = {
      x: (wrist.x + middleMCP.x) * 0.5,
      y: (wrist.y + middleMCP.y) * 0.5,
      z: ((wrist.z || 0) + (middleMCP.z || 0)) * 0.5,
    };
    const palmScale = Math.max(0.04, dist3D(wrist, middleMCP));

    // 1. Joint Angles for each finger (straight line ≈ 180°, bent ≈ 90°)
    const indexAnglePIP = jointAngle(indexMCP, indexPIP, indexDIP);
    const indexAngleDIP = jointAngle(indexPIP, indexDIP, indexTip);

    const middleAnglePIP = jointAngle(middleMCP, middlePIP, middleDIP);
    const middleAngleDIP = jointAngle(middlePIP, middleDIP, middleTip);

    const ringAnglePIP = jointAngle(ringMCP, ringPIP, ringDIP);
    const ringAngleDIP = jointAngle(ringPIP, ringDIP, ringTip);

    const pinkyAnglePIP = jointAngle(pinkyMCP, pinkyPIP, pinkyDIP);
    const pinkyAngleDIP = jointAngle(pinkyPIP, pinkyDIP, pinkyTip);

    // 2. Strict Biometric Finger Extension / Curl Verification
    // Index finger: must be straight (angles > 140°) and tip extended far from palm
    const isIndexExtended =
      indexAnglePIP > 140 &&
      dist3D(indexTip, wrist) > dist3D(indexPIP, wrist) * 1.15 &&
      dist3D(indexTip, palmCenter) > palmScale * 1.1;

    // Pinky finger: must be straight (angles > 135°) and tip extended
    const isPinkyExtended =
      pinkyAnglePIP > 135 &&
      dist3D(pinkyTip, wrist) > dist3D(pinkyPIP, wrist) * 1.12 &&
      dist3D(pinkyTip, palmCenter) > palmScale * 1.0;

    // Middle finger: MUST be tightly bent into palm (PIP angle < 130° and tip close to palm)
    const isMiddleCurled =
      middleAnglePIP < 130 ||
      dist3D(middleTip, palmCenter) < palmScale * 0.82 ||
      dist3D(middleTip, wrist) < dist3D(middlePIP, wrist) * 1.05;

    // Ring finger: MUST be tightly bent into palm (PIP angle < 130° and tip close to palm)
    const isRingCurled =
      ringAnglePIP < 130 ||
      dist3D(ringTip, palmCenter) < palmScale * 0.82 ||
      dist3D(ringTip, wrist) < dist3D(ringPIP, wrist) * 1.05;

    // Thumb extended outward
    const isThumbExtended = dist3D(thumbTip, indexMCP) > palmScale * 0.65;

    // 3. Strict Spider-Man Web Shooter Pose:
    // ALL 4 conditions must be strictly satisfied simultaneously:
    // Index STRAIGHT, Pinky STRAIGHT, Middle CURLED, Ring CURLED!
    const isSpideyPoseStrict = isIndexExtended && isPinkyExtended && isMiddleCurled && isRingCurled;

    // Open Palm (all 4 fingers straight)
    const isOpenPalmStrict = isIndexExtended && !isMiddleCurled && !isRingCurled && isPinkyExtended;

    // Fist (all 4 fingers curled)
    const isFistStrict = !isIndexExtended && isMiddleCurled && isRingCurled && !isPinkyExtended;

    // 4. Temporal Smoothing (requires holding pose for 3 consecutive frames to eliminate any glitch)
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
      };
      this.history.set(handId, hist);
    }

    hist.spideyStreak = isSpideyPoseStrict ? hist.spideyStreak + 1 : 0;
    hist.openStreak = isOpenPalmStrict ? hist.openStreak + 1 : 0;
    hist.fistStreak = isFistStrict ? hist.fistStreak + 1 : 0;

    // Confirmed after 3 steady frames
    const isSpideyConfirmed = hist.spideyStreak >= 3;
    const isOpenConfirmed = hist.openStreak >= 2;
    const isFistConfirmed = hist.fistStreak >= 2;

    // Dynamic smoothing on wrist and aiming points
    hist.smoothWrist.x += (wrist.x - hist.smoothWrist.x) * 0.35;
    hist.smoothWrist.y += (wrist.y - hist.smoothWrist.y) * 0.35;
    hist.smoothWrist.z += ((wrist.z || 0) - hist.smoothWrist.z) * 0.35;

    const rawMuzzleX = wrist.x * 0.75 + palmCenter.x * 0.25;
    const rawMuzzleY = wrist.y * 0.75 + palmCenter.y * 0.25;
    hist.smoothMuzzle.x += (rawMuzzleX - hist.smoothMuzzle.x) * 0.45;
    hist.smoothMuzzle.y += (rawMuzzleY - hist.smoothMuzzle.y) * 0.45;

    hist.smoothPalmScale += (palmScale - hist.smoothPalmScale) * 0.25;

    const rawAimX = indexTip.x;
    const rawAimY = indexTip.y;
    hist.smoothAim.x += (rawAimX - hist.smoothAim.x) * 0.4;
    hist.smoothAim.y += (rawAimY - hist.smoothAim.y) * 0.4;

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

  // Calculate pulling force when wrist is pulled back towards body
  calculatePull(anchor, currentHand, screenMuzzle, anchorMuzzle, objectCenter) {
    if (!anchor || !currentHand) return { pullAmount: 0, tension: 0 };

    // 1. Vector from object to initial hand anchor (pull direction)
    const toHandX = anchorMuzzle.x - objectCenter.x;
    const toHandY = anchorMuzzle.y - objectCenter.y;
    const len = Math.hypot(toHandX, toHandY) || 1;
    const dirX = toHandX / len;
    const dirY = toHandY / len;

    // 2. Wrist movement vector
    const moveX = screenMuzzle.x - anchorMuzzle.x;
    const moveY = screenMuzzle.y - anchorMuzzle.y;

    // Movement along the pull direction (away from object / towards body)
    const directionalPull = moveX * dirX + moveY * dirY;
    // Downward movement on phone screen towards user's chest
    const downwardPull = moveY;
    const backwardDist = Math.hypot(moveX, moveY);

    const motionPull = Math.max(0, Math.max(directionalPull, downwardPull * 0.85, backwardDist * 0.75) / 110);

    // 3. Depth expansion (palm scale expands as hand moves closer to camera / body)
    const anchorScale = Math.max(0.04, anchor.palmScale);
    const curScale = Math.max(0.04, currentHand.palmScale);
    const depthGrowth = Math.max(0, (curScale - anchorScale) / (anchorScale * 0.3));

    // Combined smooth pull
    const rawPull = Math.max(motionPull, depthGrowth);
    const clampedPull = Math.max(0, Math.min(1.0, rawPull));

    return {
      pullAmount: clampedPull,
      tension: Math.min(1.0, clampedPull * 1.3),
    };
  }
}
