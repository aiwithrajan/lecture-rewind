import { CalibrationResult, EvidenceRuleId, HeadPose, SignalFrame } from '@shared/types';
import { computeCompositeEAR, computeRawHeadPose, computeRelativePose } from './LandmarkGeometry';

export interface EvaluatedEvidence {
  timestamp: number;
  pauseCandidates: EvidenceRuleId[]; // Rules A, B, C
  markers: Array<{ id: EvidenceRuleId; note?: string }>; // Rules D, E
  bookmarks: Array<{ id: EvidenceRuleId; note?: string }>; // Rule F
  ear: number | null;
  relativePose: HeadPose | null;
  closedDurationSec: number;
}

export class EvidenceEvaluator {
  private calibration: CalibrationResult;
  private notesMode: boolean = false;
  private headTurnedAwayEnabled: boolean = false; // Rule E disabled by default

  // Continuous tracking accumulators
  private closedDurationSec: number = 0;
  private headDownDurationSec: number = 0;
  private yawTurnedDurationSec: number = 0;
  private faceLostDurationSec: number = 0;
  private timeSinceLastClosureSec: number = 999;
  private lastClosureDurationRecorded: number = 0;

  // Closure pitch history to detect head drop transition
  private closurePitches: number[] = [];

  // Candidate firing debounce flags per closure epoch
  private candidateAFiredThisClosure: boolean = false;
  private candidateBFiredThisClosure: boolean = false;
  private candidateCFiredThisClosure: boolean = false;

  // Double blink detection for Evidence F
  private lastBlinkTimestamp: number = -1;
  private lastBookmarkEmittedTimestamp: number = -1;
  private previousBlinkState: boolean = false;

  // Frame timing
  private lastTimestamp: number = -1;

  constructor(calibration: CalibrationResult) {
    this.calibration = calibration;
  }

  public setNotesMode(enabled: boolean): void {
    this.notesMode = enabled;
  }

  public getNotesMode(): boolean {
    return this.notesMode;
  }

  public setHeadTurnedAwayEnabled(enabled: boolean): void {
    this.headTurnedAwayEnabled = enabled;
  }

  public updateCalibration(calibration: CalibrationResult): void {
    this.calibration = calibration;
  }

  public reset(): void {
    this.closedDurationSec = 0;
    this.headDownDurationSec = 0;
    this.yawTurnedDurationSec = 0;
    this.faceLostDurationSec = 0;
    this.timeSinceLastClosureSec = 999;
    this.lastClosureDurationRecorded = 0;
    this.closurePitches = [];
    this.candidateAFiredThisClosure = false;
    this.candidateBFiredThisClosure = false;
    this.candidateCFiredThisClosure = false;
    this.lastBlinkTimestamp = -1;
    this.previousBlinkState = false;
    this.lastTimestamp = -1;
  }

  /**
   * Evaluates incoming signal frame against Rules A-F
   */
  public evaluateFrame(frame: SignalFrame): EvaluatedEvidence {
    const timestamp = frame.timestamp;
    const deltaSec = this.lastTimestamp >= 0 ? Math.max(0, timestamp - this.lastTimestamp) : 0.033;
    this.lastTimestamp = timestamp;

    const pauseCandidates: EvidenceRuleId[] = [];
    const markers: Array<{ id: EvidenceRuleId; note?: string }> = [];
    const bookmarks: Array<{ id: EvidenceRuleId; note?: string }> = [];

    // Extract EAR and Pose
    const ear = computeCompositeEAR(frame.landmarks);
    const rawPose = computeRawHeadPose(frame.landmarks);
    const relativePose = rawPose
      ? computeRelativePose(rawPose, this.calibration.baselinePitch, this.calibration.baselineYaw)
      : null;

    const hasLandmarks = frame.landmarks !== undefined && frame.landmarks.length >= 468;
    const isConfidenceValid = frame.confidence >= (this.calibration.qualityThreshold * 0.7);

    // Evaluate Face Loss (Evidence C prerequisite)
    if (!hasLandmarks || !isConfidenceValid) {
      this.faceLostDurationSec += deltaSec;
      this.timeSinceLastClosureSec += deltaSec;

      // Evidence C: No landmarks for >= 3.0s beginning within 5.0s of closure (>=1.5s)
      if (
        !this.candidateCFiredThisClosure &&
        this.faceLostDurationSec >= 3.0 &&
        this.timeSinceLastClosureSec <= 5.0 &&
        this.lastClosureDurationRecorded >= 1.5
      ) {
        pauseCandidates.push('C');
        this.candidateCFiredThisClosure = true;
      }

      return {
        timestamp,
        pauseCandidates,
        markers,
        bookmarks,
        ear: null,
        relativePose: null,
        closedDurationSec: this.closedDurationSec
      };
    }

    // Face is visible: reset face lost tracker
    this.faceLostDurationSec = 0;

    // Check eyelid aperture against calibrated closure threshold
    const isClosed = ear !== null && ear < this.calibration.closureThreshold;

    if (isClosed) {
      this.closedDurationSec += deltaSec;
      this.timeSinceLastClosureSec = 0;
      this.lastClosureDurationRecorded = this.closedDurationSec;

      if (relativePose) {
        this.closurePitches.push(relativePose.pitch);
      }

      // Track Head Down duration
      if (relativePose && relativePose.pitch < -20) {
        this.headDownDurationSec += deltaSec;
      } else {
        this.headDownDurationSec = 0;
      }

      // Check Evidence A: Prolonged Eye Closure (Section 5.2)
      // T_closure calibrated default 6.0s (scaled by userSensitivity between 5.0 and 10.0s)
      const tClosure = this.calibration.userSensitivity ?? 6.0;

      if (!this.candidateAFiredThisClosure && this.closedDurationSec >= tClosure) {
        const avgPitch = this.closurePitches.length > 0
          ? this.closurePitches.reduce((a, b) => a + b, 0) / this.closurePitches.length
          : 0;

        const isUpright = Math.abs(avgPitch) <= 12;
        const isNotesRelaxed = this.notesMode && avgPitch <= 35 && avgPitch >= -35;
        const transitionedToHeadDrop = this.headDownDurationSec >= 2.0;

        if (isUpright || isNotesRelaxed || transitionedToHeadDrop) {
          pauseCandidates.push('A');
          this.candidateAFiredThisClosure = true;
        }
      }

      // Check Evidence B: Head Down with Eyes Closed (Section 5.2)
      // Disabled in Notes Mode
      if (!this.notesMode && !this.candidateBFiredThisClosure) {
        const requiredHeadDownDuration = this.candidateAFiredThisClosure ? 3.0 : 5.0;
        if (this.closedDurationSec >= 5.0 && this.headDownDurationSec >= requiredHeadDownDuration) {
          pauseCandidates.push('B');
          this.candidateBFiredThisClosure = true;
        }
      }
    } else {
      // Eyes are open: check if a brief closure just ended (Evidence D)
      if (
        !this.candidateAFiredThisClosure &&
        !this.candidateBFiredThisClosure &&
        this.closedDurationSec >= 2.0 &&
        this.closedDurationSec < (this.calibration.userSensitivity ?? 6.0)
      ) {
        markers.push({
          id: 'D',
          note: `Brief closure (${this.closedDurationSec.toFixed(1)}s)`
        });
      }

      // Reset closure epoch
      this.closedDurationSec = 0;
      this.headDownDurationSec = 0;
      this.closurePitches = [];
      this.candidateAFiredThisClosure = false;
      this.candidateBFiredThisClosure = false;
      this.candidateCFiredThisClosure = false;
    }

    // Evidence E: Head Turned Away (Yaw > 35 degrees for >= 8.0s)
    if (this.headTurnedAwayEnabled && relativePose && Math.abs(relativePose.yaw) > 35) {
      this.yawTurnedDurationSec += deltaSec;
      if (this.yawTurnedDurationSec >= 8.0) {
        markers.push({
          id: 'E',
          note: `Gaze turned away (${this.yawTurnedDurationSec.toFixed(1)}s)`
        });
        this.yawTurnedDurationSec = 0; // debounce marker
      }
    } else {
      this.yawTurnedDurationSec = 0;
    }

    // Evidence F: Double blink manual gesture detection (intentional double blink within 180ms - 800ms)
    const currentBlink = Boolean(frame.blink);
    if (currentBlink && !this.previousBlinkState) {
      // Rising edge of a blink
      const dt = this.lastBlinkTimestamp >= 0 ? timestamp - this.lastBlinkTimestamp : -1;
      const cooldownPassed = this.lastBookmarkEmittedTimestamp < 0 || (timestamp - this.lastBookmarkEmittedTimestamp) >= 3.5;

      if (cooldownPassed && dt >= 0.18 && dt <= 0.8) {
        bookmarks.push({
          id: 'F',
          note: 'Double-blink gesture bookmark'
        });
        this.lastBookmarkEmittedTimestamp = timestamp;
        this.lastBlinkTimestamp = -1; // reset
      } else {
        this.lastBlinkTimestamp = timestamp;
      }
    } else if (this.lastBlinkTimestamp >= 0 && (timestamp - this.lastBlinkTimestamp) > 0.8) {
      this.lastBlinkTimestamp = -1;
    }
    this.previousBlinkState = currentBlink;

    return {
      timestamp,
      pauseCandidates,
      markers,
      bookmarks,
      ear,
      relativePose,
      closedDurationSec: this.closedDurationSec
    };
  }

  /**
   * Manual bookmark triggered via keyboard (B key) per Section 5.2
   */
  public triggerManualKeyBookmark(timestamp: number): EvaluatedEvidence {
    return {
      timestamp,
      pauseCandidates: [],
      markers: [],
      bookmarks: [{ id: 'F', note: 'Keyboard manual bookmark (B key)' }],
      ear: null,
      relativePose: null,
      closedDurationSec: this.closedDurationSec
    };
  }
}
