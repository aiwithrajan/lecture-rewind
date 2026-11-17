import { ChapterInfo, DetectionEvent, QualityBucket, QueueInterval } from '@shared/types';
import { QualityRibbon } from './QualityRibbon';

export interface RawInterval {
  start: number;
  end: number;
  sourceEventIds: string[];
}

export class QueueBuilder {
  /**
   * Pure, deterministic queue construction pipeline implementing PRD Section 8.5 & Blueprint Section 5.3
   */
  public static buildRewindQueue(
    events: DetectionEvent[],
    qualityBuckets: QualityBucket[],
    chapters: ChapterInfo[] = [],
    videoDurationSec: number = 3600
  ): QueueInterval[] {
    if (events.length === 0) {
      return [];
    }

    // Step 1: Collect
    // Convert point bookmarks at timestamp t into base interval [t, min(t + 15, D)]
    const collected: RawInterval[] = [];
    for (const ev of events) {
      if (ev.type === 'bookmark') {
        const bStart = ev.start;
        const bEnd = Math.min(bStart + 15, videoDurationSec);
        collected.push({
          start: bStart,
          end: Math.max(bStart + 1, bEnd),
          sourceEventIds: [ev.id]
        });
      } else if (ev.type === 'pause' || ev.type === 'marker') {
        collected.push({
          start: Math.max(0, ev.start),
          end: Math.min(videoDurationSec, Math.max(ev.start + 1, ev.end)),
          sourceEventIds: [ev.id]
        });
      }
    }

    // Step 2: Exclude Low Confidence (FR-10, Acceptance Criterion 5)
    // Discard or split intervals overlapping degraded quality buckets
    const surviving: RawInterval[] = [];
    for (const item of collected) {
      const validSubRanges = QualityRibbon.excludeDegradedRanges(
        { start: item.start, end: item.end },
        qualityBuckets
      );
      for (const range of validSubRanges) {
        surviving.push({
          start: range.start,
          end: range.end,
          sourceEventIds: [...item.sourceEventIds]
        });
      }
    }

    if (surviving.length === 0) {
      return [];
    }

    // Step 3: Expand Pre-Roll
    // Subtract 10 seconds from the start of every surviving interval: start' = max(0, start - 10)
    const expanded: RawInterval[] = surviving.map((item) => ({
      start: Math.max(0, item.start - 10),
      end: item.end,
      sourceEventIds: item.sourceEventIds
    }));

    // Step 4: Merge Adjacent Intervals
    // Sort intervals by start' ascending. If next.start' - current.end <= 30 seconds, merge.
    expanded.sort((a, b) => a.start - b.start);

    const merged: RawInterval[] = [];
    let current = { ...expanded[0] };

    for (let i = 1; i < expanded.length; i++) {
      const next = expanded[i];
      if (next.start - current.end <= 30) {
        // Merge
        current.end = Math.max(current.end, next.end);
        current.sourceEventIds = Array.from(new Set([...current.sourceEventIds, ...next.sourceEventIds]));
      } else {
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    // Step 5: Snap to Boundaries
    // If source chapter metadata is present, check nearest enclosing chapter start/end;
    // if within 45s, snap to chapter boundary and attach chapter title.
    // Otherwise snap start down to floor(start / 15) * 15 and end up to min(D, ceil(end / 15) * 15).
    const snapped: QueueInterval[] = merged.map((item, index) => {
      let s = item.start;
      let e = item.end;
      let attachedChapter: string | undefined;

      // Find enclosing or nearest chapter
      const enclosingChapter = chapters.find(
        (ch) => s >= ch.start - 45 && e <= ch.end + 45
      );

      if (enclosingChapter) {
        if (Math.abs(s - enclosingChapter.start) <= 45) {
          s = enclosingChapter.start;
          attachedChapter = enclosingChapter.title;
        } else {
          s = Math.floor(s / 15) * 15;
        }

        if (Math.abs(e - enclosingChapter.end) <= 45) {
          e = Math.min(videoDurationSec, enclosingChapter.end);
          attachedChapter = enclosingChapter.title;
        } else {
          e = Math.min(videoDurationSec, Math.ceil(e / 15) * 15);
        }
      } else {
        // Fallback to 15-second grid snapping
        s = Math.floor(s / 15) * 15;
        e = Math.min(videoDurationSec, Math.ceil(e / 15) * 15);
      }

      // Bound safety
      s = Math.max(0, s);
      e = Math.min(videoDurationSec, Math.max(s + 15, e));

      return {
        id: `queue-interval-${index + 1}`,
        start: s,
        end: e,
        duration: e - s,
        chapterTitle: attachedChapter,
        sourceEventIds: item.sourceEventIds
      };
    });

    // Final merge pass in case snapping caused intervals to overlap or touch
    const finalQueue: QueueInterval[] = [];
    if (snapped.length > 0) {
      let cur = { ...snapped[0] };
      for (let i = 1; i < snapped.length; i++) {
        const next = snapped[i];
        if (next.start <= cur.end) {
          cur.end = Math.max(cur.end, next.end);
          cur.duration = cur.end - cur.start;
          cur.sourceEventIds = Array.from(new Set([...cur.sourceEventIds, ...next.sourceEventIds]));
          if (!cur.chapterTitle && next.chapterTitle) {
            cur.chapterTitle = next.chapterTitle;
          }
        } else {
          finalQueue.push(cur);
          cur = { ...next };
        }
      }
      finalQueue.push(cur);
    }

    return finalQueue;
  }

  /**
   * Sums exact total duration of queue intervals in seconds
   */
  public static calculateTotalDuration(queue: QueueInterval[]): number {
    return queue.reduce((sum, item) => sum + item.duration, 0);
  }

  /**
   * Formats the headline review text per PRD Section 6.4:
   * e.g. "52 minutes watched, 8 minutes to rewatch"
   */
  public static formatReviewHeadline(watchedSec: number, rewatchSec: number): string {
    const watchedMins = Math.round(watchedSec / 60);
    const rewatchMins = Math.round(rewatchSec / 60);
    return `${watchedMins} minutes watched, ${rewatchMins} minutes to rewatch`;
  }
}
