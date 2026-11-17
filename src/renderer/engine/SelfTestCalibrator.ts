import { CalibrationResult, SignalFrame } from '@shared/types';
import { computeCompositeEAR, computeRawHeadPose } from './LandmarkGeometry';

export interface CalibrationSampleSet {
  neutralFrames: SignalFrame[];
  closureFrames: SignalFrame[];
  latencyMeasurementsMs?: number[];
  userSensitivity?: number; // 5.0 to 10.0 seconds, default 6.0
}

/**
 * SelfTestCalibrator computes personalized thresholds and honest reliability verdicts
 * based on the 20-second guided setup sequence (PRD Section 8.4, Acceptance Criterion 9).
 */
export class SelfTestCalibrator {
  /**
   * Evaluates samples and computes a deterministic CalibrationResult.
   */
  public static calibrate(samples: CalibrationSampleSet): CalibrationResult {
    const {
      neutralFrames,
      closureFrames,
      latencyMeasurementsMs = [180, 220, 200],
      userSensitivity = 6.0
    } = samples;

    // 1. Compute Neutral Baseline EAR and Poses
    const neutralEars: number[] = [];
    const neutralPitches: number[] = [];
    const neutralYaws: number[] = [];
    const neutralConfidences: number[] = [];

    for (const frame of neutralFrames) {
      if (frame.landmarks) {
        const ear = computeCompositeEAR(frame.landmarks);
        if (ear !== null) neutralEars.push(ear);

        const pose = computeRawHeadPose(frame.landmarks);
        if (pose !== null) {
          neutralPitches.push(pose.pitch);
          neutralYaws.push(pose.yaw);
        }
      }
      neutralConfidences.push(frame.confidence);
    }

    const baselineEar = neutralEars.length > 0
      ? neutralEars.reduce((a, b) => a + b, 0) / neutralEars.length
      : 0.28;

    const baselinePitch = neutralPitches.length > 0
      ? neutralPitches.reduce((a, b) => a + b, 0) / neutralPitches.length
      : 0.0;

    const baselineYaw = neutralYaws.length > 0
      ? neutralYaws.reduce((a, b) => a + b, 0) / neutralYaws.length
      : 0.0;

    // 2. Compute Closed Eyelid EAR
    const closedEars: number[] = [];
    for (const frame of closureFrames) {
      if (frame.landmarks) {
        const ear = computeCompositeEAR(frame.landmarks);
        if (ear !== null) closedEars.push(ear);
      }
    }

    const meanClosedEar = closedEars.length > 0
      ? closedEars.reduce((a, b) => a + b, 0) / closedEars.length
      : 0.12;

    // Separation between open and closed aperture
    const separation = baselineEar - meanClosedEar;

    // Calibrated closure threshold (midpoint weighted slightly towards closed state)
    // Formula: closureEar + 0.35 * (baselineEar - closureEar)
    const closureThreshold = separation > 0.04
      ? meanClosedEar + (separation * 0.40)
      : baselineEar * 0.65;

    // 3. Latency measurement
    const detectionLatencyMs = latencyMeasurementsMs.length > 0
      ? Math.round(latencyMeasurementsMs.reduce((a, b) => a + b, 0) / latencyMeasurementsMs.length)
      : 200;

    // 4. Landmark stability and quality threshold
    const avgConfidence = neutralConfidences.length > 0
      ? neutralConfidences.reduce((a, b) => a + b, 0) / neutralConfidences.length
      : 0.85;

    // Calculate variance of neutral EAR
    const earVariance = neutralEars.length > 1
      ? neutralEars.reduce((sum, val) => sum + Math.pow(val - baselineEar, 2), 0) / (neutralEars.length - 1)
      : 0.0001;

    // 5. Evaluate Honest Reliability Verdicts (Acceptance Criterion 9)
    let earReliable = true;
    let earScore = 1.0;
    let earReason: string | undefined;

    if (baselineEar < 0.18) {
      earReliable = false;
      earScore = 0.3;
      earReason = 'Eye aperture is barely detectable. Check lighting or camera angle.';
    } else if (separation < 0.05) {
      earReliable = false;
      earScore = 0.4;
      earReason = 'Insufficient contrast between open and closed eyelids.';
    } else if (earVariance > 0.005) {
      earReliable = false;
      earScore = 0.5;
      earReason = 'High eyelid measurement jitter detected.';
    }

    let poseReliable = true;
    let poseScore = 1.0;
    let poseReason: string | undefined;

    if (neutralPitches.length === 0 || avgConfidence < 0.5) {
      poseReliable = false;
      poseScore = 0.3;
      poseReason = 'Head pose landmark tracking unstable.';
    } else if (Math.abs(baselinePitch) > 40) {
      poseReliable = false;
      poseScore = 0.5;
      poseReason = 'Camera is positioned at an extreme vertical angle.';
    }

    let overall: 'reliable' | 'degraded' | 'unreliable' = 'reliable';
    if (!earReliable && !poseReliable) {
      overall = 'unreliable';
    } else if (!earReliable || !poseReliable || avgConfidence < 0.65) {
      overall = 'degraded';
    }

    return {
      completedAt: new Date().toISOString(),
      baselineEar: Number(baselineEar.toFixed(4)),
      closureThreshold: Number(closureThreshold.toFixed(4)),
      detectionLatencyMs,
      baselinePitch: Number(baselinePitch.toFixed(2)),
      baselineYaw: Number(baselineYaw.toFixed(2)),
      qualityThreshold: Math.max(0.5, Number((avgConfidence * 0.8).toFixed(2))),
      userSensitivity: Math.min(10.0, Math.max(5.0, userSensitivity)),
      verdicts: {
        ear: {
          reliable: earReliable,
          score: Number(earScore.toFixed(2)),
          reason: earReason
        },
        pose: {
          reliable: poseReliable,
          score: Number(poseScore.toFixed(2)),
          reason: poseReason
        },
        overall
      }
    };
  }

  /**
   * Quick default fallback calibration when running in standard testing or simulation
   */
  public static getDefaultCalibration(userSensitivity = 6.0): CalibrationResult {
    return {
      completedAt: new Date().toISOString(),
      baselineEar: 0.28,
      closureThreshold: 0.18,
      detectionLatencyMs: 190,
      baselinePitch: 0.0,
      baselineYaw: 0.0,
      qualityThreshold: 0.60,
      userSensitivity,
      verdicts: {
        ear: { reliable: true, score: 0.95 },
        pose: { reliable: true, score: 0.95 },
        overall: 'reliable'
      }
    };
  }
}
