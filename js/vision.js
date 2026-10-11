// Camera Stream & MediaPipe Vision Pipeline
// Filters strictly for small graspable real-world objects (no humans/massive furniture)
// Supports rear/front camera switching, mirroring, coordinate projection, and AR snapshots

// Whitelist strictly of small, graspable real-world objects
const ALLOWED_SMALL_OBJECTS = new Set([
  'bottle', 'cup', 'wine glass', 'mug', 'bowl',
  'cell phone', 'mouse', 'remote', 'keyboard', 'book',
  'apple', 'banana', 'orange', 'sandwich', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'scissors', 'teddy bear', 'clock', 'vase',
  'sports ball', 'baseball bat', 'tennis racket', 'frisbee',
  'toothbrush', 'hair drier', 'fork', 'knife', 'spoon',
  'box', 'can', 'pen', 'pencil'
]);

export class VisionPipeline {
  constructor(videoElement, canvasElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.stream = null;
    this.facingMode = 'environment'; // 'environment' (rear) or 'user' (selfie)
    this.isMirrored = false; // front is mirrored, rear is unmirrored

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

    this.trackedDetections = [];
    this.manualTargets = [];
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
    try {
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: handModelPath, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } catch (gpuErr) {
      console.warn('GPU hand tracking unavailable; falling back to CPU:', gpuErr);
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: handModelPath, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }

    this.isReady = true;
    if (onProgress) onProgress('Vision pipeline initialized');
  }

  async startCamera(preferredFacing = 'environment') {
    this.facingMode = preferredFacing;
    this.isMirrored = this.facingMode === 'user';
    this.video.style.transform = this.isMirrored ? 'scaleX(-1)' : 'scaleX(1)';

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access not supported on this device/browser. Use HTTPS or localhost.');
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

    if (!this.video.videoWidth || !this.video.videoHeight) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Camera video stream timeout')), 7000);
        this.video.addEventListener(
          'loadedmetadata',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
      });
    }

    this.resizeCanvas();
  }

  async switchCamera() {
    const nextFacing = this.facingMode === 'environment' ? 'user' : 'environment';
    await this.startCamera(nextFacing);
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

  pointToScreen(normPoint) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return { x: normPoint.x * this.screenWidth, y: normPoint.y * this.screenHeight };
    }

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.max(this.screenWidth / vw, this.screenHeight / vh);
    const renderW = vw * scale;
    const renderH = vh * scale;
    const cropX = (renderW - this.screenWidth) * 0.5;
    const cropY = (renderH - this.screenHeight) * 0.5;

    let sx;
    if (this.isMirrored) {
      sx = (1 - normPoint.x) * renderW - cropX;
    } else {
      sx = normPoint.x * renderW - cropX;
    }
    const sy = normPoint.y * renderH - cropY;

    return { x: sx, y: sy };
  }

  boxToScreen(box) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return { x: box[0], y: box[1], w: box[2], h: box[3] };
    }

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.max(this.screenWidth / vw, this.screenHeight / vh);
    const renderW = vw * scale;
    const cropX = (renderW - this.screenWidth) * 0.5;
    const cropY = (vh * scale - this.screenHeight) * 0.5;

    const [bx, by, bw, bh] = box;
    const sw = bw * scale;
    const sh = bh * scale;
    const sy = by * scale - cropY;

    let sx;
    if (this.isMirrored) {
      sx = this.screenWidth - (bx * scale - cropX) - sw;
    } else {
      sx = bx * scale - cropX;
    }

    return { x: sx, y: sy, w: sw, h: sh };
  }

  screenToBox(rect) {
    if (!this.video.videoWidth || !this.video.videoHeight) {
      return [rect.x, rect.y, rect.w, rect.h];
    }

    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.max(this.screenWidth / vw, this.screenHeight / vh);
    const renderW = vw * scale;
    const cropX = (renderW - this.screenWidth) * 0.5;
    const cropY = (vh * scale - this.screenHeight) * 0.5;

    let bx;
    if (this.isMirrored) {
      bx = (this.screenWidth - rect.x - cropX - rect.w) / scale;
    } else {
      bx = (rect.x + cropX) / scale;
    }
    const by = (rect.y + cropY) / scale;
    const bw = rect.w / scale;
    const bh = rect.h / scale;

    return [bx, by, bw, bh];
  }

  captureObjectSnapshot(screenBox) {
    if (!this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    try {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return null;

      const scale = Math.max(this.screenWidth / vw, this.screenHeight / vh);
      const cropX = (vw * scale - this.screenWidth) * 0.5;
      const cropY = (vh * scale - this.screenHeight) * 0.5;

      const w = Math.max(32, Math.round(screenBox.w));
      const h = Math.max(32, Math.round(screenBox.h));

      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = w;
      snapCanvas.height = h;
      const sctx = snapCanvas.getContext('2d');

      let rawSrcX = this.isMirrored
        ? (this.screenWidth - screenBox.x - screenBox.w - cropX) / scale
        : (screenBox.x + cropX) / scale;
      let rawSrcY = (screenBox.y + cropY) / scale;
      let rawSrcW = screenBox.w / scale;
      let rawSrcH = screenBox.h / scale;

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

      // Extract actual contoured silhouette dimensions (remove rectangular background)
      try {
        const imgData = sctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // Sample background color along 4 perimeter borders
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

        // Mask out background pixels, leaving only the actual object
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

            // If outside object boundary or matching background, make transparent
            if (normDist > 1.0) {
              data[idx + 3] = 0;
            } else if (normDist > 0.82 && colorDiff < 42) {
              data[idx + 3] = 0;
            } else if (normDist > 0.8) {
              // Smooth feathered edge
              const edgeAlpha = Math.max(0, Math.min(1, (1.0 - normDist) / 0.2));
              data[idx + 3] = Math.round(data[idx + 3] * edgeAlpha);
            }
          }
        }

        sctx.putImageData(imgData, 0, 0);
      } catch (segErr) {
        // Fallback to clipped oval mask if getImageData restricted
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
      console.error('Hand landmark error:', e);
      return null;
    }
  }

  detectObjects(now) {
    if (!this.objectDetector || !this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return this.trackedDetections;
    }
    if (this.isObjectDetectBusy || now - this.lastObjectDetectTime < 380) {
      return this.trackedDetections;
    }

    this.isObjectDetectBusy = true;
    this.lastObjectDetectTime = now;

    try {
      const result = this.objectDetector.detectForVideo(this.video, now);
      const screenTotalArea = this.screenWidth * this.screenHeight;

      const raw = result.detections
        .map((d, index) => {
          const cat = d.categories[0];
          const box = d.boundingBox;
          const name = (cat.displayName || cat.categoryName || '').toLowerCase().trim();
          return {
            id: `det_${index}_${name}`,
            bbox: [box.originX, box.originY, box.width, box.height],
            class: name,
            score: cat.score,
            manual: false,
          };
        })
        .filter((d) => {
          // 1. Minimum confidence score
          if (d.score < 0.28) return false;

          // 2. Filter out humans, entire bodies, large furniture, and vehicles
          if (
            d.class === 'person' ||
            d.class === 'human' ||
            d.class === 'traffic light' ||
            d.class === 'bench' ||
            d.class === 'chair' ||
            d.class === 'couch' ||
            d.class === 'bed' ||
            d.class === 'bus' ||
            d.class === 'train' ||
            d.class === 'truck' ||
            d.class === 'refrigerator'
          ) {
            return false;
          }

          // 3. Only accept small/graspable objects whitelist
          const isAllowed = ALLOWED_SMALL_OBJECTS.has(d.class);
          if (!isAllowed) return false;

          // 4. Maximum size guard: small objects should not occupy more than 28% of the entire screen
          const rect = this.boxToScreen(d.bbox);
          const area = rect.w * rect.h;
          if (area > screenTotalArea * 0.28 || rect.h > this.screenHeight * 0.65) {
            return false;
          }

          return true;
        });

      this.trackedDetections = [...raw, ...this.manualTargets];
    } catch (err) {
      console.warn('Object detection frame error:', err);
    } finally {
      this.isObjectDetectBusy = false;
    }

    return this.trackedDetections;
  }

  addManualTarget(screenRect) {
    const box = this.screenToBox(screenRect);
    const manual = {
      id: `manual_${Date.now()}`,
      bbox: box,
      class: 'TARGET',
      score: 1.0,
      manual: true,
    };
    this.manualTargets.unshift(manual);
    if (this.manualTargets.length > 6) this.manualTargets.pop();
    this.trackedDetections = [
      ...this.trackedDetections.filter((d) => !d.manual),
      ...this.manualTargets,
    ];
    return manual;
  }

  clearTargets() {
    this.manualTargets = [];
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
