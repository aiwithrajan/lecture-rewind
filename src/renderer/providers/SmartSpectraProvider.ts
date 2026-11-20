import { SmartSpectraSDK } from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { Landmark3D, SignalFrame } from '@shared/types';
import { SignalProvider, FrameCallback, ErrorCallback } from './SignalProvider';
import { computeCompositeEAR } from '../engine/LandmarkGeometry';

export interface SmartSpectraProviderOptions {
  apiKey?: string;
  telemetryEnabled?: boolean;
  onStreamAvailable?: (stream: MediaStream) => void;
}

/**
 * SmartSpectraProvider wraps the Presage SmartSpectra SDK in the renderer process,
 * with seamless local on-device MediaPipe 478-point FaceMesh fallback when native
 * C-FFI libraries are unavailable for the host CPU architecture (e.g. darwin-x64).
 *
 * Strictly adheres to PRD Section 8.1 (Selective subscription), Section 11.5 (No LLM insights),
 * Acceptance Criterion 8 (Zero external network requests), and FR-18 (Telemetry disabled by default).
 */
export class SmartSpectraProvider implements SignalProvider {
  private sdk: SmartSpectraSDK | null = null;
  private isRunning: boolean = false;
  private frameCallbacks: FrameCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private options: SmartSpectraProviderOptions;
  private currentConfidence: number = 1.0;

  // Local on-device webcam + MediaPipe FaceMesh fallback state
  private mediaStream: MediaStream | null = null;
  private hiddenVideo: HTMLVideoElement | null = null;
  private faceMesh: any = null;
  private rafId: number | null = null;
  private isProcessingFrame: boolean = false;
  private startTimeMs: number = 0;
  private lastSendMs: number = 0;
  private blinkThreshold: number = 0.22;
  private consecutiveNoFaceCount: number = 0;

  constructor(options: SmartSpectraProviderOptions = {}) {
    this.options = {
      apiKey: options.apiKey || (import.meta as any).env?.VITE_SMARTSPECTRA_API_KEY || '',
      telemetryEnabled: options.telemetryEnabled ?? false,
      onStreamAvailable: options.onStreamAvailable
    };
  }

  public onFrame(callback: FrameCallback): void {
    this.frameCallbacks.push(callback);
  }

  public clearFrameListeners(): void {
    this.frameCallbacks = [];
  }

  public onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  public setOnStreamAvailable(cb?: (stream: MediaStream) => void): void {
    this.options.onStreamAvailable = cb;
    if (cb && this.mediaStream) {
      cb(this.mediaStream);
    }
  }

  public setBlinkThreshold(threshold: number): void {
    if (Number.isFinite(threshold) && threshold > 0.05 && threshold < 0.45) {
      this.blinkThreshold = threshold;
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    // Attempt Presage Native SDK first with short IPC timeout
    let nativeStarted = false;
    if (this.options.apiKey && typeof (window as any).__smartspectraBridge !== 'undefined') {
      try {
        this.sdk = new SmartSpectraSDK({
          apiKey: this.options.apiKey,
          sendTimeoutMs: 1500
        });

        this.sdk.on('streamAvailable', (stream: MediaStream) => {
          this.mediaStream = stream;
          this.options.onStreamAvailable?.(stream);
        });

        this.sdk.on('validationStatus', (code: number) => {
          this.currentConfidence = code === 0 ? 0.95 : 0.40;
        });

        this.sdk.on('metrics', (buf: Uint8Array, timestampUs: number) => {
          try {
            const decoded = decodeMetrics(buf);
            this.handleDecodedMetrics(decoded, timestampUs);
          } catch {
            // Ignore malformed protobuf frame
          }
        });

        // Banned by PRD Section 11.5: LLM insights are dropped immediately
        this.sdk.on('insight', () => {});

        this.sdk.on('error', (_code: number, message: string) => {
          const err = new Error(`SmartSpectra SDK Error: ${message}`);
          for (const cb of this.errorCallbacks) {
            cb(err);
          }
        });

        await this.sdk.start();
        nativeStarted = true;
        this.isRunning = true;
      } catch {
        // Native C-FFI not bound on this CPU architecture; tear down and fall back to local FaceMesh
        if (this.sdk) {
          try {
            this.sdk.destroy();
          } catch {
            // ignore
          }
          this.sdk = null;
        }
      }
    }

    if (!nativeStarted) {
      await this.startLocalWebcamFaceMesh();
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;

    if (this.sdk) {
      try {
        await this.sdk.stop();
        this.sdk.destroy();
      } catch {
        // ignore
      }
      this.sdk = null;
    }

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.faceMesh) {
      try {
        await this.faceMesh.close();
      } catch {
        // ignore
      }
      this.faceMesh = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.hiddenVideo) {
      this.hiddenVideo.pause();
      this.hiddenVideo.srcObject = null;
      if (this.hiddenVideo.parentNode) {
        this.hiddenVideo.parentNode.removeChild(this.hiddenVideo);
      }
      this.hiddenVideo = null;
    }
  }

  /**
   * Local 100% on-device MediaPipe 478-landmark FaceMesh extraction directly from the webcam.
   * Uses bundled local WASM assets in /mediapipe/face_mesh/ (0 network requests).
   */
  private async startLocalWebcamFaceMesh(): Promise<void> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Webcam mediaDevices API unavailable in this environment');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });

    this.mediaStream = stream;
    this.options.onStreamAvailable?.(stream);

    const videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', 'true');
    // Ensure video is in DOM so Safari WebKit does not throttle frame decoding
    videoEl.style.position = 'fixed';
    videoEl.style.top = '-9999px';
    videoEl.style.left = '-9999px';
    videoEl.style.width = '320px';
    videoEl.style.height = '240px';
    videoEl.style.opacity = '0';
    videoEl.style.pointerEvents = 'none';
    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(videoEl);
    }
    await videoEl.play().catch(() => {});
    this.hiddenVideo = videoEl;

    const FaceMeshCtor = (window as any).FaceMesh;
    if (!FaceMeshCtor) {
      throw new Error('Local MediaPipe FaceMesh script not loaded');
    }

    this.faceMesh = new FaceMeshCtor({
      locateFile: (file: string) => `/mediapipe/face_mesh/${file}`
    });

    this.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    this.startTimeMs = performance.now();

    this.faceMesh.onResults((results: any) => {
      if (!this.isRunning) return;

      const elapsedSec = (performance.now() - this.startTimeMs) / 1000;
      const multiLandmarks = results?.multiFaceLandmarks;

      if (multiLandmarks && multiLandmarks.length > 0) {
        this.consecutiveNoFaceCount = 0;
        const rawPts = multiLandmarks[0];
        const landmarks: Landmark3D[] = rawPts.map((pt: any) => ({
          x: pt.x ?? 0.5,
          y: pt.y ?? 0.5,
          z: pt.z ?? 0.0
        }));

        const ear = computeCompositeEAR(landmarks);
        const isBlink = ear !== null && ear < this.blinkThreshold;

        const frame: SignalFrame = {
          timestamp: elapsedSec,
          landmarks,
          blink: isBlink,
          confidence: 0.95
        };

        for (const cb of this.frameCallbacks) {
          cb(frame);
        }
      } else {
        // Ignore brief 1-2 frame MediaPipe flickers so Watching state stays rock-solid
        this.consecutiveNoFaceCount++;
        if (this.consecutiveNoFaceCount < 4) {
          return;
        }
        // Sustained no-face in frame
        const frame: SignalFrame = {
          timestamp: elapsedSec,
          landmarks: undefined,
          blink: false,
          confidence: 0.2
        };

        for (const cb of this.frameCallbacks) {
          cb(frame);
        }
      }
    });

    this.isRunning = true;

    const processLoop = async (nowMs: number) => {
      if (!this.isRunning || !this.hiddenVideo || !this.faceMesh) return;

      // Cap processing to ~20-25 FPS for responsive tracking and low laptop CPU load
      if (
        !this.isProcessingFrame &&
        nowMs - this.lastSendMs >= 40 &&
        this.hiddenVideo.readyState >= 2 &&
        this.hiddenVideo.videoWidth > 0
      ) {
        this.isProcessingFrame = true;
        this.lastSendMs = nowMs;
        try {
          await this.faceMesh.send({ image: this.hiddenVideo });
        } catch (err) {
          console.warn('[FaceMesh] send frame warning:', err);
        } finally {
          this.isProcessingFrame = false;
        }
      }

      if (this.isRunning) {
        this.rafId = requestAnimationFrame(processLoop);
      }
    };

    this.rafId = requestAnimationFrame(processLoop);
  }

  /**
   * Translates raw Presage metrics protobuf into internal SignalFrame.
   * Excludes expressions, drops insights, extracts 478 points, blink flags, and pulse rate.
   */
  private handleDecodedMetrics(decoded: any, timestampUs: number): void {
    const timestampSec = timestampUs / 1_000_000;

    let landmarks: Landmark3D[] | undefined;
    let blink: boolean | undefined;
    let pulseRate: number | undefined;

    if (decoded.face?.landmarks && decoded.face.landmarks.length > 0) {
      const rawLm = decoded.face.landmarks[0].value;
      if (rawLm && Array.isArray(rawLm)) {
        landmarks = rawLm.map((pt: any) => ({
          x: pt.x ?? 0.5,
          y: pt.y ?? 0.5,
          z: pt.z ?? 0.0
        }));
      }
    }

    if (decoded.face?.blinking && decoded.face.blinking.length > 0) {
      blink = Boolean(decoded.face.blinking[0].detected);
    }

    if (decoded.cardio?.pulseRate && decoded.cardio.pulseRate.length > 0) {
      const pulseEntry = decoded.cardio.pulseRate[0];
      if (pulseEntry.value !== undefined && pulseEntry.value !== null) {
        const val = typeof pulseEntry.value === 'number' ? pulseEntry.value : pulseEntry.value.value;
        if (typeof val === 'number' && val >= 40 && val <= 110) {
          pulseRate = Math.round(val);
        }
      }
    }

    const frame: SignalFrame = {
      timestamp: timestampSec,
      landmarks,
      blink,
      pulseRate,
      confidence: this.currentConfidence
    };

    for (const cb of this.frameCallbacks) {
      cb(frame);
    }
  }
}
