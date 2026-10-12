// Camera Stream & MediaPipe Vision Pipeline
// Filters for graspable real-world objects (small = one hand, heavy = two hands) and extracts cutouts
 
const ALLOWED_SMALL_OBJECTS = new Set([
  'bottle', 'cup', 'wine glass', 'mug', 'bowl',
  'cell phone', 'mouse', 'remote', 'keyboard', 'book',
  'apple', 'banana', 'orange', 'sandwich', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'scissors', 'teddy bear', 'clock', 'vase',
  'sports ball', 'baseball bat', 'tennis racket', 'frisbee',
  'toothbrush', 'hair drier', 'fork', 'knife', 'spoon',
  'box', 'can', 'pen', 'pencil', 'umbrella'
]);

// Need BOTH hands to latch and reel
const HEAVY_OBJECTS = new Set([
  'chair', 'laptop', 'backpack', 'handbag', 'suitcase', 'potted plant', 'bench', 'tv', 'microwave', 'toaster'
]);

const BLOCKED_CLASSES = new Set(['person', 'human', 'couch', 'bed', 'refrigerator']);

function boxIoU(boxA, boxB) {
  const ax1 = boxA[0], ay1 = boxA[1], ax2 = boxA[0] + boxA[2], ay2 = boxA[1] + boxA[3];
  const bx1 = boxB[0], by1 = boxB[1], bx2 = boxB[0] + boxB[2], by2 = boxB[1] + boxB[3];

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const interArea = (ix2 - ix1) * (iy2 - iy1);
  const areaA = Math.max(1, boxA[2] * boxA[3]);
  const areaB = Math.max(1, boxB[2] * boxB[3]);
  const unionArea = areaA + areaB - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}
 
function boxCenter(b) {
  return { x: b[0] + b[2] * 0.5, y: b[1] + b[3] * 0.5 };
}
 
export class VisionPipeline {
  constructor(videoElement, canvasElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.stream = null;
    this.facingMode = 'environment';
    this.isMirrored = false;
 
    this.handLandmarker = null;
    this.objectDetector = null;
    this.isReady = false;
 
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.screenWidth = window.innerWidth;
    this.screenHeight = window.innerHeight;
 
    this.lastVideoTime = -1;
    this.lastHandDetectTime = 0;
    this.lastObjectDetectTime = 0;
    this.isObjectDetectBusy = false;
 
    this.autoDetections = [];
    this.trackedDetections = [];
    this.manualTargets = [];
    this.nextDetId = 1;
 
    this.pullDataMap = new Map();

    this.realEnabled = true;
    this.virtualDetections = [];
    this.handCropMode = false;      // true = run the hand model on a zoomed centre crop (far-away hands)
    this.handMissSince = null;
    this.cropCanvas = document.createElement('canvas');
    this.cropCtx = this.cropCanvas.getContext('2d');
  }

  _rebuildTracked() {
    this.trackedDetections = [...this.autoDetections, ...this.manualTargets, ...this.virtualDetections];
  }

  setVirtualDetections(list) {
    this.virtualDetections = list;
    this._rebuildTracked();
  }

  setRealEnabled(on) {
    this.realEnabled = on;
    if (!on) {
      this.autoDetections = [];
      this.manualTargets = [];
    }
    this._rebuildTracked();
  }
 
  async initModels(onProgress) {
    if (onProgress) onProgress('Loading vision neural networks…');
    const visionVersion = '0.10.14';
    const visionCdn = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${visionVersion}`;
 
    const { FilesetResolver, HandLandmarker, ObjectDetector } = await import(
      `${visionCdn}/vision_bundle.mjs`
    );
 
    const vision = await FilesetResolver.forVisionTasks(`${visionCdn}/wasm`);
    const handModelPath =
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
    const objectModelPath =
      'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite';
 
    if (onProgress) onProgress('Initializing Object Scanner…');
    this.objectDetector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: objectModelPath, delegate: 'CPU' },
      runningMode: 'VIDEO',
      maxResults: 15,
      scoreThreshold: 0.20,
    });
 
    if (onProgress) onProgress('Initializing Multi-Hand Tracker…');
    const handOptions = (delegate) => ({
      baseOptions: { modelAssetPath: handModelPath, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.35,
      minHandPresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
    });
    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, handOptions('GPU'));
    } catch (gpuErr) {
      console.warn('GPU hand tracking unavailable; falling back to CPU:', gpuErr);
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, handOptions('CPU'));
    }
 
    this.isReady = true;
    if (onProgress) onProgress('Vision pipeline initialized');
  }
 
  async startCamera(preferredFacing = 'environment') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera API unavailable. Open this page over HTTPS (or http://localhost).');
    }
 
    this.facingMode = preferredFacing;
    this.isMirrored = this.facingMode === 'user';
    this.video.style.transform = this.isMirrored ? 'scaleX(-1)' : 'scaleX(1)';
 
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
 
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: this.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    };
 
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facingMode },
      });
    }
 
    this.video.srcObject = this.stream;
    await this.video.play();
    this.lastVideoTime = -1;
    this.resizeCanvas();
  }
 
  async switchCamera() {
    const nextFacing = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.startCamera(nextFacing);
    this.clearTargets(); // boxes from the other camera no longer line up
    return this.facingMode;
  }
 
  resizeCanvas() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.screenWidth = window.innerWidth;
    this.screenHeight = window.innerHeight;
 
    const w = Math.round(this.screenWidth * this.dpr);
    const h = Math.round(this.screenHeight * this.dpr);
 
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
 
  _cover() {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.max(this.screenWidth / vw, this.screenHeight / vh);
    return {
      vw, vh, scale,
      renderW: vw * scale,
      renderH: vh * scale,
      cropX: (vw * scale - this.screenWidth) * 0.5,
      cropY: (vh * scale - this.screenHeight) * 0.5,
    };
  }
 
  pointToScreen(normPoint) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return { x: normPoint.x * this.screenWidth, y: normPoint.y * this.screenHeight };
    }
    const { renderW, renderH, cropX, cropY } = this._cover();
    const sx = this.isMirrored ? (1 - normPoint.x) * renderW - cropX : normPoint.x * renderW - cropX;
    const sy = normPoint.y * renderH - cropY;
    return { x: sx, y: sy };
  }
 
  // video-pixel box [x,y,w,h] -> screen rect
  boxToScreen(box) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return { x: box[0], y: box[1], w: box[2], h: box[3] };
    }
    const { scale, cropX, cropY } = this._cover();
    const [bx, by, bw, bh] = box;
    const sw = bw * scale;
    const sh = bh * scale;
    const sy = by * scale - cropY;
    const sx = this.isMirrored ? this.screenWidth - (bx * scale - cropX) - sw : bx * scale - cropX;
    return { x: sx, y: sy, w: sw, h: sh };
  }
 
  // screen rect -> video-pixel box [x,y,w,h]  (exact inverse of boxToScreen)
  screenToBox(rect) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return [rect.x, rect.y, rect.w, rect.h];
    }
    const { scale, cropX, cropY } = this._cover();
    const bx = this.isMirrored
      ? (this.screenWidth - rect.x - rect.w + cropX) / scale
      : (rect.x + cropX) / scale;
    const by = (rect.y + cropY) / scale;
    return [bx, by, rect.w / scale, rect.h / scale];
  }

  // Precisely verifies if a screen bounding box is actually the player's own hand
  // (without rejecting real objects that the player points at or aims towards)
  isHandDetection(screenRect, handStates = null) {
    if (!screenRect || screenRect.w <= 0 || screenRect.h <= 0) return false;

    // 1. Check against active analyzed hand states if available
    if (handStates && handStates.length > 0) {
      for (const hand of handStates) {
        if (!hand || !hand.landmarks || hand.landmarks.length < 21) continue;
        if (this._isBoxMatchingHand(screenRect, hand.landmarks, hand.palmCenter)) {
          return true;
        }
      }
      return false;
    }

    // 2. Check against recent raw MediaPipe detections (within 350ms)
    if (!this.lastHandsResult || !this.lastHandsResult.landmarks || this.lastHandsResult.landmarks.length === 0) {
      return false;
    }
    if (performance.now() - (this.lastHandsTime || 0) > 350) {
      return false;
    }

    for (const lms of this.lastHandsResult.landmarks) {
      if (!lms || lms.length < 21) continue;
      const wrist = lms[0];
      const middleMCP = lms[9];
      const palmCenter = {
        x: (wrist.x + middleMCP.x) * 0.5,
        y: (wrist.y + middleMCP.y) * 0.5,
      };
      if (this._isBoxMatchingHand(screenRect, lms, palmCenter)) {
        return true;
      }
    }

    return false;
  }

  _isBoxMatchingHand(screenRect, landmarks, normPalmCenter) {
    const rx1 = screenRect.x;
    const ry1 = screenRect.y;
    const rx2 = screenRect.x + screenRect.w;
    const ry2 = screenRect.y + screenRect.h;

    // Palm center must be inside the bounding box for a box to wrap the hand
    const spPalm = this.pointToScreen(normPalmCenter);
    if (spPalm.x < rx1 || spPalm.x > rx2 || spPalm.y < ry1 || spPalm.y > ry2) {
      return false;
    }

    // Core knuckle/wrist anchor points: wrist(0), thumbMCP(2), indexMCP(5), middleMCP(9), ringMCP(13), pinkyMCP(17)
    const coreIndices = [0, 2, 5, 9, 13, 17];
    let coreAnchorsInside = 0;
    let totalLandmarksInside = 0;

    for (let i = 0; i < landmarks.length; i++) {
      const sp = this.pointToScreen(landmarks[i]);
      if (sp.x >= rx1 && sp.x <= rx2 && sp.y >= ry1 && sp.y <= ry2) {
        totalLandmarksInside++;
        if (coreIndices.includes(i)) {
          coreAnchorsInside++;
        }
      }
    }

    // If palm center is inside AND core knuckles/wrist are inside (or 8+ landmarks inside),
    // then this detection box is the player's hand itself!
    return coreAnchorsInside >= 3 || totalLandmarksInside >= 8;
  }
 
  // Extract pure contour silhouette of the real object without rectangular background box
  captureObjectSnapshot(screenBox) {
    if (!this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    try {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return null;
 
      // Capture at the camera's real pixel density (up to 2x screen size, max 640px on the long
      // side) so the cutout stays sharp when it is scaled up to ~2.8x while being reeled in.
      const probeW = this.screenToBox(screenBox)[2];
      const density = Math.max(1, Math.min(2, probeW / Math.max(1, screenBox.w)));
      const longSide = Math.max(screenBox.w, screenBox.h) * density;
      const capScale = longSide > 640 ? 640 / longSide : 1;
      const w = Math.max(32, Math.round(screenBox.w * density * capScale));
      const h = Math.max(32, Math.round(screenBox.h * density * capScale));
 
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = w;
      snapCanvas.height = h;
      const sctx = snapCanvas.getContext('2d', { willReadFrequently: true });
 
      const [rawSrcX, rawSrcY, rawSrcW, rawSrcH] = this.screenToBox(screenBox);
 
      const srcX = Math.max(0, Math.min(vw - 2, rawSrcX));
      const srcY = Math.max(0, Math.min(vh - 2, rawSrcY));
      const srcW = Math.max(2, Math.min(vw - srcX, rawSrcW));
      const srcH = Math.max(2, Math.min(vh - srcY, rawSrcH));
 
      sctx.save();
      if (this.isMirrored) {
        sctx.translate(w, 0);
        sctx.scale(-1, 1);
      }
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(this.video, srcX, srcY, srcW, srcH, 0, 0, w, h);
      sctx.restore();
 
      // Exact-shape cutout: flood-fill the background in from the box border instead of a
      // plain elliptical vignette, so the kept pixels are the object's real silhouette.
      try {
        const imgData = sctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const n = w * h;
        const isBg = new Uint8Array(n); // 0 = foreground/unknown, 1 = flagged background

        const colorDist2 = (ia, ib) => {
          const dr = data[ia * 4] - data[ib * 4];
          const dg = data[ia * 4 + 1] - data[ib * 4 + 1];
          const db = data[ia * 4 + 2] - data[ib * 4 + 2];
          return dr * dr + dg * dg + db * db;
        };

        // Region-growing flood fill from every border pixel: a neighbour becomes background
        // only if its colour is close to an ALREADY-background neighbour (not a single global
        // average), so it follows gradients/shadows in the real backdrop but still stops dead
        // at the object's edge instead of eating through to same-coloured patches inside it.
        const THRESH2 = 36 * 36;
        const stack = new Int32Array(n);
        let sp = 0;
        const seed = (x, y) => {
          const i = y * w + x;
          if (!isBg[i]) { isBg[i] = 1; stack[sp++] = i; }
        };
        for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
        for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

        while (sp > 0) {
          const i = stack[--sp];
          const x = i % w, y = (i / w) | 0;
          if (x > 0) { const ni = i - 1; if (!isBg[ni] && colorDist2(i, ni) < THRESH2) { isBg[ni] = 1; stack[sp++] = ni; } }
          if (x < w - 1) { const ni = i + 1; if (!isBg[ni] && colorDist2(i, ni) < THRESH2) { isBg[ni] = 1; stack[sp++] = ni; } }
          if (y > 0) { const ni = i - w; if (!isBg[ni] && colorDist2(i, ni) < THRESH2) { isBg[ni] = 1; stack[sp++] = ni; } }
          if (y < h - 1) { const ni = i + w; if (!isBg[ni] && colorDist2(i, ni) < THRESH2) { isBg[ni] = 1; stack[sp++] = ni; } }
        }

        // Safety net: if the flood fill ate almost everything (a near-uniform backdrop that
        // matches the object too, or a detector box with little margin) or almost nothing
        // (noisy backdrop), fall back to the superellipse vignette further down instead of
        // shipping a near-blank or near-unmasked cutout.
        let bgCount = 0;
        for (let i = 0; i < n; i++) bgCount += isBg[i];
        const bgRatio = bgCount / n;
        if (bgRatio > 0.92 || bgRatio < 0.02) throw new Error('flood-fill mask unreliable');

        // Soft 1px feather on the boundary so the exact silhouette doesn't look jagged.
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const idx = i * 4;
            if (isBg[i]) { data[idx + 3] = 0; continue; }
            let bgNeighbors = 0;
            let total = 0;
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const nx = x + ox, ny = y + oy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                total++;
                if (isBg[ny * w + nx]) bgNeighbors++;
              }
            }
            if (bgNeighbors > 0) {
              const edgeAlpha = Math.max(0.15, 1 - bgNeighbors / total);
              data[idx + 3] = Math.round(data[idx + 3] * edgeAlpha);
            }
          }
        }

        sctx.putImageData(imgData, 0, 0);
      } catch (segErr) {
        // Fallback: soft superellipse vignette (keeps boxy corners better than a plain ellipse)
        const imgData2 = sctx.getImageData(0, 0, w, h);
        const data2 = imgData2.data;
        const cx = w * 0.5, cy = h * 0.5, rx = w * 0.5, ry = h * 0.5;
        for (let y = 0; y < h; y++) {
          const dy = (y - cy) / ry;
          for (let x = 0; x < w; x++) {
            const dx = (x - cx) / rx;
            const normDist = Math.pow(dx * dx * dx * dx + dy * dy * dy * dy, 0.25);
            const idx = (y * w + x) * 4;
            if (normDist > 1.0) data2[idx + 3] = 0;
            else if (normDist > 0.8) {
              const edgeAlpha = Math.max(0, Math.min(1, (1.0 - normDist) / 0.2));
              data2[idx + 3] = Math.round(data2[idx + 3] * edgeAlpha);
            }
          }
        }
        sctx.putImageData(imgData2, 0, 0);
      }

      return snapCanvas;
    } catch (e) {
      console.warn('Contour cutout capture failed:', e);
      return null;
    }
  }
 
  // Returns a FRESH hand result, or null when there is nothing new this frame.
  // (The game keeps the last known hands so throttled frames don't look like "hand lost".)
  detectHands(now) {
    if (!this.handLandmarker || !this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return null;
    }
    if (now - this.lastHandDetectTime < 28 || this.video.currentTime === this.lastVideoTime) {
      return null;
    }
    this.lastHandDetectTime = now;
    this.lastVideoTime = this.video.currentTime;
 
    try {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const CROP = 0.58; // zoomed centre window: makes a far-away (small) hand ~1.7x bigger for the model
      let input = this.video;
      let cx0 = 0, cy0 = 0, cw = vw, ch = vh;
      if (this.handCropMode && vw && vh) {
        cw = vw * CROP; ch = vh * CROP;
        cx0 = (vw - cw) / 2; cy0 = (vh - ch) / 2;
        const tw = Math.round(cw), th = Math.round(ch);
        if (this.cropCanvas.width !== tw || this.cropCanvas.height !== th) {
          this.cropCanvas.width = tw;
          this.cropCanvas.height = th;
        }
        this.cropCtx.drawImage(this.video, cx0, cy0, cw, ch, 0, 0, tw, th);
        input = this.cropCanvas;
      }

      let result = this.handLandmarker.detectForVideo(input, now);
      const found = result && result.landmarks && result.landmarks.length > 0;

      if (found) {
        this.handMissSince = null;
        if (this.handCropMode) {
          result = {
            ...result,
            landmarks: result.landmarks.map((hand) =>
              hand.map((p) => ({ ...p, x: (cx0 + p.x * cw) / vw, y: (cy0 + p.y * ch) / vh }))
            ),
          };
        }
        this.lastHandsResult = result;
        this.lastHandsTime = now;
      } else {
        // Nothing seen: alternate between full-frame and zoomed-crop passes until a hand shows up.
        if (this.handMissSince == null) this.handMissSince = now;
        if (now - this.handMissSince > 240) {
          this.handCropMode = !this.handCropMode;
          this.handMissSince = now;
        }
      }
      return result;
    } catch (e) {
      return null;
    }
  }

  detectObjects(now) {
    if (!this.realEnabled || !this.objectDetector || !this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return this.trackedDetections;
    }
    // Update at ~5 fps (200ms) for responsive, low-latency tracking
    if (this.isObjectDetectBusy || now - this.lastObjectDetectTime < 200) {
      return this.trackedDetections;
    }

    this.isObjectDetectBusy = true;
    this.lastObjectDetectTime = now;

    try {
      const result = this.objectDetector.detectForVideo(this.video, now);
      const screenTotalArea = this.screenWidth * this.screenHeight;

      const raw = result.detections
        .map((d) => {
          const cat = d.categories[0];
          const box = d.boundingBox;
          const name = (cat.displayName || cat.categoryName || '').toLowerCase().trim();
          return {
            bbox: [box.originX, box.originY, box.width, box.height],
            class: name,
            score: cat.score,
            manual: false,
            heavy: HEAVY_OBJECTS.has(name),
          };
        })
        .filter((d) => {
          if (d.score < 0.22) return false;
          if (BLOCKED_CLASSES.has(d.class)) return false;
          if (!d.heavy && !ALLOWED_SMALL_OBJECTS.has(d.class)) return false;

          const rect = this.boxToScreen(d.bbox);
          if (rect.w < 20 || rect.h < 20) return false;

          const area = rect.w * rect.h;
          const maxArea = d.heavy ? 0.70 : 0.50;
          const maxH = d.heavy ? 0.90 : 0.80;
          if (area > screenTotalArea * maxArea || rect.h > this.screenHeight * maxH) return false;

          // Reject false positives that are the user's hand
          if (this.isHandDetection(rect)) return false;

          return true;
        });

      // Spatial tracking (IoU + distance matching) ensures rock-solid tracking stability
      const prevList = this.autoDetections;
      const used = new Set();
      const matched = [];

      for (const newDet of raw) {
        let bestPrev = null;
        let bestQuality = -Infinity;

        const nc = boxCenter(newDet.bbox);
        const newMaxDim = Math.max(newDet.bbox[2], newDet.bbox[3]);

        for (const prev of prevList) {
          if (used.has(prev.id)) continue;
          const iou = boxIoU(newDet.bbox, prev.bbox);
          const pc = boxCenter(prev.bbox);
          const dist = Math.hypot(nc.x - pc.x, nc.y - pc.y);
          const prevMaxDim = Math.max(prev.bbox[2], prev.bbox[3]);
          const normDist = dist / Math.max(1, Math.max(newMaxDim, prevMaxDim));
          const sameClass = prev.class === newDet.class;

          let quality = -1;
          if (iou > 0.20) {
            quality = iou * 2.0 + (sameClass ? 1.0 : 0.3);
          } else if (normDist < 0.65) {
            quality = (1 - normDist) + (sameClass ? 0.8 : 0.2);
          }

          if (quality > 0.45 && quality > bestQuality) {
            bestQuality = quality;
            bestPrev = prev;
          }
        }

        if (bestPrev) {
          used.add(bestPrev.id);
          // Responsive lerp (0.65 new weight) tracks moving camera and moving objects tightly
          const smoothBox = [
            bestPrev.bbox[0] * 0.35 + newDet.bbox[0] * 0.65,
            bestPrev.bbox[1] * 0.35 + newDet.bbox[1] * 0.65,
            bestPrev.bbox[2] * 0.35 + newDet.bbox[2] * 0.65,
            bestPrev.bbox[3] * 0.35 + newDet.bbox[3] * 0.65,
          ];
          matched.push({
            ...newDet,
            id: bestPrev.id,
            bbox: smoothBox,
            score: Math.max(bestPrev.score * 0.9, newDet.score),
            missed: 0,
          });
        } else {
          matched.push({
            ...newDet,
            id: `det_${this.nextDetId++}_${newDet.class.replace(/\s+/g, '_')}`,
            missed: 0,
          });
        }
      }

      // Persist briefly-missed objects for up to 4 frames (~800ms) to prevent flicker
      for (const prev of prevList) {
        if (!used.has(prev.id) && (prev.missed || 0) < 4) {
          const pRect = this.boxToScreen(prev.bbox);
          if (!this.isHandDetection(pRect)) {
            matched.push({
              ...prev,
              missed: (prev.missed || 0) + 1,
              score: prev.score * 0.94,
            });
          }
        }
      }

      this.autoDetections = matched;
      this._rebuildTracked();
    } catch (err) {
      console.warn('Object detection error:', err);
    } finally {
      this.isObjectDetectBusy = false;
    }

    return this.trackedDetections;
  }
 
  addManualTarget(screenRect) {
    const box = this.screenToBox(screenRect);
    const areaRatio = (screenRect.w * screenRect.h) / (this.screenWidth * this.screenHeight);
    const manual = {
      id: `manual_${Date.now()}`,
      bbox: box,
      class: 'TARGET',
      score: 1.0,
      manual: true,
      heavy: areaRatio > 0.12, // big hand-drawn selections count as heavy (two-hand) objects
    };
    this.manualTargets.unshift(manual);
    if (this.manualTargets.length > 6) this.manualTargets.pop();
    this._rebuildTracked();
    return manual;
  }
 
  clearTargets() {
    this.manualTargets = [];
    this.autoDetections = [];
    this._rebuildTracked();
    this.lastObjectDetectTime = 0;
  }
 
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
    }
    if (this.objectDetector) {
      this.objectDetector.close();
      this.objectDetector = null;
    }
    this.isReady = false;
  }
}