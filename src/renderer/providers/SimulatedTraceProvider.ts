import { SignalFrame } from '@shared/types';
import { SignalProvider, FrameCallback, ErrorCallback } from './SignalProvider';

export class SimulatedTraceProvider implements SignalProvider {
  private frames: SignalFrame[] = [];
  private frameCallbacks: FrameCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private isRunning: boolean = false;
  private timerId: NodeJS.Timeout | null = null;
  private currentIndex: number = 0;
  private playbackRate: number = 1.0;

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

  public onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextFrame();
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
  }

  /**
   * Synchronously step or emit a specific frame.
   * Crucial for high-speed Vitest unit testing without timer delays.
   */
  public emitFrame(frame: SignalFrame): void {
    for (const cb of this.frameCallbacks) {
      cb(frame);
    }
  }

  /**
   * Feed an array of frames sequentially to all registered subscribers.
   */
  public feedFrames(frames: SignalFrame[]): void {
    for (const frame of frames) {
      this.emitFrame(frame);
    }
  }

  private scheduleNextFrame(): void {
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
        this.scheduleNextFrame();
      }, delayMs);
    } else {
      this.isRunning = false;
    }
  }
}
