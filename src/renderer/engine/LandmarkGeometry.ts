import { Landmark3D, HeadPose } from '@shared/types';

/**
 * Canonical MediaPipe 478 Landmark Indices for Eye and Head Pose Extraction
 */
export const LANDMARK_INDICES = {
  // Left eye
  LEFT_EYE: {
    P1: 33,  // Outer corner
    P2: 160, // Upper lid outer
    P3: 158, // Upper lid inner
    P4: 133, // Inner corner
    P5: 153, // Lower lid inner
    P6: 144  // Lower lid outer
  },
  // Right eye
  RIGHT_EYE: {
    P1: 362, // Inner corner
    P2: 385, // Upper lid inner
    P3: 387, // Upper lid outer
    P4: 263, // Outer corner
    P5: 373, // Lower lid outer
    P6: 380  // Lower lid inner
  },
  // Pose extraction
  NOSE_BRIDGE: 168,
  CHIN: 152,
  LEFT_EYE_OUTER: 33,
  RIGHT_EYE_OUTER: 263
} as const;

/**
 * 2D Euclidean distance in normalized coordinate space
 */
export function distance2D(a: Landmark3D, b: Landmark3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 3D Euclidean distance
 */
export function distance3D(a: Landmark3D, b: Landmark3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Eye Aspect Ratio (EAR) for a single eye
 * Formula: EAR = (||p2 - p6|| + ||p3 - p5||) / (2 * ||p1 - p4||)
 */
export function calculateEyeEAR(
  p1: Landmark3D,
  p2: Landmark3D,
  p3: Landmark3D,
  p4: Landmark3D,
  p5: Landmark3D,
  p6: Landmark3D
): number {
  const horizontalDist = distance2D(p1, p4);
  if (horizontalDist === 0) return 0;

  const verticalDist1 = distance2D(p2, p6);
  const verticalDist2 = distance2D(p3, p5);

  return (verticalDist1 + verticalDist2) / (2.0 * horizontalDist);
}

/**
 * Computes composite continuous Eye Aspect Ratio (EAR) across both eyes from 478 landmarks.
 * Returns null if landmarks are missing or insufficient.
 */
export function computeCompositeEAR(landmarks?: Landmark3D[]): number | null {
  if (!landmarks || landmarks.length < 468) {
    return null;
  }

  const L = LANDMARK_INDICES.LEFT_EYE;
  const R = LANDMARK_INDICES.RIGHT_EYE;

  const pL1 = landmarks[L.P1];
  const pL2 = landmarks[L.P2];
  const pL3 = landmarks[L.P3];
  const pL4 = landmarks[L.P4];
  const pL5 = landmarks[L.P5];
  const pL6 = landmarks[L.P6];

  const pR1 = landmarks[R.P1];
  const pR2 = landmarks[R.P2];
  const pR3 = landmarks[R.P3];
  const pR4 = landmarks[R.P4];
  const pR5 = landmarks[R.P5];
  const pR6 = landmarks[R.P6];

  if (!pL1 || !pL2 || !pL3 || !pL4 || !pL5 || !pL6 ||
      !pR1 || !pR2 || !pR3 || !pR4 || !pR5 || !pR6) {
    return null;
  }

  const leftEar = calculateEyeEAR(pL1, pL2, pL3, pL4, pL5, pL6);
  const rightEar = calculateEyeEAR(pR1, pR2, pR3, pR4, pR5, pR6);

  return (leftEar + rightEar) / 2.0;
}

/**
 * Computes head pitch and yaw angles in degrees from facial landmarks.
 * Pitch is derived from the vertical axis vector (nose bridge 168 to chin 152).
 * Yaw is derived from the lateral vector (outer eye corners 33 to 263).
 */
export function computeRawHeadPose(landmarks?: Landmark3D[]): HeadPose | null {
  if (!landmarks || landmarks.length < 468) {
    return null;
  }

  const nose = landmarks[LANDMARK_INDICES.NOSE_BRIDGE];
  const chin = landmarks[LANDMARK_INDICES.CHIN];
  const leftEyeOuter = landmarks[LANDMARK_INDICES.LEFT_EYE_OUTER];
  const rightEyeOuter = landmarks[LANDMARK_INDICES.RIGHT_EYE_OUTER];

  if (!nose || !chin || !leftEyeOuter || !rightEyeOuter) {
    return null;
  }

  // Pitch: vector nose -> chin
  // dy: chin.y - nose.y; dz: chin.z - nose.z
  const dyPitch = chin.y - nose.y;
  const dzPitch = (chin.z ?? 0) - (nose.z ?? 0);
  const pitchRad = Math.atan2(dzPitch, dyPitch);
  const pitchDeg = (pitchRad * 180.0) / Math.PI;

  // Yaw: vector left eye -> right eye
  // dx: right.x - left.x; dz: right.z - left.z
  const dxYaw = rightEyeOuter.x - leftEyeOuter.x;
  const dzYaw = (rightEyeOuter.z ?? 0) - (leftEyeOuter.z ?? 0);
  const yawRad = Math.atan2(dzYaw, dxYaw);
  const yawDeg = (yawRad * 180.0) / Math.PI;

  return {
    pitch: pitchDeg,
    yaw: yawDeg
  };
}

/**
 * Computes calibrated relative delta pitch and yaw against baseline.
 */
export function computeRelativePose(rawPose: HeadPose, baselinePitch: number, baselineYaw: number): HeadPose {
  return {
    pitch: rawPose.pitch - baselinePitch,
    yaw: rawPose.yaw - baselineYaw
  };
}

export class LandmarkGeometry {
  public static calculateEyeEAR = calculateEyeEAR;
  public static computeCompositeEAR = computeCompositeEAR;
  public static computeRawHeadPose = computeRawHeadPose;
  public static computeRelativePose = computeRelativePose;
  public static distance2D = distance2D;
  public static distance3D = distance3D;
  public static INDICES = LANDMARK_INDICES;
}

