/**
 * Lecture Rewind - Core Data Contracts
 * Strictly adheres to PRD Section 10 & Compliance Boundaries (Section 12).
 * Measures presence, never comprehension.
 */

// 1. MediaPipe Canonical 3D Landmark Point
export interface Landmark3D {
  x: number;
  y: number;
  z: number;
}

// 2. Abstract Signal Frame emitted by Live SDK or Simulated Replay
export interface SignalFrame {
  timestamp: number; // Video playback time in seconds
  landmarks?: Landmark3D[]; // 478 MediaPipe 3D points
  blink?: boolean; // Binary blink flag (cross-check / gesture only)
  pulseRate?: number; // 12-second average pulse in BPM (informational context only)
  confidence: number; // Signal confidence [0, 1]
}

// 3. Pose angles relative to calibrated neutral hold
export interface HeadPose {
  pitch: number; // In degrees (- is down, + is up)
  yaw: number; // In degrees (- is left, + is right)
}

// 4. Evidence identifiers for detection rules (PRD Section 8.2)
export type EvidenceRuleId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

// 5. Types of detected events
export type DetectionEventType = 'pause' | 'marker' | 'bookmark';

// 6. Detection Event record (PRD Section 10)
export interface DetectionEvent {
  id: string;
  type: DetectionEventType;
  start: number; // Seconds into video
  end: number; // Seconds into video
  evidence: EvidenceRuleId[];
  confidence: number; // [0, 1]
  note?: string;
}

// 7. Quality Bucket for Quality Ribbon (PRD Section 10 & FR-10)
export interface QualityBucket {
  timestamp: number; // Start timestamp in seconds
  duration: number; // Duration of bucket in seconds
  confidence: number; // Average confidence in this window [0, 1]
  isDegraded: boolean;
}

// 8. Self-Test Calibration Result (PRD Section 8.4 & 10)
export interface SignalReliabilityVerdict {
  reliable: boolean;
  score: number; // 0 to 1
  reason?: string;
}

export interface CalibrationResult {
  completedAt: string; // ISO timestamp
  baselineEar: number; // Measured neutral Eye Aspect Ratio
  closureThreshold: number; // Calibrated EAR closure threshold
  detectionLatencyMs: number; // Latency between prompted closure and measured closure
  baselinePitch: number; // Neutral head pitch in degrees
  baselineYaw: number; // Neutral head yaw in degrees
  qualityThreshold: number; // Landmark stability at rest
  userSensitivity: number; // Closure duration slider [5.0, 10.0] seconds, default 6.0
  verdicts: {
    ear: SignalReliabilityVerdict;
    pose: SignalReliabilityVerdict;
    overall: 'reliable' | 'degraded' | 'unreliable';
  };
}

// 9. Chapter metadata (PRD FR-8)
export interface ChapterInfo {
  title: string;
  start: number; // Seconds
  end: number; // Seconds
}

// 10. Rewind Queue Interval (PRD Section 8.5 & 10)
export interface QueueInterval {
  id: string;
  start: number; // Start seconds (with 10s pre-roll and snapping)
  end: number; // End seconds (with snapping)
  duration: number; // (end - start) in seconds
  chapterTitle?: string;
  sourceEventIds: string[];
}

// 11. Pulse series record (PRD Section 10 & FR-15)
export interface PulsePoint {
  timestamp: number; // Video playback time in seconds
  value: number; // Heart rate (40 to 110 BPM)
  confidence: number;
}

// 12. Video source descriptor
export interface VideoSource {
  type: 'local' | 'url';
  pathOrUrl: string;
  duration: number; // In seconds
  name: string;
  chapters?: ChapterInfo[];
}

// 13. State Machine States (PRD Section 8.6)
export type AbsenceState =
  | 'Watching'
  | 'Suspect'
  | 'Absent'
  | 'Waiting'
  | 'Returned'
  | 'Degraded';

// 13b. Session Telemetry Metrics captured during playback for Review & Agent analysis
export interface StateSegment {
  state: AbsenceState;
  startSec: number; // Session wall-clock seconds
  endSec: number;
  videoTimeSec: number; // Lecture video timestamp when segment started
}

export interface SessionMetrics {
  watchingDurationSec: number;
  absentDurationSec: number;
  degradedDurationSec: number;
  totalBlinks: number;
  furthestVideoTimeSec: number;
  stateTimeline: StateSegment[];
}

// 14. Session Document (PRD Section 10 Schema)
export interface SessionDocument {
  version: 1; // Integer schema version for forward compatibility
  id: string; // Unique session identifier
  source: VideoSource;
  startedAt: string; // ISO timestamp
  endedAt?: string; // ISO timestamp
  calibration: CalibrationResult;
  events: DetectionEvent[];
  quality: QualityBucket[];
  queue: QueueInterval[];
  pulse: PulsePoint[];
  metrics?: SessionMetrics;
  incomplete?: boolean; // Flag if application closed mid-session
}

// 17. Hybrid Session Review Agent Contracts (Gemini + Local Open-Source Ollama Failover)
export type AgentEngineMode = 'auto' | 'gemini' | 'ollama' | 'offline';
export type AgentLanguage = 'hinglish' | 'english';

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentStatus {
  geminiConfigured: boolean;
  ollamaAvailable: boolean;
  ollamaModels: string[];
  defaultOllamaModel: string;
}

export interface AgentRequest {
  session: SessionDocument;
  question?: string;
  history?: AgentChatMessage[];
  engine?: AgentEngineMode;
  ollamaModel?: string;
  language?: AgentLanguage;
}

export interface AgentResponse {
  answer: string;
  providerUsed: 'gemini' | 'ollama' | 'offline';
  modelUsed: string;
  failoverReason?: string;
  transcriptContext?: {
    videoTitle?: string;
    captionsAvailable: boolean;
    matchedExcerptsCount: number;
  };
}

// 15. Consent Record (PRD FR-3 & Section 11)
export interface ConsentRecord {
  granted: boolean;
  timestamp: string; // ISO timestamp
  telemetryEnabled: boolean; // default false (FR-18)
}

// 16. Outbound Network Firewall Stats (Acceptance Criterion 8)
export interface NetworkGuardStats {
  blockedRequestsCount: number;
  allowedRequestsCount: number;
  applicationNetworkRequestsCount: number; // MUST be 0
  log: Array<{
    timestamp: string;
    url: string;
    action: 'allowed' | 'blocked';
    reason: string;
  }>;
}
