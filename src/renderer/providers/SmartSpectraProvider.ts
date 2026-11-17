import { SmartSpectraSDK } from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { Landmark3D, SignalFrame } from '@shared/types';
import { SignalProvider, FrameCallback, ErrorCallback } from './SignalProvider';

export interface SmartSpectraProviderOptions {
  apiKey?: string;
  telemetryEnabled?: boolean;
  onStreamAvailable?: (stream: MediaStream) => void;
}

/**
 * SmartSpectraProvider wraps the Presage SmartSpectra SDK in the renderer process.
 * Strictly adheres to PRD Section 8.1 (Selective subscription), Section 11.5 (No LLM insights),
 * and FR-18 (Telemetry disabled by default).
 */
export class SmartSpectraProvider implements SignalProvider {
  private sdk: SmartSpectraSDK | null = null;
  private isRunning: boolean = false;
  private frameCallbacks: FrameCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private options: SmartSpectraProviderOptions;

  // Frame rate monitoring (Section 15: >= 15 FPS)
  private lastFrameTimeMs: number = 0;
  private currentConfidence: number = 1.0;

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

  public onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      this.sdk = new SmartSpectraSDK({
        apiKey: this.options.apiKey,
        sendTimeoutMs: 15000
      });

      // Stream preview hook
      this.sdk.on('streamAvailable', (stream: MediaStream) => {
        this.options.onStreamAvailable?.(stream);
      });

      // Validation status updates signal confidence
      this.sdk.on('validationStatus', (code: number) => {
        // Validation code 0 is valid / optimal
        this.currentConfidence = code === 0 ? 0.95 : 0.40;
      });

      // Incoming metrics buffer from MessagePort
      this.sdk.on('metrics', (buf: Uint8Array, timestampUs: number) => {
        try {
          const decoded = decodeMetrics(buf);
          this.handleDecodedMetrics(decoded, timestampUs);
        } catch {
          // Ignore decoding errors on corrupt frames
        }
      });

      // Banned by PRD Section 11.5: LLM insights are dropped immediately
      this.sdk.on('insight', () => {
        // Discard any insight payload per Section 11.5
      });

      this.sdk.on('error', (_code: number, message: string) => {
        const err = new Error(`SmartSpectra SDK Error: ${message}`);
        for (const cb of this.errorCallbacks) {
          cb(err);
        }
      });

      await this.sdk.start();
      this.isRunning = true;
    } catch (err) {
      this.isRunning = false;
      const error = err instanceof Error ? err : new Error(String(err));
      for (const cb of this.errorCallbacks) {
        cb(error);
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || !this.sdk) return;

    try {
      await this.sdk.stop();
      this.sdk.destroy();
    } finally {
      this.sdk = null;
      this.isRunning = false;
    }
  }

  /**
   * Translates raw Presage metrics protobuf into internal SignalFrame
   * Excludes expressions, drops insights, extracts 478 points, blink flags, and pulse rate
   */
  private handleDecodedMetrics(decoded: any, timestampUs: number): void {
    const timestampSec = timestampUs / 1_000_000;
    const nowMs = performance.now();
    this.lastFrameTimeMs = nowMs;

    let landmarks: Landmark3D[] | undefined;
    let blink: boolean | undefined;
    let pulseRate: number | undefined;

    // Extract landmarks from face metrics
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

    // Extract blink flag (cross-check / gesture only per Section 8.1)
    if (decoded.face?.blinking && decoded.face.blinking.length > 0) {
      blink = Boolean(decoded.face.blinking[0].detected);
    }

    // Extract 12s pulse rate context (Section 8.1 & FR-15)
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
