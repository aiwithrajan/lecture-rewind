import { describe, it, expect } from 'vitest';
import { SessionDocument, VideoSource, DetectionEvent } from '../src/shared/types';
import { SessionInsights } from '../src/renderer/engine/SessionInsights';

describe('SessionInsights (FR-12, FR-15, Break Scheduling & UI Helpers)', () => {
  const dummySourceA: VideoSource = {
    type: 'local',
    pathOrUrl: '/lectures/cs101-lec01.mp4',
    name: 'cs101-lec01.mp4',
    duration: 3600
  };

  const dummySourceB: VideoSource = {
    type: 'url',
    pathOrUrl: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    name: 'YouTube Physics',
    duration: 1800
  };

  const makeSession = (
    source: VideoSource,
    events: DetectionEvent[] = []
  ): SessionDocument => ({
    version: 1,
    id: `session-${Math.random()}`,
    source,
    startedAt: new Date().toISOString(),
    calibration: {
      completedAt: new Date().toISOString(),
      baselineEar: 0.3,
      closureThreshold: 0.2,
      detectionLatencyMs: 200,
      baselinePitch: 0,
      baselineYaw: 0,
      qualityThreshold: 0.8,
      userSensitivity: 6.0,
      verdicts: {
        ear: { reliable: true, score: 0.95 },
        pose: { reliable: true, score: 0.95 },
        overall: 'reliable'
      }
    },
    events,
    quality: [],
    queue: [],
    pulse: []
  });

  describe('FR-12 Session History & Median Offset Calculation', () => {
    it('returns empty array when no sessions exist', () => {
      const insights = SessionInsights.calculateSourceInsights([]);
      expect(insights).toEqual([]);
    });

    it('returns empty array when fewer than 3 sessions exist for a video source (FR-12)', () => {
      const sessions = [
        makeSession(dummySourceA, [{ id: 'e1', type: 'pause', start: 600, end: 630, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceA, [{ id: 'e2', type: 'pause', start: 700, end: 730, evidence: ['A'], confidence: 0.9 }])
      ];

      const insights = SessionInsights.calculateSourceInsights(sessions);
      expect(insights).toEqual([]);
    });

    it('returns empty array when 3 sessions exist but none had pauses or markers', () => {
      const sessions = [
        makeSession(dummySourceA, []),
        makeSession(dummySourceA, []),
        makeSession(dummySourceA, [])
      ];

      const insights = SessionInsights.calculateSourceInsights(sessions);
      expect(insights).toEqual([]);
    });

    it('calculates median absence offset when 3 or more sessions exist with odd count of absences', () => {
      // 3 sessions with pause events at 600s, 900s, 1200s
      const sessions = [
        makeSession(dummySourceA, [{ id: '1', type: 'pause', start: 1200, end: 1230, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceA, [{ id: '2', type: 'pause', start: 600, end: 630, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceA, [{ id: '3', type: 'marker', start: 900, end: 902, evidence: ['C'], confidence: 0.9 }])
      ];

      const insights = SessionInsights.calculateSourceInsights(sessions);
      expect(insights.length).toBe(1);
      expect(insights[0].sessionCount).toBe(3);
      // Sorted: [600, 900, 1200] -> median is 900
      expect(insights[0].typicalOffsetSec).toBe(900);
      expect(insights[0].source.pathOrUrl).toBe(dummySourceA.pathOrUrl);
    });

    it('calculates median absence offset for even count of absences', () => {
      // 3 sessions with 4 absences: 500, 700, 800, 1100 -> median index 2 (800)
      const sessions = [
        makeSession(dummySourceA, [
          { id: '1', type: 'pause', start: 500, end: 530, evidence: ['A'], confidence: 0.9 },
          { id: '2', type: 'pause', start: 1100, end: 1130, evidence: ['A'], confidence: 0.9 }
        ]),
        makeSession(dummySourceA, [{ id: '3', type: 'pause', start: 700, end: 730, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceA, [{ id: '4', type: 'marker', start: 800, end: 802, evidence: ['C'], confidence: 0.9 }])
      ];

      const insights = SessionInsights.calculateSourceInsights(sessions);
      expect(insights.length).toBe(1);
      expect(insights[0].typicalOffsetSec).toBe(800);
    });

    it('isolates groups and only includes sources with >= 3 sessions', () => {
      const sessions = [
        // Source A has 3 sessions
        makeSession(dummySourceA, [{ id: 'a1', type: 'pause', start: 300, end: 330, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceA, [{ id: 'a2', type: 'pause', start: 400, end: 430, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceA, [{ id: 'a3', type: 'pause', start: 500, end: 530, evidence: ['A'], confidence: 0.9 }]),
        // Source B has only 2 sessions
        makeSession(dummySourceB, [{ id: 'b1', type: 'pause', start: 150, end: 180, evidence: ['A'], confidence: 0.9 }]),
        makeSession(dummySourceB, [{ id: 'b2', type: 'pause', start: 200, end: 230, evidence: ['A'], confidence: 0.9 }])
      ];

      const insights = SessionInsights.calculateSourceInsights(sessions);
      expect(insights.length).toBe(1);
      expect(insights[0].source.pathOrUrl).toBe(dummySourceA.pathOrUrl);
    });
  });

  describe('FR-15 Pulse SVG Geometry & Presence Breakdown', () => {
    it('generates clamped SVG path for pulse series points', () => {
      const pulse = [
        { timestamp: 0, value: 75 },
        { timestamp: 50, value: 85 },
        { timestamp: 100, value: 105 }
      ];

      const pathStr = SessionInsights.calculatePulseSvgPath(pulse, 100);
      expect(pathStr.startsWith('M')).toBe(true);
      expect(pathStr).toContain('L');
      // Verify all coordinate points are within SVG view limits [0, 1000] and [4, 34]
      const coords = pathStr.replace(/[ML]/g, '').trim().split(/\s+/).map(Number);
      for (let i = 0; i < coords.length; i += 2) {
        expect(coords[i]).toBeGreaterThanOrEqual(0);
        expect(coords[i]).toBeLessThanOrEqual(1000);
        expect(coords[i + 1]).toBeGreaterThanOrEqual(4);
        expect(coords[i + 1]).toBeLessThanOrEqual(34);
      }
    });

    it('returns empty string when pulse series is empty or duration is invalid', () => {
      expect(SessionInsights.calculatePulseSvgPath([], 100)).toBe('');
      expect(SessionInsights.calculatePulseSvgPath([{ timestamp: 10, value: 70 }], 0)).toBe('');
    });

    it('calculates presence breakdown percentages summing to 100%', () => {
      const breakdown = SessionInsights.calculatePresenceBreakdown(80, 15, 5);
      expect(breakdown.watchingPct).toBe(80);
      expect(breakdown.absentPct).toBe(15);
      expect(breakdown.degradedPct).toBe(5);
      expect(breakdown.watchingPct + breakdown.absentPct + breakdown.degradedPct).toBe(100);
      expect(breakdown.totalSec).toBe(100);
    });

    it('handles zero total seconds gracefully in presence breakdown', () => {
      const breakdown = SessionInsights.calculatePresenceBreakdown(0, 0, 0);
      expect(breakdown.watchingPct).toBe(100);
      expect(breakdown.absentPct).toBe(0);
      expect(breakdown.degradedPct).toBe(0);
    });
  });

  describe('Break Scheduling (FR-12) & Playback Progression', () => {
    it('triggers break reminder only when playback reaches or passes scheduled offset', () => {
      expect(SessionInsights.shouldTriggerBreakReminder(599, 600, false)).toBe(false);
      expect(SessionInsights.shouldTriggerBreakReminder(600, 600, false)).toBe(true);
      expect(SessionInsights.shouldTriggerBreakReminder(650, 600, false)).toBe(true);
    });

    it('does not trigger break reminder if already triggered or break is unset', () => {
      expect(SessionInsights.shouldTriggerBreakReminder(700, 600, true)).toBe(false);
      expect(SessionInsights.shouldTriggerBreakReminder(700, null, false)).toBe(false);
      expect(SessionInsights.shouldTriggerBreakReminder(700, 0, false)).toBe(false);
    });

    it('advances sequential replay to next clip or stops at queue end', () => {
      expect(SessionInsights.advanceToNextClip(0, 3, true)).toBe(1);
      expect(SessionInsights.advanceToNextClip(1, 3, true)).toBe(2);
      expect(SessionInsights.advanceToNextClip(2, 3, true)).toBeNull();
      expect(SessionInsights.advanceToNextClip(0, 3, false)).toBeNull();
    });

    it('calculates clip progress bounded between 0% and 100%', () => {
      expect(SessionInsights.calculateClipProgress(10, 10, 30)).toBe(0);
      expect(SessionInsights.calculateClipProgress(20, 10, 30)).toBe(50);
      expect(SessionInsights.calculateClipProgress(30, 10, 30)).toBe(100);
      expect(SessionInsights.calculateClipProgress(5, 10, 30)).toBe(0);
      expect(SessionInsights.calculateClipProgress(40, 10, 30)).toBe(100);
    });
  });

  describe('Token Parsing & Media Resolution Helpers', () => {
    it('parses timestamp tokens to seconds', () => {
      expect(SessionInsights.parseTimestampTokenToSec('0:45')).toBe(45);
      expect(SessionInsights.parseTimestampTokenToSec('12:30')).toBe(750);
      expect(SessionInsights.parseTimestampTokenToSec('01:10:05')).toBe(4205);
      expect(SessionInsights.parseTimestampTokenToSec('invalid')).toBe(0);
      expect(SessionInsights.parseTimestampTokenToSec('')).toBe(0);
    });

    it('extracts YouTube video IDs from various formats', () => {
      expect(SessionInsights.extractYouTubeId('https://www.youtube.com/watch?v=kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(SessionInsights.extractYouTubeId('https://youtu.be/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(SessionInsights.extractYouTubeId('https://www.youtube.com/embed/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(SessionInsights.extractYouTubeId('https://www.youtube.com/shorts/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(SessionInsights.extractYouTubeId('https://example.com/video.mp4')).toBeNull();
      expect(SessionInsights.extractYouTubeId('')).toBeNull();
    });

    it('resolves local file paths to local-video:// streaming URLs', () => {
      const localSource: VideoSource = {
        type: 'local',
        pathOrUrl: '/Users/apple/Desktop/lecture.mp4',
        name: 'lecture.mp4',
        duration: 120
      };
      const res = SessionInsights.resolveReplayMediaSrc(localSource);
      expect(res).toBe('local-video://media?path=%2FUsers%2Fapple%2FDesktop%2Flecture.mp4');
    });

    it('preserves web URLs and blob URLs', () => {
      const webSource: VideoSource = {
        type: 'url',
        pathOrUrl: 'https://example.com/stream.m3u8',
        name: 'Web Stream',
        duration: 120
      };
      expect(SessionInsights.resolveReplayMediaSrc(webSource)).toBe('https://example.com/stream.m3u8');
    });

    it('toggles reviewed clip IDs cleanly', () => {
      let list: string[] = [];
      list = SessionInsights.toggleReviewedId(list, 'clip-1');
      expect(list).toEqual(['clip-1']);
      list = SessionInsights.toggleReviewedId(list, 'clip-2');
      expect(list).toEqual(['clip-1', 'clip-2']);
      list = SessionInsights.toggleReviewedId(list, 'clip-1');
      expect(list).toEqual(['clip-2']);
    });
  });
});
