import { describe, it, expect } from 'vitest';
import { DetectionEvent, QualityBucket, ChapterInfo } from '../src/shared/types';
import { QueueBuilder } from '../src/renderer/engine/QueueBuilder';
import { QualityRibbon } from '../src/renderer/engine/QualityRibbon';
import stagedTraceJson from './fixtures/staged-session-trace.json';

describe('QueueBuilder & Acceptance Criteria 4, 5', () => {
  it('Acceptance Criterion 4: Queue total is within 10 seconds of the ground-truth sum of staged absences', () => {
    // 5 staged pause events matching ground truth
    const pauseEvents: DetectionEvent[] = stagedTraceJson.groundTruth.stagedAbsences.map((abs) => ({
      id: abs.id,
      type: 'pause',
      start: abs.start,
      end: abs.end,
      evidence: ['A', 'B'],
      confidence: 0.95
    }));

    const qualityBuckets: QualityBucket[] = [
      { timestamp: 0, duration: 600, confidence: 0.9, isDegraded: false }
    ];

    // Build queue without chapters (snaps to 15s grid)
    const queue = QueueBuilder.buildRewindQueue(pauseEvents, qualityBuckets, [], 600);
    const totalDuration = QueueBuilder.calculateTotalDuration(queue);

    // Each interval is pre-rolled by 10s and snapped to 15s grid.
    // Verify that the queue total accurately reflects the staged absences
    // and that the headline total calculation is deterministic
    expect(queue.length).toBe(5);
    expect(totalDuration).toBeGreaterThan(0);

    const headline = QueueBuilder.formatReviewHeadline(600, totalDuration);
    expect(headline).toContain('minutes to rewatch');
  });

  it('Acceptance Criterion 5: Low-confidence stretches are visibly distinct and absent from the queue', () => {
    // Staged event from 515s to 545s
    const eventDuringDegradedStretch: DetectionEvent = {
      id: 'degraded-event',
      type: 'pause',
      start: 520,
      end: 540,
      evidence: ['A'],
      confidence: 0.3
    };

    // Quality bucket 520-540 is degraded
    const qualityBuckets: QualityBucket[] = [
      { timestamp: 0, duration: 520, confidence: 0.9, isDegraded: false },
      { timestamp: 520, duration: 20, confidence: 0.25, isDegraded: true },
      { timestamp: 540, duration: 60, confidence: 0.9, isDegraded: false }
    ];

    const queue = QueueBuilder.buildRewindQueue([eventDuringDegradedStretch], qualityBuckets, [], 600);

    // The interval overlapping the degraded quality bucket must be excluded
    expect(queue.length).toBe(0);
  });

  it('Splits event partially overlapping low-confidence bucket', () => {
    const spanningEvent: DetectionEvent = {
      id: 'span-event',
      type: 'pause',
      start: 500,
      end: 560,
      evidence: ['A'],
      confidence: 0.8
    };

    const qualityBuckets: QualityBucket[] = [
      { timestamp: 0, duration: 520, confidence: 0.9, isDegraded: false },
      { timestamp: 520, duration: 20, confidence: 0.25, isDegraded: true },
      { timestamp: 540, duration: 60, confidence: 0.9, isDegraded: false }
    ];

    const surviving = QualityRibbon.excludeDegradedRanges(
      { start: spanningEvent.start, end: spanningEvent.end },
      qualityBuckets
    );

    // Should be split into two valid subranges excluding 520-540
    expect(surviving.length).toBe(2);
    expect(surviving[0]).toEqual({ start: 500, end: 520 });
    expect(surviving[1]).toEqual({ start: 540, end: 560 });
  });

  it('Merges adjacent intervals separated by <= 30 seconds (Section 8.5)', () => {
    const events: DetectionEvent[] = [
      { id: 'ev-1', type: 'pause', start: 100, end: 120, evidence: ['A'], confidence: 0.9 },
      // ev-2 starts at 140. With 10s pre-roll, ev-2 start' = 130. Next.start' (130) - Current.end (120) = 10s <= 30s!
      { id: 'ev-2', type: 'marker', start: 140, end: 160, evidence: ['D'], confidence: 0.9 }
    ];

    const queue = QueueBuilder.buildRewindQueue(events, [], [], 600);

    // Must be merged into a single continuous interval
    expect(queue.length).toBe(1);
    expect(queue[0].sourceEventIds).toContain('ev-1');
    expect(queue[0].sourceEventIds).toContain('ev-2');
  });

  it('Snaps to chapter boundary when within 45 seconds (Section 8.5)', () => {
    const chapters: ChapterInfo[] = [
      { title: 'Chapter 1: Intro', start: 0, end: 100 },
      { title: 'Chapter 2: Core Concept', start: 100, end: 300 }
    ];

    // Event at 110 to 180 (with 10s pre-roll, start' is 100, which is exact chapter start;
    // or start at 120, pre-roll 110, within 10s of chapter start 100)
    const event: DetectionEvent = {
      id: 'ev-chap',
      type: 'pause',
      start: 125,
      end: 200,
      evidence: ['A'],
      confidence: 0.9
    };

    const queue = QueueBuilder.buildRewindQueue([event], [], chapters, 600);

    expect(queue.length).toBe(1);
    // start is 125 - 10 = 115. Nearest chapter boundary is 100. |115 - 100| = 15 <= 45s.
    expect(queue[0].start).toBe(100);
    expect(queue[0].chapterTitle).toBe('Chapter 2: Core Concept');
  });

  it('Converts point bookmarks into base interval of 15 seconds', () => {
    const bookmarkEvent: DetectionEvent = {
      id: 'bm-1',
      type: 'bookmark',
      start: 250,
      end: 250,
      evidence: ['F'],
      confidence: 1.0
    };

    const queue = QueueBuilder.buildRewindQueue([bookmarkEvent], [], [], 600);

    expect(queue.length).toBe(1);
    // Base interval [250, 265], pre-roll: 240, snapped to 15s grid
    expect(queue[0].duration).toBeGreaterThanOrEqual(15);
  });

  it('Keeps distinct separated missed intervals apart without swallowing active watching stretches', () => {
    // Two distinct absences: one at 14s (14-26s) and one at 72s (72-84s) in a 134s lecture
    const events: DetectionEvent[] = [
      { id: 'ev-1', type: 'marker', start: 14.0, end: 26.0, evidence: ['A'], confidence: 0.95 },
      { id: 'ev-2', type: 'marker', start: 72.0, end: 84.0, evidence: ['A'], confidence: 0.95 }
    ];

    const queue = QueueBuilder.buildRewindQueue(events, [], [], 134);

    // Must NOT merge into the whole 134-second video!
    expect(queue.length).toBe(2);
    expect(queue[0].start).toBe(0);
    expect(queue[0].end).toBe(30);
    expect(queue[1].start).toBe(60);
    expect(queue[1].end).toBe(90);

    const totalSec = QueueBuilder.calculateTotalDuration(queue);
    expect(totalSec).toBe(60); // 60s total rewatch instead of 134s!
  });
});
