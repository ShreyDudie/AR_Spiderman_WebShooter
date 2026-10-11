// Spider-Man Web Audio Synthesizer
// Zero external assets required - pure procedural Web Audio API with realistic acoustics
// Fail-safe: all node scheduling wrapped so AudioContext errors never throw or crash the main thread

class SpiderAudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.tensionNode = null;
    this.tensionGain = null;
    this.tensionFilter = null;
    this.isTensionPlaying = false;
    this.spiderSenseCooldown = 0;
  }

  init() {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      this.ctx = new AudioContextClass();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) {
      console.warn('AudioContext init error:', e);
    }
  }

  toggle(enable) {
    this.enabled = enable !== undefined ? enable : !this.enabled;
    if (!this.enabled) {
      this.stopTension();
    } else {
      this.init();
    }
    return this.enabled;
  }

  // Iconic Spider-Man "THWIP!" web shooter sound
  playThwip(power = 1.0) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      // 1. High-pressure air ejection transient (White noise burst through bandpass)
      const bufferSize = Math.floor(ctx.sampleRate * 0.14);
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.035));
      }

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.setValueAtTime(3200, now);
      bandpass.frequency.exponentialRampToValueAtTime(700, now + 0.12);
      bandpass.Q.setValueAtTime(3.2, now);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.22 * power, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

      noiseSource.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noiseSource.start(now);

      // 2. High-velocity silk snap (FM whip oscillator)
      const whipOsc = ctx.createOscillator();
      const whipGain = ctx.createGain();
      whipOsc.type = 'sawtooth';
      whipOsc.frequency.setValueAtTime(1450, now);
      whipOsc.frequency.exponentialRampToValueAtTime(120, now + 0.16);

      whipGain.gain.setValueAtTime(0.18 * power, now);
      whipGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

      whipOsc.connect(whipGain);
      whipGain.connect(ctx.destination);
      whipOsc.start(now);
      whipOsc.stop(now + 0.17);

      // 3. Mechanical click
      const clickOsc = ctx.createOscillator();
      const clickGain = ctx.createGain();
      clickOsc.type = 'triangle';
      clickOsc.frequency.setValueAtTime(3400, now);
      clickOsc.frequency.exponentialRampToValueAtTime(380, now + 0.025);

      clickGain.gain.setValueAtTime(0.24 * power, now);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.026);

      clickOsc.connect(clickGain);
      clickGain.connect(ctx.destination);
      clickOsc.start(now);
      clickOsc.stop(now + 0.028);
    } catch (e) {
      console.warn('Audio playThwip error:', e);
    }
  }

  // Web impact & stick splat
  playImpact() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(280, now);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.12);

      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
    } catch (e) {
      console.warn('Audio playImpact error:', e);
    }
  }

  // Dynamic web tension stretch sound when pulling
  updateTension(tension) {
    if (!this.enabled || !this.ctx) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      if (tension <= 0.04) {
        if (this.isTensionPlaying) this.stopTension();
        return;
      }

      if (!this.isTensionPlaying || !this.tensionNode) {
        this.isTensionPlaying = true;
        this.tensionNode = ctx.createOscillator();
        this.tensionFilter = ctx.createBiquadFilter();
        this.tensionGain = ctx.createGain();

        this.tensionNode.type = 'sawtooth';
        this.tensionFilter.type = 'bandpass';
        this.tensionFilter.Q.value = 5;

        this.tensionGain.gain.setValueAtTime(0.001, now);
        this.tensionNode.connect(this.tensionFilter);
        this.tensionFilter.connect(this.tensionGain);
        this.tensionGain.connect(ctx.destination);
        this.tensionNode.start(now);
      }

      const baseFreq = 85 + tension * 180;
      const filterFreq = 300 + tension * 1100;
      const targetGain = Math.min(0.07, 0.012 + tension * 0.055);

      this.tensionNode.frequency.setTargetAtTime(baseFreq, now, 0.05);
      this.tensionFilter.frequency.setTargetAtTime(filterFreq, now, 0.05);
      this.tensionGain.gain.setTargetAtTime(targetGain, now, 0.05);
    } catch (e) {
      console.warn('Audio updateTension error:', e);
      this.isTensionPlaying = false;
    }
  }

  stopTension() {
    if (!this.isTensionPlaying && !this.tensionNode) return;
    try {
      if (this.ctx && this.tensionGain) {
        this.tensionGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.tensionGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      }
      if (this.tensionNode) {
        try { this.tensionNode.stop(); } catch (e) {}
        try { this.tensionNode.disconnect(); } catch (e) {}
      }
    } catch (e) {
      // Ignored safely
    } finally {
      this.tensionNode = null;
      this.tensionGain = null;
      this.tensionFilter = null;
      this.isTensionPlaying = false;
    }
  }

  // Whoosh sound when object flies closer
  playReelWhoosh(speed = 1.0) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(90, now);
      osc.frequency.exponentialRampToValueAtTime(320 * speed, now + 0.16);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.35);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(450, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.12 * Math.min(1.4, speed), now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.36);
    } catch (e) {
      console.warn('Audio playReelWhoosh error:', e);
    }
  }

  // Catch slam
  playCatch() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(140, now);
      sub.frequency.exponentialRampToValueAtTime(40, now + 0.22);
      subGain.gain.setValueAtTime(0.28, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      sub.connect(subGain);
      subGain.connect(ctx.destination);
      sub.start(now);
      sub.stop(now + 0.26);

      [587.33, 880, 1174.66].forEach((freq, idx) => {
        const chime = ctx.createOscillator();
        const chimeGain = ctx.createGain();
        chime.type = 'sine';
        chime.frequency.setValueAtTime(freq, now + idx * 0.05);
        chimeGain.gain.setValueAtTime(0.07, now + idx * 0.05);
        chimeGain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.05 + 0.26);
        chime.connect(chimeGain);
        chimeGain.connect(ctx.destination);
        chime.start(now + idx * 0.05);
        chime.stop(now + idx * 0.05 + 0.28);
      });
    } catch (e) {
      console.warn('Audio playCatch error:', e);
    }
  }

  // Spider-Sense lock-on warning chime
  playSpiderSense() {
    if (!this.enabled) return;
    const now = performance.now();
    if (now - this.spiderSenseCooldown < 550) return;
    this.spiderSenseCooldown = now;

    this.init();
    if (!this.ctx) return;

    try {
      const ctx = this.ctx;
      const cur = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(987.77, cur);
      osc.frequency.setValueAtTime(1318.51, cur + 0.06);

      gain.gain.setValueAtTime(0.05, cur);
      gain.gain.exponentialRampToValueAtTime(0.0001, cur + 0.16);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(cur);
      osc.stop(cur + 0.17);
    } catch (e) {
      console.warn('Audio playSpiderSense error:', e);
    }
  }

  // Web snap / release sound
  playWebSnap() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.14);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {
      console.warn('Audio playWebSnap error:', e);
    }
  }
}

export const sound = new SpiderAudioEngine();
