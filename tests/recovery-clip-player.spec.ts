import { describe, it, expect } from 'vitest';
import { DetectionEvent, QueueInterval, SessionDocument } from '../src/shared/types';
import { SessionInsights } from '../src/renderer/engine/SessionInsights';

describe('Recovery Clip Player & Sequential Replay', () => {
  interface ActiveClip {
    id: string;
    title: string;
    start: number;
    end: number;
    queueIndex?: number;
  }

  const sampleEvents: DetectionEvent[] = [
    {
      id: 'pause-1',
      type: 'pause',
      start: 30,
      end: 60,
      evidence: ['A', 'B'],
      confidence: 0.95,
      note: 'Viewer absent'
    },
    {
      id: 'marker-1',
      type: 'marker',
      start: 110,
      end: 112,
      evidence: ['C'],
      confidence: 0.85,
      note: 'Brief eye closure'
    },
    {
      id: 'bookmark-1',
      type: 'bookmark',
      start: 180,
      end: 180,
      evidence: ['F'],
      confidence: 1.0,
      note: 'Intentional bookmark'
    }
  ];

  const sampleQueue: QueueInterval[] = [
    {
      id: 'q-1',
      start: 20,
      end: 60,
      duration: 40,
      chapterTitle: 'Intro Section',
      sourceEventIds: ['pause-1']
    },
    {
      id: 'q-2',
      start: 100,
      end: 120,
      duration: 20,
      chapterTitle: 'Core Concepts',
      sourceEventIds: ['marker-1']
    },
    {
      id: 'q-3',
      start: 170,
      end: 195,
      duration: 25,
      chapterTitle: 'Summary',
      sourceEventIds: ['bookmark-1']
    }
  ];

  describe('Clip Auto-Stopping at Interval End Boundary', () => {
    it('detects when currentTime reaches or exceeds active clip end boundary', () => {
      const clip: ActiveClip = { id: 'q-1', title: 'Segment 1', start: 20, end: 60 };
      expect(SessionInsights.calculateClipProgress(19, clip.start, clip.end)).toBe(0);
      expect(SessionInsights.calculateClipProgress(40, clip.start, clip.end)).toBe(50);
      expect(SessionInsights.calculateClipProgress(60, clip.start, clip.end)).toBe(100);
      expect(SessionInsights.calculateClipProgress(65, clip.start, clip.end)).toBe(100);

      const isClipEnded = (currentTime: number, end: number) => currentTime >= end;
      expect(isClipEnded(59.9, clip.end)).toBe(false);
      expect(isClipEnded(60.0, clip.end)).toBe(true);
      expect(isClipEnded(60.5, clip.end)).toBe(true);
    });
  });

  describe('Sequential Rewind Flow ("Play All Missed Clips")', () => {
    it('advances sequentially through queue intervals and marks each reviewed', () => {
      let isPlayingSequence = true;
      let activeIndex = 0;
      let reviewedIds: string[] = [];

      const handleEnded = (currentIndex: number) => {
        const curClip = sampleQueue[currentIndex];
        if (!reviewedIds.includes(curClip.id)) {
          reviewedIds.push(curClip.id);
        }
        const next = SessionInsights.advanceToNextClip(currentIndex, sampleQueue.length, isPlayingSequence);
        if (next !== null) {
          activeIndex = next;
        } else {
          isPlayingSequence = false;
        }
      };

      // Clip 1 plays and finishes
      expect(activeIndex).toBe(0);
      handleEnded(0);
      expect(reviewedIds).toContain('q-1');
      expect(activeIndex).toBe(1);
      expect(isPlayingSequence).toBe(true);

      // Clip 2 plays and finishes
      handleEnded(1);
      expect(reviewedIds).toContain('q-2');
      expect(activeIndex).toBe(2);
      expect(isPlayingSequence).toBe(true);

      // Clip 3 (last clip) plays and finishes
      handleEnded(2);
      expect(reviewedIds).toContain('q-3');
      expect(reviewedIds.length).toBe(3);
      expect(isPlayingSequence).toBe(false);
    });

    it('stops playback when sequential mode is false', () => {
      const next = SessionInsights.advanceToNextClip(0, sampleQueue.length, false);
      expect(next).toBeNull();
    });
  });

  describe('Individual Missed Lapses Playlist Extraction', () => {
    it('extracts every pause, brief marker, and bookmark as a discrete playable recovery clip', () => {
      const clips: ActiveClip[] = sampleEvents.map((ev, idx) => ({
        id: ev.id,
        title:
          ev.type === 'pause'
            ? `Absence Pause #${idx + 1}`
            : ev.type === 'marker'
            ? `Brief Eye Closure #${idx + 1}`
            : `Bookmark #${idx + 1}`,
        start: Math.max(0, ev.start - 5),
        end: ev.end + 5
      }));

      expect(clips.length).toBe(3);
      // Segment 1 (pause 30-60 with 5s padding)
      expect(clips[0].id).toBe('pause-1');
      expect(clips[0].start).toBe(25);
      expect(clips[0].end).toBe(65);

      // Segment 2 (marker 110-112 with 5s padding)
      expect(clips[1].id).toBe('marker-1');
      expect(clips[1].start).toBe(105);
      expect(clips[1].end).toBe(117);

      // Segment 3 (bookmark 180 with 5s padding)
      expect(clips[2].id).toBe('bookmark-1');
      expect(clips[2].start).toBe(175);
      expect(clips[2].end).toBe(185);
    });
  });

  describe('Reviewed Checkbox and Manual Replay State', () => {
    it('toggles reviewed status correctly', () => {
      let reviewed: string[] = [];
      reviewed = SessionInsights.toggleReviewedId(reviewed, 'clip-A');
      expect(reviewed).toEqual(['clip-A']);

      reviewed = SessionInsights.toggleReviewedId(reviewed, 'clip-B');
      expect(reviewed).toEqual(['clip-A', 'clip-B']);

      // Untoggle clip-A
      reviewed = SessionInsights.toggleReviewedId(reviewed, 'clip-A');
      expect(reviewed).toEqual(['clip-B']);
    });
  });
});
