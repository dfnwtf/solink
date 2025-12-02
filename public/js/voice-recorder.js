/**
 * VoiceRecorder - Audio recording module with cross-browser support
 * Supports: Chrome/Firefox (WebM/Opus), Safari (MP4/AAC or WAV)
 */

// Polyfill for roundRect (Safari < 16)
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
  };
}

const MAX_DURATION_MS = 120000; // 2 minutes
const TIMESLICE_MS = 1000; // Collect data every second

export class VoiceRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.startTime = 0;
    this.duration = 0;
    this.mimeType = null;
    this.isRecording = false;
    this.maxDurationTimer = null;
    this.durationInterval = null;
    
    // Web Audio API for waveform
    this.audioContext = null;
    this.analyser = null;
    this.dataArray = null;
    this.waveformData = []; // Collected waveform samples
    this.waveformInterval = null;
    this.isCancelled = false; // Flag to prevent onStop on cancel
    
    // Callbacks
    this.onStart = null;
    this.onStop = null;
    this.onData = null;
    this.onError = null;
    this.onDurationUpdate = null;
    this.onWaveformUpdate = null; // New: real-time waveform callback
  }

  /**
   * Get supported MIME type for current browser
   */
  static getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus',
      'audio/wav',
    ];
    
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log('[VoiceRecorder] Using MIME type:', type);
        return type;
      }
    }
    
    console.warn('[VoiceRecorder] No supported MIME type found, using default');
    return ''; // Let browser choose
  }

  /**
   * Check if microphone is available
   */
  static async checkPermission() {
    try {
      const result = await navigator.permissions.query({ name: 'microphone' });
      return result.state; // 'granted', 'denied', 'prompt'
    } catch {
      return 'prompt'; // Fallback for browsers without Permissions API
    }
  }

  /**
   * Request microphone access
   */
  async requestMicrophone() {
    console.log('[VoiceRecorder] Requesting microphone access...');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      console.log('[VoiceRecorder] Microphone access granted');
      
      // Setup Web Audio API for waveform visualization
      this.setupAudioAnalyser();
      
      return true;
    } catch (err) {
      console.error('[VoiceRecorder] Microphone access error:', err.name, err.message);
      
      let errorMessage = 'Microphone access denied';
      if (err.name === 'NotAllowedError') {
        errorMessage = 'Microphone permission denied. Please allow access in browser settings.';
      } else if (err.name === 'NotFoundError') {
        errorMessage = 'No microphone found on this device.';
      } else if (err.name === 'NotReadableError') {
        errorMessage = 'Microphone is being used by another application.';
      } else if (err.name === 'NotSupportedError') {
        errorMessage = 'Microphone not supported in this browser.';
      } else if (err.name === 'SecurityError') {
        errorMessage = 'Microphone blocked by security policy.';
      }
      
      this.onError?.(new Error(errorMessage));
      return false;
    }
  }

  /**
   * Setup Web Audio API analyser for waveform visualization
   */
  setupAudioAnalyser() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.3;
      
      const source = this.audioContext.createMediaStreamSource(this.stream);
      source.connect(this.analyser);
      
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      console.log('[VoiceRecorder] Audio analyser setup complete');
    } catch (err) {
      console.warn('[VoiceRecorder] Could not setup audio analyser:', err);
    }
  }

  /**
   * Start collecting waveform data
   */
  startWaveformCollection() {
    if (!this.analyser) return;
    
    this.waveformData = [];
    const SAMPLES_PER_SECOND = 20; // Collect 20 samples per second
    
    this.waveformInterval = setInterval(() => {
      if (!this.isRecording || !this.analyser) return;
      
      this.analyser.getByteTimeDomainData(this.dataArray);
      
      // Calculate RMS (root mean square) for volume level
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        const value = (this.dataArray[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / this.dataArray.length);
      const normalizedLevel = Math.min(1, rms * 3); // Normalize and amplify
      
      this.waveformData.push(normalizedLevel);
      this.onWaveformUpdate?.(normalizedLevel, this.waveformData);
    }, 1000 / SAMPLES_PER_SECOND);
  }

  /**
   * Stop waveform collection
   */
  stopWaveformCollection() {
    if (this.waveformInterval) {
      clearInterval(this.waveformInterval);
      this.waveformInterval = null;
    }
  }

  /**
   * Get normalized waveform data (resampled to fixed number of bars)
   */
  getWaveformBars(numBars = 50) {
    if (this.waveformData.length === 0) return new Array(numBars).fill(0.1);
    
    const bars = [];
    const samplesPerBar = Math.max(1, Math.floor(this.waveformData.length / numBars));
    
    for (let i = 0; i < numBars; i++) {
      const start = i * samplesPerBar;
      const end = Math.min(start + samplesPerBar, this.waveformData.length);
      
      if (start >= this.waveformData.length) {
        bars.push(0.1);
        continue;
      }
      
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += this.waveformData[j];
      }
      bars.push(Math.max(0.1, sum / (end - start)));
    }
    
    return bars;
  }

  /**
   * Start recording
   */
  async start() {
    if (this.isRecording) {
      console.warn('[VoiceRecorder] Already recording');
      return false;
    }

    // Request microphone if not already done
    if (!this.stream) {
      const hasAccess = await this.requestMicrophone();
      if (!hasAccess) return false;
    }

    this.mimeType = VoiceRecorder.getSupportedMimeType();
    this.audioChunks = [];
    this.duration = 0;
    this.isCancelled = false; // Reset cancel flag

    try {
      const options = this.mimeType ? { mimeType: this.mimeType } : {};
      this.mediaRecorder = new MediaRecorder(this.stream, options);
      
      // Store actual MIME type used
      this.mimeType = this.mediaRecorder.mimeType;
      
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
          this.onData?.(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.isRecording = false;
        this.clearMaxDurationTimer();
        this.stopWaveformCollection();
        
        // Don't trigger onStop if cancelled
        if (this.isCancelled) {
          this.isCancelled = false;
          console.log('[VoiceRecorder] Stopped (cancelled, not sending)');
          return;
        }
        
        const blob = new Blob(this.audioChunks, { type: this.mimeType });
        this.duration = Math.round((Date.now() - this.startTime) / 1000);
        const waveform = this.getWaveformBars(50); // 50 bars for visualization
        
        console.log('[VoiceRecorder] Stopped, duration:', this.duration, 'size:', blob.size, 'waveform bars:', waveform.length);
        this.onStop?.({ blob, duration: this.duration, mimeType: this.mimeType, waveform });
      };

      this.mediaRecorder.onerror = (event) => {
        console.error('[VoiceRecorder] Error:', event.error);
        this.onError?.(event.error);
        this.cancel();
      };

      // Start recording
      this.mediaRecorder.start(TIMESLICE_MS);
      this.startTime = Date.now();
      this.isRecording = true;
      
      // Start waveform collection
      this.startWaveformCollection();
      
      // Set max duration timer
      this.maxDurationTimer = setTimeout(() => {
        console.log('[VoiceRecorder] Max duration reached, stopping');
        this.stop();
      }, MAX_DURATION_MS);

      // Duration update interval
      this.durationInterval = setInterval(() => {
        if (this.isRecording) {
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          this.onDurationUpdate?.(elapsed);
        }
      }, 100);

      this.onStart?.();
      console.log('[VoiceRecorder] Started recording');
      return true;
    } catch (err) {
      console.error('[VoiceRecorder] Start error:', err);
      this.onError?.(err);
      return false;
    }
  }

  /**
   * Stop recording and return audio blob
   */
  stop() {
    console.log('[VoiceRecorder] Stop called, isRecording:', this.isRecording, 'state:', this.mediaRecorder?.state);
    
    if (!this.isRecording || !this.mediaRecorder) {
      console.warn('[VoiceRecorder] Not recording, nothing to stop');
      return false;
    }

    this.clearMaxDurationTimer();
    clearInterval(this.durationInterval);
    
    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      return true;
    }
    return false;
  }

  /**
   * Cancel recording without saving
   */
  cancel() {
    this.clearMaxDurationTimer();
    clearInterval(this.durationInterval);
    this.stopWaveformCollection();
    
    // Set flag before stopping to prevent onStop callback
    this.isCancelled = true;
    
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    
    this.audioChunks = [];
    this.waveformData = [];
    this.isRecording = false;
    this.releaseStream();
    
    console.log('[VoiceRecorder] Cancelled');
  }

  /**
   * Release microphone stream
   */
  releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
      this.analyser = null;
    }
  }

  /**
   * Clear max duration timer
   */
  clearMaxDurationTimer() {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  /**
   * Cleanup all resources
   */
  destroy() {
    this.cancel();
    this.releaseStream();
    this.onStart = null;
    this.onStop = null;
    this.onData = null;
    this.onError = null;
    this.onDurationUpdate = null;
    this.onWaveformUpdate = null;
  }
}

/**
 * Format seconds to MM:SS
 */
export function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Draw waveform on canvas
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {number[]} bars - Array of bar heights (0-1)
 * @param {number} progress - Playback progress (0-1)
 * @param {string} playedColor - Color for played portion
 * @param {string} unplayedColor - Color for unplayed portion
 */
export function drawWaveform(canvas, bars, progress = 0, playedColor = '#d4782a', unplayedColor = 'rgba(255,255,255,0.3)') {
  if (!canvas || !bars || bars.length === 0) return;
  
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const barCount = bars.length;
  const barWidth = Math.max(2, (width / barCount) * 0.7);
  const gap = (width - barWidth * barCount) / (barCount - 1 || 1);
  const minHeight = 4;
  const maxHeight = height - 4;
  
  ctx.clearRect(0, 0, width, height);
  
  const progressX = progress * width;
  
  for (let i = 0; i < barCount; i++) {
    const x = i * (barWidth + gap);
    const barHeight = Math.max(minHeight, bars[i] * maxHeight);
    const y = (height - barHeight) / 2;
    
    // Determine color based on progress
    ctx.fillStyle = x < progressX ? playedColor : unplayedColor;
    
    // Draw rounded bar
    const radius = barWidth / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, radius);
    ctx.fill();
  }
}

/**
 * Create waveform canvas element
 * @param {number[]} bars - Waveform data
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 */
export function createWaveformCanvas(bars, width = 200, height = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'voice-waveform';
  
  drawWaveform(canvas, bars, 0);
  return canvas;
}

export default VoiceRecorder;

