import { SignalFrame } from '@shared/types';

export type FrameCallback = (frame: SignalFrame) => void;
export type ErrorCallback = (err: Error) => void;

/**
 * Common contract implemented by both Live SmartSpectra SDK and SimulatedTraceProvider
 */
export interface SignalProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(callback: FrameCallback): void;
  onError(callback: ErrorCallback): void;
  getIsRunning(): boolean;
}
