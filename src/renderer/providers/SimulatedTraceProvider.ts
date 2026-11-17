import { Landmark3D, SignalFrame } from '@shared/types';
import { SignalProvider, FrameCallback, ErrorCallback } from './SignalProvider';
import stagedTraceJson from '../../../tests/fixtures/staged-session-trace.json';

export type SimulationModeOverride = 'normal' | 'blink' | 'brief_lapse' | 'absence' | 'head_down' | 'face_lost';

export class SimulatedTraceProvider implements SignalProvider {
  private frames: SignalFrame[] = [];
  private frameCallbacks: FrameCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private isRunning: boolean = false;
  private timerId: NodeJS.Timeout | null = null;
  private currentIndex: number = 0;
  private playbackRate: number = 1.0;

  // Real-time dynamic simulation generator
  private liveClockSec: number = 0;
  private overrideMode: SimulationModeOverride = 'normal';
  private overrideDurationSec: number = 0;
  private overrideElapsedSec: number = 0;
  private nextNaturalBlinkAtSec: number = 4.0;

  constructor(initialFrames: SignalFrame[] = []) {
    this.frames = initialFrames;
  }

  public setFrames(frames: SignalFrame[]): void {
    this.frames = frames;
    this.currentIndex = 0;
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.1, rate);
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

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    if (this.frames.length > 0) {
      this.scheduleNextRecordedFrame();
    } else {
      this.startDynamicGenerator();
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  public reset(): void {
    this.stop();
    this.currentIndex = 0;
    this.liveClockSec = 0;
    this.overrideMode = 'normal';
    this.overrideDurationSec = 0;
    this.overrideElapsedSec = 0;
  }

  public emitFrame(frame: SignalFrame): void {
    for (const cb of this.frameCallbacks) {
      cb(frame);
    }
  }

  public feedFrames(frames: SignalFrame[]): void {
    for (const frame of frames) {
      this.emitFrame(frame);
    }
  }

  /**
   * Interactive simulation triggers for instant real-time detection testing
   */
  public triggerBlink(): void {
    this.overrideMode = 'blink';
    this.overrideDurationSec = 0.2;
    this.overrideElapsedSec = 0;
  }

  public triggerBriefLapse(durationSec = 3.5): void {
    this.overrideMode = 'brief_lapse';
    this.overrideDurationSec = durationSec;
    this.overrideElapsedSec = 0;
  }

  public triggerProlongedAbsence(durationSec = 6.5): void {
    this.overrideMode = 'absence';
    this.overrideDurationSec = durationSec;
    this.overrideElapsedSec = 0;
  }

  public triggerHeadDrop(durationSec = 5.0): void {
    this.overrideMode = 'head_down';
    this.overrideDurationSec = durationSec;
    this.overrideElapsedSec = 0;
  }

  public triggerFaceLost(durationSec = 4.0): void {
    this.overrideMode = 'face_lost';
    this.overrideDurationSec = durationSec;
    this.overrideElapsedSec = 0;
  }

  public restoreNormal(): void {
    this.overrideMode = 'normal';
    this.overrideDurationSec = 0;
    this.overrideElapsedSec = 0;
  }

  /**
   * Replay pre-recorded static fixture frames (for Vitest tests)
   */
  private scheduleNextRecordedFrame(): void {
    if (!this.isRunning || this.currentIndex >= this.frames.length) {
      this.isRunning = false;
      return;
    }

    const currentFrame = this.frames[this.currentIndex];
    this.emitFrame(currentFrame);
    this.currentIndex++;

    if (this.currentIndex < this.frames.length) {
      const nextFrame = this.frames[this.currentIndex];
      const deltaSec = Math.max(0.01, nextFrame.timestamp - currentFrame.timestamp);
      const delayMs = (deltaSec * 1000) / this.playbackRate;

      this.timerId = setTimeout(() => {
        this.scheduleNextRecordedFrame();
      }, delayMs);
    } else {
      this.isRunning = false;
    }
  }

  /**
   * Continuous dynamic 20 FPS live simulation stream (for runtime development & demo)
   */
  private startDynamicGenerator(): void {
    const frameIntervalMs = 50; // 20 FPS
    const deltaSec = 0.05;

    const tick = () => {
      if (!this.isRunning) return;

      this.liveClockSec += deltaSec;

      let isBlink = false;
      let isClosed = false;
      let isHeadDown = false;
      let isFaceLost = false;

      // Handle override states
      if (this.overrideMode !== 'normal') {
        this.overrideElapsedSec += deltaSec;

        if (this.overrideMode === 'blink') {
          isBlink = true;
          isClosed = true;
        } else if (this.overrideMode === 'brief_lapse') {
          isClosed = true;
        } else if (this.overrideMode === 'absence') {
          isClosed = true;
          // After 2s of closure, head drops slightly to satisfy 2-of-3 corroboration (Rule A + B)
          if (this.overrideElapsedSec >= 2.0) {
            isHeadDown = true;
          }
        } else if (this.overrideMode === 'head_down') {
          isClosed = true;
          isHeadDown = true;
        } else if (this.overrideMode === 'face_lost') {
          isFaceLost = true;
        }

        if (this.overrideElapsedSec >= this.overrideDurationSec) {
          this.overrideMode = 'normal';
          this.overrideDurationSec = 0;
          this.overrideElapsedSec = 0;
        }
      } else {
        // Natural blink cycle (occurs every ~4.5 seconds for ~0.15s)
        if (this.liveClockSec >= this.nextNaturalBlinkAtSec) {
          isBlink = true;
          isClosed = true;
          if (this.liveClockSec >= this.nextNaturalBlinkAtSec + 0.15) {
            this.nextNaturalBlinkAtSec = this.liveClockSec + 3.5 + Math.random() * 2.0;
          }
        }
      }

      // Select landmark template
      let template: Landmark3D[];
      if (isFaceLost) {
        template = [];
      } else if (isHeadDown && isClosed) {
        template = stagedTraceJson.templates.closedHeadDown as Landmark3D[];
      } else if (isClosed) {
        template = stagedTraceJson.templates.closedUpright as Landmark3D[];
      } else {
        template = stagedTraceJson.templates.openUpright as Landmark3D[];
      }

      // Add subtle micro-jitter to landmarks to make live HUD look organic and authentic
      let activeLandmarks: Landmark3D[] | undefined;
      if (template.length > 0) {
        const jitter = (Math.sin(this.liveClockSec * 3) * 0.001) + ((Math.random() - 0.5) * 0.0008);
        activeLandmarks = template.map((pt, idx) => {
          // Add subtle motion to eye landmarks
          if ((idx >= 33 && idx <= 160) || (idx >= 263 && idx <= 387)) {
            return { x: pt.x + jitter, y: pt.y + jitter * 0.5, z: pt.z ?? 0 };
          }
          return pt;
        });
      }

      // Dynamic pulse wave
      const pulseRate = isFaceLost ? undefined : Math.round(72 + Math.sin(this.liveClockSec * 0.8) * 4);

      const frame: SignalFrame = {
        timestamp: this.liveClockSec,
        landmarks: activeLandmarks,
        blink: isBlink,
        pulseRate,
        confidence: isFaceLost ? 0.2 : 0.95
      };

      this.emitFrame(frame);

      this.timerId = setTimeout(tick, frameIntervalMs / this.playbackRate);
    };

    this.timerId = setTimeout(tick, frameIntervalMs);
  }
}
