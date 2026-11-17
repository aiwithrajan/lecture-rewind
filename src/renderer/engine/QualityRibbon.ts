import { QualityBucket, SignalFrame } from '@shared/types';

export class QualityRibbon {
  private bucketDurationSec: number;
  private qualityThreshold: number;
  private currentBucketStart: number = 0;
  private currentConfidences: number[] = [];
  private buckets: QualityBucket[] = [];

  constructor(qualityThreshold: number = 0.60, bucketDurationSec: number = 5.0) {
    this.qualityThreshold = qualityThreshold;
    this.bucketDurationSec = bucketDurationSec;
  }

  public setQualityThreshold(threshold: number): void {
    this.qualityThreshold = threshold;
  }

  public reset(): void {
    this.currentBucketStart = 0;
    this.currentConfidences = [];
    this.buckets = [];
  }

  public addFrame(frame: SignalFrame): void {
    const ts = frame.timestamp;

    if (this.currentConfidences.length === 0) {
      this.currentBucketStart = Math.floor(ts / this.bucketDurationSec) * this.bucketDurationSec;
    }

    // Check if frame belongs to a new bucket
    while (ts >= this.currentBucketStart + this.bucketDurationSec) {
      this.finalizeCurrentBucket();
      this.currentBucketStart += this.bucketDurationSec;
    }

    this.currentConfidences.push(frame.confidence);
  }

  public getBuckets(): QualityBucket[] {
    // Return finalized buckets plus snapshot of in-progress bucket
    if (this.currentConfidences.length === 0) {
      return [...this.buckets];
    }

    const avgConf = this.currentConfidences.reduce((a, b) => a + b, 0) / this.currentConfidences.length;
    const activeBucket: QualityBucket = {
      timestamp: this.currentBucketStart,
      duration: this.bucketDurationSec,
      confidence: Number(avgConf.toFixed(2)),
      isDegraded: avgConf < this.qualityThreshold
    };

    return [...this.buckets, activeBucket];
  }

  private finalizeCurrentBucket(): void {
    if (this.currentConfidences.length === 0) {
      return;
    }

    const avgConf = this.currentConfidences.reduce((a, b) => a + b, 0) / this.currentConfidences.length;
    const bucket: QualityBucket = {
      timestamp: this.currentBucketStart,
      duration: this.bucketDurationSec,
      confidence: Number(avgConf.toFixed(2)),
      isDegraded: avgConf < this.qualityThreshold
    };

    this.buckets.push(bucket);
    this.currentConfidences = [];
  }

  /**
   * Checks if an interval [start, end] overlaps with any degraded quality bucket
   */
  public static hasDegradedOverlap(start: number, end: number, buckets: QualityBucket[]): boolean {
    return buckets.some((b) => b.isDegraded && Math.max(start, b.timestamp) < Math.min(end, b.timestamp + b.duration));
  }

  /**
   * Excludes or splits an interval around degraded buckets (PRD FR-10, Acceptance Criterion 5).
   * Returns surviving valid sub-intervals.
   */
  public static excludeDegradedRanges(
    interval: { start: number; end: number },
    buckets: QualityBucket[]
  ): Array<{ start: number; end: number }> {
    let currentSegments = [interval];

    for (const b of buckets) {
      if (!b.isDegraded) continue;

      const bStart = b.timestamp;
      const bEnd = b.timestamp + b.duration;
      const nextSegments: Array<{ start: number; end: number }> = [];

      for (const seg of currentSegments) {
        // No overlap
        if (seg.end <= bStart || seg.start >= bEnd) {
          nextSegments.push(seg);
          continue;
        }

        // Left surviving piece
        if (seg.start < bStart) {
          nextSegments.push({ start: seg.start, end: bStart });
        }

        // Right surviving piece
        if (seg.end > bEnd) {
          nextSegments.push({ start: bEnd, end: seg.end });
        }
      }

      currentSegments = nextSegments;
    }

    // Filter out degenerate or zero-duration segments
    return currentSegments.filter((seg) => (seg.end - seg.start) >= 1.0);
  }
}
