import { AbsenceState, DetectionEvent, EvidenceRuleId, SignalFrame } from '@shared/types';
import { EvaluatedEvidence } from './EvidenceEvaluator';

export interface StateMachineCallbacks {
  onStateChange?: (newState: AbsenceState, previousState: AbsenceState) => void;
  onPauseRequested?: (event: DetectionEvent) => void;
  onMarkerEmitted?: (event: DetectionEvent) => void;
  onBookmarkEmitted?: (event: DetectionEvent) => void;
  onReturnDetected?: () => void;
}

export class AbsenceStateMachine {
  private state: AbsenceState = 'Watching';
  private guardEnabled: boolean = true;
  private callbacks: StateMachineCallbacks = {};

  // 12-second rolling corroboration window tracking
  private activeCandidates: Array<{ ruleId: EvidenceRuleId; timestamp: number }> = [];
  private suspectStartedTimestamp: number = -1;

  // Return detection in Waiting state
  private returnUprightDurationSec: number = 0;

  // Degraded state tracking (must recover for >= 5s)
  private degradedRecoveryDurationSec: number = 0;

  private lastTimestamp: number = -1;

  constructor(callbacks: StateMachineCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public getState(): AbsenceState {
    return this.state;
  }

  public setGuardEnabled(enabled: boolean): void {
    this.guardEnabled = enabled;
  }

  public isGuardEnabled(): boolean {
    return this.guardEnabled;
  }

  public setCallbacks(callbacks: StateMachineCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public reset(): void {
    this.transitionTo('Watching');
    this.activeCandidates = [];
    this.suspectStartedTimestamp = -1;
    this.returnUprightDurationSec = 0;
    this.degradedRecoveryDurationSec = 0;
    this.lastTimestamp = -1;
  }

  /**
   * Main step handler: processes evaluated evidence and raw signal frame.
   */
  public processFrame(evidence: EvaluatedEvidence, frame: SignalFrame): void {
    const timestamp = frame.timestamp;
    const deltaSec = this.lastTimestamp >= 0 ? Math.max(0, timestamp - this.lastTimestamp) : 0.033;
    this.lastTimestamp = timestamp;

    // Handle Bookmarks (Evidence F) immediately
    for (const b of evidence.bookmarks) {
      const bookmarkEvent: DetectionEvent = {
        id: `bookmark-${timestamp.toFixed(2)}`,
        type: 'bookmark',
        start: timestamp,
        end: timestamp,
        evidence: [b.id],
        confidence: frame.confidence,
        note: b.note
      };
      this.callbacks.onBookmarkEmitted?.(bookmarkEvent);
    }

    // Handle Markers (Evidence D, E) immediately
    for (const m of evidence.markers) {
      const markerEvent: DetectionEvent = {
        id: `marker-${timestamp.toFixed(2)}`,
        type: 'marker',
        start: Math.max(0, timestamp - (evidence.closedDurationSec || 2.0)),
        end: timestamp,
        evidence: [m.id],
        confidence: frame.confidence,
        note: m.note
      };
      this.callbacks.onMarkerEmitted?.(markerEvent);
    }

    // Quality check for Degraded state
    const isQualityDegraded = frame.confidence < 0.5;

    if (this.state === 'Degraded') {
      if (!isQualityDegraded) {
        this.degradedRecoveryDurationSec += deltaSec;
        if (this.degradedRecoveryDurationSec >= 5.0) {
          this.transitionTo('Watching');
          this.degradedRecoveryDurationSec = 0;
        }
      } else {
        this.degradedRecoveryDurationSec = 0;
      }
      return;
    } else if (isQualityDegraded && this.state === 'Watching') {
      this.transitionTo('Degraded');
      this.degradedRecoveryDurationSec = 0;
      return;
    }

    // Process Return Detection in Waiting state
    if (this.state === 'Waiting') {
      const hasEyesOpen = evidence.ear !== null && evidence.ear >= 0.18;
      const isUpright = evidence.relativePose !== null && Math.abs(evidence.relativePose.pitch) <= 20;

      if (hasEyesOpen && isUpright) {
        this.returnUprightDurationSec += deltaSec;
        if (this.returnUprightDurationSec >= 3.0) {
          this.transitionTo('Returned');
          this.callbacks.onReturnDetected?.();
          this.returnUprightDurationSec = 0;
        }
      } else {
        this.returnUprightDurationSec = 0;
      }
      return;
    }

    if (this.state === 'Returned') {
      // In Returned state, waiting for explicit user confirmation via confirmResume() or break
      return;
    }

    // Add new pause candidates to rolling window
    for (const ruleId of evidence.pauseCandidates) {
      this.activeCandidates.push({ ruleId, timestamp });
    }

    // Prune candidates older than 12 seconds
    this.activeCandidates = this.activeCandidates.filter(
      (c) => (timestamp - c.timestamp) <= 12.0
    );

    // If Guard is disabled by user, downgrade any candidates to markers
    if (!this.guardEnabled) {
      if (this.activeCandidates.length > 0) {
        for (const c of this.activeCandidates) {
          this.callbacks.onMarkerEmitted?.({
            id: `marker-unguarded-${c.timestamp.toFixed(2)}`,
            type: 'marker',
            start: c.timestamp,
            end: timestamp,
            evidence: [c.ruleId],
            confidence: frame.confidence,
            note: 'Absence guard suspended; recorded as marker'
          });
        }
        this.activeCandidates = [];
      }
      if (this.state === 'Suspect') {
        this.transitionTo('Watching');
      }
      return;
    }

    // Check unique evidence rules in active candidates
    const uniqueRules = Array.from(new Set(this.activeCandidates.map((c) => c.ruleId)));

    if (uniqueRules.length >= 2) {
      // 2-of-3 Corroboration satisfied! Transition Suspect/Watching -> Absent -> Waiting
      const earliestTimestamp = Math.min(...this.activeCandidates.map((c) => c.timestamp));
      const pauseEvent: DetectionEvent = {
        id: `pause-${earliestTimestamp.toFixed(2)}`,
        type: 'pause',
        start: earliestTimestamp,
        end: timestamp,
        evidence: uniqueRules,
        confidence: frame.confidence,
        note: `2-of-3 corroboration satisfied (${uniqueRules.join(' + ')})`
      };

      this.activeCandidates = [];
      this.suspectStartedTimestamp = -1;
      this.transitionTo('Absent');
      this.callbacks.onPauseRequested?.(pauseEvent);
      this.transitionTo('Waiting');
    } else if (uniqueRules.length === 1) {
      // One candidate active -> Suspect state
      if (this.state === 'Watching') {
        this.suspectStartedTimestamp = this.activeCandidates[0].timestamp;
        this.transitionTo('Suspect');
      }
    } else {
      // 0 candidates active
      if (this.state === 'Suspect') {
        // Window expired without 2nd corroborating candidate -> Downgrade to marker
        if (this.suspectStartedTimestamp >= 0) {
          this.callbacks.onMarkerEmitted?.({
            id: `marker-uncorroborated-${this.suspectStartedTimestamp.toFixed(2)}`,
            type: 'marker',
            start: this.suspectStartedTimestamp,
            end: timestamp,
            evidence: ['A'],
            confidence: frame.confidence,
            note: 'Uncorroborated single candidate downgraded to marker'
          });
        }
        this.suspectStartedTimestamp = -1;
        this.transitionTo('Watching');
      }
    }
  }

  /**
   * Called when user confirms resumption (e.g. Space bar or double blink)
   */
  public confirmResume(): void {
    if (this.state === 'Returned' || this.state === 'Waiting') {
      this.activeCandidates = [];
      this.returnUprightDurationSec = 0;
      this.transitionTo('Watching');
    }
  }

  private transitionTo(newState: AbsenceState): void {
    if (this.state !== newState) {
      const prev = this.state;
      this.state = newState;
      this.callbacks.onStateChange?.(newState, prev);
    }
  }
}
