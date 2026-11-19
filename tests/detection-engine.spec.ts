import { describe, it, expect, beforeEach } from 'vitest';
import { Landmark3D, SignalFrame, DetectionEvent, AbsenceState } from '../src/shared/types';
import { LandmarkGeometry, computeCompositeEAR, computeRawHeadPose } from '../src/renderer/engine/LandmarkGeometry';
import { SelfTestCalibrator } from '../src/renderer/engine/SelfTestCalibrator';
import { EvidenceEvaluator } from '../src/renderer/engine/EvidenceEvaluator';
import { AbsenceStateMachine } from '../src/renderer/engine/AbsenceStateMachine';
import stagedTraceJson from './fixtures/staged-session-trace.json';

describe('LandmarkGeometry & Feature Extraction', () => {
  it('correctly calculates continuous EAR from 478 MediaPipe landmarks', () => {
    const openLandmarks = stagedTraceJson.templates.openUpright as Landmark3D[];
    const closedLandmarks = stagedTraceJson.templates.closedUpright as Landmark3D[];

    const openEar = computeCompositeEAR(openLandmarks);
    const closedEar = computeCompositeEAR(closedLandmarks);

    expect(openEar).not.toBeNull();
    expect(closedEar).not.toBeNull();
    expect(openEar!).toBeGreaterThan(0.25);
    expect(closedEar!).toBeLessThan(0.12);
  });

  it('correctly calculates head pitch and yaw angles in degrees', () => {
    const upright = stagedTraceJson.templates.openUpright as Landmark3D[];
    const headDown = stagedTraceJson.templates.closedHeadDown as Landmark3D[];

    const poseUpright = computeRawHeadPose(upright);
    const poseHeadDown = computeRawHeadPose(headDown);

    expect(poseUpright).not.toBeNull();
    expect(poseHeadDown).not.toBeNull();
    expect(Math.abs(poseUpright!.pitch)).toBeLessThan(5);
    expect(poseHeadDown!.pitch).toBeLessThan(-20);
  });
});

describe('SelfTestCalibrator (Acceptance Criterion 9)', () => {
  it('calibrates thresholds from neutral hold and prompted closures', () => {
    const openFrame: SignalFrame = {
      timestamp: 1.0,
      landmarks: stagedTraceJson.templates.openUpright as Landmark3D[],
      confidence: 0.9
    };
    const closedFrame: SignalFrame = {
      timestamp: 4.0,
      landmarks: stagedTraceJson.templates.closedUpright as Landmark3D[],
      confidence: 0.9
    };

    const result = SelfTestCalibrator.calibrate({
      neutralFrames: Array(10).fill(openFrame),
      closureFrames: Array(5).fill(closedFrame),
      latencyMeasurementsMs: [190, 200, 210]
    });

    expect(result.baselineEar).toBeGreaterThan(0.25);
    expect(result.closureThreshold).toBeLessThan(result.baselineEar);
    expect(result.closureThreshold).toBeGreaterThan(0.10);
    expect(result.verdicts.ear.reliable).toBe(true);
    expect(result.verdicts.pose.reliable).toBe(true);
    expect(result.verdicts.overall).toBe('reliable');
  });

  it('refuses to overstate reliability when eye aperture is degraded (Acceptance Criterion 9)', () => {
    // Degraded open eye aperture
    const degradedFrame: SignalFrame = {
      timestamp: 1.0,
      landmarks: stagedTraceJson.templates.closedUpright as Landmark3D[], // looks closed even during open prompt
      confidence: 0.4
    };

    const result = SelfTestCalibrator.calibrate({
      neutralFrames: Array(10).fill(degradedFrame),
      closureFrames: Array(5).fill(degradedFrame)
    });

    expect(result.verdicts.ear.reliable).toBe(false);
    expect(result.verdicts.overall).not.toBe('reliable');
  });
});

describe('Detection Engine & Acceptance Criteria 1, 2, 3', () => {
  let calibration = SelfTestCalibrator.getDefaultCalibration();
  let evaluator: EvidenceEvaluator;
  let stateMachine: AbsenceStateMachine;
  let pauseEvents: DetectionEvent[] = [];
  let markerEvents: DetectionEvent[] = [];

  beforeEach(() => {
    calibration = SelfTestCalibrator.getDefaultCalibration(6.0); // 6s threshold
    evaluator = new EvidenceEvaluator(calibration);
    pauseEvents = [];
    markerEvents = [];

    stateMachine = new AbsenceStateMachine({
      onPauseRequested: (ev) => pauseEvents.push(ev),
      onMarkerEmitted: (ev) => markerEvents.push(ev)
    });
  });

  it('Acceptance Criterion 1: Absence guard pauses in 5 of 5 staged absences', () => {
    const stagedAbsences = stagedTraceJson.groundTruth.stagedAbsences;

    stagedAbsences.forEach((abs, index) => {
      evaluator.reset();
      stateMachine.reset();
      const currentPauses: DetectionEvent[] = [];
      stateMachine.setCallbacks({
        onPauseRequested: (ev) => currentPauses.push(ev)
      });

      // Staged absence: 6 seconds prolonged closure + head down (Rules A + B)
      for (let sec = 0; sec <= 7.0; sec += 0.1) {
        const ts = abs.start + sec;
        // Head drops after 2 seconds of closure
        const template = sec >= 2.0
          ? stagedTraceJson.templates.closedHeadDown
          : stagedTraceJson.templates.closedUpright;

        const frame: SignalFrame = {
          timestamp: ts,
          landmarks: template as Landmark3D[],
          confidence: 0.9
        };

        const evidence = evaluator.evaluateFrame(frame);
        stateMachine.processFrame(evidence, frame);
      }

      expect(currentPauses.length).toBeGreaterThanOrEqual(1);
      expect(currentPauses[0].type).toBe('pause');
      expect(currentPauses[0].evidence).toContain('A');
      expect(currentPauses[0].evidence).toContain('B');
    });
  });

  it('Acceptance Criterion 1 (part 2): Produces 0 pauses during 10 minutes of normal viewing with ordinary blinking', () => {
    evaluator.reset();
    stateMachine.reset();

    let pauseCount = 0;
    stateMachine.setCallbacks({
      onPauseRequested: () => pauseCount++
    });

    const totalSeconds = 600; // 10 minutes
    const stepSec = 0.2; // 5 Hz simulation for speed

    for (let t = 0; t < totalSeconds; t += stepSec) {
      // Natural blink occurs every 4.5 seconds and lasts ~0.2s
      const isNaturalBlink = (t % 4.5) < 0.2;
      const template = isNaturalBlink
        ? stagedTraceJson.templates.closedUpright
        : stagedTraceJson.templates.openUpright;

      const frame: SignalFrame = {
        timestamp: t,
        landmarks: template as Landmark3D[],
        blink: isNaturalBlink,
        confidence: 0.95
      };

      const evidence = evaluator.evaluateFrame(frame);
      stateMachine.processFrame(evidence, frame);
    }

    expect(pauseCount).toBe(0);
  });

  it('Acceptance Criterion 2: At least 4 of 5 staged brief lapses (3-5s) produce a marker', () => {
    const briefLapses = stagedTraceJson.groundTruth.stagedBriefLapses;
    let producedMarkers = 0;

    briefLapses.forEach((lapse) => {
      evaluator.reset();
      stateMachine.reset();
      const lapseMarkers: DetectionEvent[] = [];
      stateMachine.setCallbacks({
        onMarkerEmitted: (ev) => lapseMarkers.push(ev)
      });

      const duration = lapse.end - lapse.start; // e.g. 3.5s

      // Eyes closed for duration
      for (let sec = 0; sec <= duration; sec += 0.1) {
        const frame: SignalFrame = {
          timestamp: lapse.start + sec,
          landmarks: stagedTraceJson.templates.closedUpright as Landmark3D[],
          confidence: 0.9
        };
        const evidence = evaluator.evaluateFrame(frame);
        stateMachine.processFrame(evidence, frame);
      }

      // Eyes reopen (triggers Rule D marker)
      const openFrame: SignalFrame = {
        timestamp: lapse.end + 0.1,
        landmarks: stagedTraceJson.templates.openUpright as Landmark3D[],
        confidence: 0.9
      };
      const evidence = evaluator.evaluateFrame(openFrame);
      stateMachine.processFrame(evidence, openFrame);

      if (lapseMarkers.some((m) => m.evidence.includes('D'))) {
        producedMarkers++;
      }
    });

    expect(producedMarkers).toBeGreaterThanOrEqual(4);
    expect(producedMarkers).toBe(5);
  });

  it('Acceptance Criterion 3: No more than 1 false marker per 10 minutes of attentive viewing', () => {
    evaluator.reset();
    stateMachine.reset();

    const falseMarkers: DetectionEvent[] = [];
    stateMachine.setCallbacks({
      onMarkerEmitted: (ev) => falseMarkers.push(ev)
    });

    const totalSeconds = 600; // 10 minutes
    const stepSec = 0.2;

    for (let t = 0; t < totalSeconds; t += stepSec) {
      // Natural blinks (0.15s duration)
      const isBlink = (t % 4.0) < 0.15;
      const template = isBlink
        ? stagedTraceJson.templates.closedUpright
        : stagedTraceJson.templates.openUpright;

      const frame: SignalFrame = {
        timestamp: t,
        landmarks: template as Landmark3D[],
        confidence: 0.95
      };

      const evidence = evaluator.evaluateFrame(frame);
      stateMachine.processFrame(evidence, frame);
    }

    expect(falseMarkers.length).toBeLessThanOrEqual(1);
  });

  it('Notes Mode relaxes pitch ceiling to 35 degrees and suppresses Evidence B', () => {
    evaluator.reset();
    evaluator.setNotesMode(true); // Enable Notes Mode

    // Eyes closed with head down at -25 degrees for 6.5s
    const emittedCandidates: string[] = [];
    for (let sec = 0; sec <= 6.5; sec += 0.1) {
      const frame: SignalFrame = {
        timestamp: 10 + sec,
        landmarks: stagedTraceJson.templates.closedHeadDown as Landmark3D[],
        confidence: 0.9
      };
      const ev = evaluator.evaluateFrame(frame);
      emittedCandidates.push(...ev.pauseCandidates);
    }

    // Candidate A fires due to relaxed pitch ceiling (Section 13)
    expect(emittedCandidates).toContain('A');
    // Candidate B is suppressed in Notes Mode
    expect(emittedCandidates).not.toContain('B');
  });

  it('Unified accumulator preserves closure timer across head drop transition', () => {
    evaluator.reset();
    const emittedCandidates: string[] = [];

    // 0 to 4.5s: eyes closed upright
    for (let sec = 0; sec < 4.5; sec += 0.1) {
      const frame: SignalFrame = {
        timestamp: sec,
        landmarks: stagedTraceJson.templates.closedUpright as Landmark3D[],
        confidence: 0.9
      };
      const ev = evaluator.evaluateFrame(frame);
      emittedCandidates.push(...ev.pauseCandidates);
    }

    // 4.5s to 6.2s: head drops below -20 degrees without opening eyes
    for (let sec = 4.5; sec <= 6.2; sec += 0.1) {
      const frame: SignalFrame = {
        timestamp: sec,
        landmarks: stagedTraceJson.templates.closedHeadDown as Landmark3D[],
        confidence: 0.9
      };
      const ev = evaluator.evaluateFrame(frame);
      emittedCandidates.push(...ev.pauseCandidates);
    }

    // Candidate A must fire at 6.0s via the continuous accumulator
    expect(emittedCandidates).toContain('A');
  });

  it('Debounces double-blink gesture (FR-13) and prevents rapid blink spam', () => {
    evaluator.reset();
    const openLm = stagedTraceJson.templates.openUpright as Landmark3D[];

    // 1. Single blink at t=1.0s (rising edge)
    let ev = evaluator.evaluateFrame({ timestamp: 1.0, confidence: 0.9, blink: true, landmarks: openLm });
    expect(ev.bookmarks.length).toBe(0);

    // Eyes open at t=1.1s
    ev = evaluator.evaluateFrame({ timestamp: 1.1, confidence: 0.9, blink: false, landmarks: openLm });
    expect(ev.bookmarks.length).toBe(0);

    // 2. Micro-jitter blink at t=1.15s (only 50ms later -> ignored, dt < 180ms)
    ev = evaluator.evaluateFrame({ timestamp: 1.15, confidence: 0.9, blink: true, landmarks: openLm });
    expect(ev.bookmarks.length).toBe(0);

    // Eyes open at t=1.2s
    evaluator.evaluateFrame({ timestamp: 1.2, confidence: 0.9, blink: false, landmarks: openLm });

    // 3. Second intentional blink at t=1.5s (dt = 350ms, valid double-blink!)
    ev = evaluator.evaluateFrame({ timestamp: 1.5, confidence: 0.9, blink: true, landmarks: openLm });
    expect(ev.bookmarks.length).toBe(1);
    expect(ev.bookmarks[0].id).toBe('F');

    // Eyes open at t=1.6s
    evaluator.evaluateFrame({ timestamp: 1.6, confidence: 0.9, blink: false, landmarks: openLm });

    // 4. Another double-blink attempted at t=2.0s & t=2.4s (during 3.5s cooldown -> rejected)
    evaluator.evaluateFrame({ timestamp: 2.0, confidence: 0.9, blink: true, landmarks: openLm });
    evaluator.evaluateFrame({ timestamp: 2.1, confidence: 0.9, blink: false, landmarks: openLm });
    ev = evaluator.evaluateFrame({ timestamp: 2.4, confidence: 0.9, blink: true, landmarks: openLm });
    expect(ev.bookmarks.length).toBe(0); // Protected by cooldown!
  });
});
