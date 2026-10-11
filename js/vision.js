// Camera Stream & MediaPipe Vision Pipeline
// Filters for graspable real-world objects (small = one hand, heavy = two hands) and extracts cutouts
 
const ALLOWED_SMALL_OBJECTS = new Set([
  'bottle', 'cup', 'wine glass', 'mug', 'bowl',
  'cell phone', 'mouse', 'remote', 'keyboard', 'book',
  'apple', 'banana', 'orange', 'sandwich', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'scissors', 'teddy bear', 'clock', 'vase',
  'sports ball', 'baseball bat', 'tennis racket', 'frisbee',
  'toothbrush', 'hair drier', 'fork', 'knife', 'spoon',
  'box', 'can', 'pen', 'pencil'
]);
 
// Need BOTH hands to latch and reel
const HEAVY_OBJECTS = new Set([
  'chair', 'laptop', 'backpack', 'handbag', 'suitcase', 'potted plant', 'bench'
]);
 
const BLOCKED_CLASSES = new Set(['person', 'human', 'couch', 'bed', 'refrigerator']);
 
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
      scoreThreshold: 0.25,
    });
 
    if (onProgress) onProgress('Initializing Multi-Hand Tracker…');
    const handOptions = (delegate) => ({
      baseOptions: { modelAssetPath: handModelPath, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
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
 
  // Extract pure contour silhouette of the real object without rectangular background box
  captureObjectSnapshot(screenBox) {
    if (!this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    try {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return null;
 
      const w = Math.max(32, Math.round(screenBox.w));
      const h = Math.max(32, Math.round(screenBox.h));
 
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
      sctx.drawImage(this.video, srcX, srcY, srcW, srcH, 0, 0, w, h);
      sctx.restore();
 
      // Contour edge mask extraction
      try {
        const imgData = sctx.getImageData(0, 0, w, h);
        const data = imgData.data;
 
        let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
        for (let x = 0; x < w; x++) {
          const topIdx = x * 4;
          const botIdx = ((h - 1) * w + x) * 4;
          bgR += data[topIdx] + data[botIdx];
          bgG += data[topIdx + 1] + data[botIdx + 1];
          bgB += data[topIdx + 2] + data[botIdx + 2];
          bgCount += 2;
        }
        for (let y = 1; y < h - 1; y++) {
          const leftIdx = (y * w) * 4;
          const rightIdx = (y * w + (w - 1)) * 4;
          bgR += data[leftIdx] + data[rightIdx];
          bgG += data[leftIdx + 1] + data[rightIdx + 1];
          bgB += data[leftIdx + 2] + data[rightIdx + 2];
          bgCount += 2;
        }
        bgR /= Math.max(1, bgCount);
        bgG /= Math.max(1, bgCount);
        bgB /= Math.max(1, bgCount);
 
        const cx = w * 0.5;
        const cy = h * 0.5;
        const rx = w * 0.5;
        const ry = h * 0.5;
 
        for (let y = 0; y < h; y++) {
          const dy = (y - cy) / ry;
          for (let x = 0; x < w; x++) {
            const dx = (x - cx) / rx;
            const normDist = Math.sqrt(dx * dx + dy * dy);
            const idx = (y * w + x) * 4;
 
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
 
            const colorDiff = Math.sqrt(
              (r - bgR) * (r - bgR) +
              (g - bgG) * (g - bgG) +
              (b - bgB) * (b - bgB)
            );
 
            if (normDist > 1.0) {
              data[idx + 3] = 0;
            } else if (normDist > 0.82 && colorDiff < 42) {
              data[idx + 3] = 0;
            } else if (normDist > 0.8) {
              const edgeAlpha = Math.max(0, Math.min(1, (1.0 - normDist) / 0.2));
              data[idx + 3] = Math.round(data[idx + 3] * edgeAlpha);
            }
          }
        }
 
        sctx.putImageData(imgData, 0, 0);
      } catch (segErr) {
        sctx.globalCompositeOperation = 'destination-in';
        sctx.beginPath();
        sctx.ellipse(w * 0.5, h * 0.5, w * 0.48, h * 0.48, 0, 0, Math.PI * 2);
        sctx.fill();
        sctx.globalCompositeOperation = 'source-over';
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
      return this.handLandmarker.detectForVideo(this.video, now);
    } catch (e) {
      return null;
    }
  }
 
  detectObjects(now) {
    if (!this.objectDetector || !this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return this.trackedDetections;
    }
    if (this.isObjectDetectBusy || now - this.lastObjectDetectTime < 320) {
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
          if (d.score < 0.28) return false;
          if (BLOCKED_CLASSES.has(d.class)) return false;
          if (!d.heavy && !ALLOWED_SMALL_OBJECTS.has(d.class)) return false;
 
          const rect = this.boxToScreen(d.bbox);
          const area = rect.w * rect.h;
          const maxArea = d.heavy ? 0.55 : 0.28;
          const maxH = d.heavy ? 0.85 : 0.65;
          if (area > screenTotalArea * maxArea || rect.h > this.screenHeight * maxH) return false;
          return true;
        });
 
      // Match against last frame so every object keeps a STABLE id (and smooth box)
      const prevList = this.autoDetections;
      const used = new Set();
      const matched = raw.map((newDet) => {
        const nc = boxCenter(newDet.bbox);
        const limit = Math.max(newDet.bbox[2], newDet.bbox[3]);
        let best = null;
        let bestD = Infinity;
        for (const p of prevList) {
          if (used.has(p.id) || p.class !== newDet.class) continue;
          const pc = boxCenter(p.bbox);
          const dd = Math.hypot(nc.x - pc.x, nc.y - pc.y);
          if (dd < limit && dd < bestD) {
            best = p;
            bestD = dd;
          }
        }
        if (!best) {
          return {
            ...newDet,
            id: `det_${this.nextDetId++}_${newDet.class.replace(/\s+/g, '_')}`,
            missed: 0,
          };
        }
        used.add(best.id);
        const smoothBox = newDet.bbox.map((val, idx) => best.bbox[idx] + (val - best.bbox[idx]) * 0.4);
        return { ...newDet, id: best.id, bbox: smoothBox, missed: 0 };
      });
 
      // Keep briefly-missed objects so targets don't flicker on a single dropped detection
      for (const p of prevList) {
        if (!used.has(p.id) && (p.missed || 0) < 2) matched.push({ ...p, missed: (p.missed || 0) + 1 });
      }
 
      this.autoDetections = matched;
      this.trackedDetections = [...matched, ...this.manualTargets];
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
    this.trackedDetections = [...this.autoDetections, ...this.manualTargets];
    return manual;
  }
 
  clearTargets() {
    this.manualTargets = [];
    this.autoDetections = [];
    this.trackedDetections = [];
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