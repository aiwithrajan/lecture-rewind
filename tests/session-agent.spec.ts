import { describe, it, expect, beforeEach } from 'vitest';
import {
  SessionReviewAgent,
  formatTimestamp,
  formatDurationHuman,
  extractYouTubeVideoId,
  decodeHtmlEntities,
  parseYouTubeTimedTextXml,
  sliceTranscriptExcerpt
} from '../src/main/session-agent';
import { SessionDocument, SessionMetrics, VideoSource } from '../src/shared/types';

function makeAgentSession(
  partial: Omit<Partial<SessionDocument>, 'metrics'> & {
    id: string;
    source: VideoSource;
    metrics?: Partial<SessionMetrics>;
  }
): SessionDocument {
  return {
    version: 1,
    startedAt: '2026-11-19T10:00:00.000Z',
    calibration: {
      completedAt: '2026-11-19T10:00:00.000Z',
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
    events: [],
    quality: [],
    queue: [],
    pulse: [],
    ...partial,
    metrics: partial.metrics
      ? {
          watchingDurationSec: 0,
          absentDurationSec: 0,
          degradedDurationSec: 0,
          totalBlinks: 0,
          furthestVideoTimeSec: 0,
          stateTimeline: [],
          ...partial.metrics
        }
      : undefined
  };
}

describe('SessionReviewAgent & Text/Caption Pipeline', () => {
  let agent: SessionReviewAgent;

  beforeEach(() => {
    agent = new SessionReviewAgent();
  });

  describe('Formatting & Sanitization Utilities', () => {
    it('formatTimestamp produces clean MM:SS and H:MM:SS strings', () => {
      expect(formatTimestamp(0)).toBe('0:00');
      expect(formatTimestamp(9)).toBe('0:09');
      expect(formatTimestamp(45)).toBe('0:45');
      expect(formatTimestamp(125)).toBe('2:05');
      expect(formatTimestamp(3600)).toBe('1:00:00');
      expect(formatTimestamp(3665)).toBe('1:01:05');
      expect(formatTimestamp(-10)).toBe('0:00');
    });

    it('formatDurationHuman produces clean duration strings', () => {
      expect(formatDurationHuman(0)).toBe('0s');
      expect(formatDurationHuman(45)).toBe('45s');
      expect(formatDurationHuman(60)).toBe('1m');
      expect(formatDurationHuman(125)).toBe('2m 5s');
      expect(formatDurationHuman(3600)).toBe('60m');
    });

    it('extractYouTubeVideoId correctly parses video IDs from various URL formats', () => {
      expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(extractYouTubeVideoId('https://youtu.be/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(extractYouTubeVideoId('https://www.youtube.com/embed/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(extractYouTubeVideoId('https://www.youtube.com/shorts/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(extractYouTubeVideoId('https://youtube-nocookie.com/embed/kJQP7kiw5Fk')).toBe('kJQP7kiw5Fk');
      expect(extractYouTubeVideoId('https://example.com/video.mp4')).toBeNull();
      expect(extractYouTubeVideoId('')).toBeNull();
    });

    it('decodeHtmlEntities decodes XML/HTML entities and strips HTML markup', () => {
      const raw = '<b>Quantum</b> &amp; Relativity &#39;lecture&#39; &quot;Part 1&quot;';
      const clean = decodeHtmlEntities(raw);
      expect(clean).toBe('Quantum & Relativity \'lecture\' "Part 1"');
    });

    it('parseYouTubeTimedTextXml parses Format 3 and legacy XML caption tracks', () => {
      const format3Xml = `<?xml version="1.0" encoding="utf-8" ?>
<timedtext format="3">
  <body>
    <p t="1000" d="2500">Hello students, welcome to CS101.</p>
    <p t="3500" d="3000">Today we discuss &lt;b&gt;binary trees&lt;/b&gt;.</p>
  </body>
</timedtext>`;

      const cues = parseYouTubeTimedTextXml(format3Xml);
      expect(cues.length).toBe(2);
      expect(cues[0].startSec).toBe(1.0);
      expect(cues[0].endSec).toBe(3.5);
      expect(cues[0].text).toBe('Hello students, welcome to CS101.');
      expect(cues[1].text).toBe('Today we discuss binary trees.');

      const legacyXml = `<transcript>
  <text start="10.5" dur="4.2">Now let us inspect recursion.</text>
</transcript>`;
      const legacyCues = parseYouTubeTimedTextXml(legacyXml);
      expect(legacyCues.length).toBe(1);
      expect(legacyCues[0].startSec).toBe(10.5);
      expect(legacyCues[0].text).toBe('Now let us inspect recursion.');
    });

    it('sliceTranscriptExcerpt extracts matching cues in time window', () => {
      const cues = [
        { startSec: 10, endSec: 15, text: 'First topic on sorting.' },
        { startSec: 50, endSec: 60, text: 'Second topic on heaps.' },
        { startSec: 120, endSec: 130, text: 'Third topic on graphs.' }
      ];

      const excerpt = sliceTranscriptExcerpt(cues, 50, 60);
      expect(excerpt).toBe('Second topic on heaps.');

      const missing = sliceTranscriptExcerpt(cues, 300, 310);
      expect(missing).toBeUndefined();
    });
  });

  describe('SessionReviewAgent Status & Deterministic Offline Engine', () => {
    it('getStatus returns environment configuration without throwing', async () => {
      const status = await agent.getStatus();
      expect(typeof status.geminiConfigured).toBe('boolean');
      expect(typeof status.ollamaAvailable).toBe('boolean');
      expect(Array.isArray(status.ollamaModels)).toBe(true);
      expect(typeof status.defaultOllamaModel).toBe('string');
    });

    it('query with engine: "offline" produces instant deterministic analysis in English', async () => {
      const mockSession: SessionDocument = makeAgentSession({
        id: 'session-unit-test-1',
        source: {
          type: 'local',
          pathOrUrl: '/videos/algorithm-lecture.mp4',
          name: 'algorithm-lecture.mp4',
          duration: 300
        },
        endedAt: '2026-11-19T10:05:00.000Z',
        metrics: {
          watchingDurationSec: 240,
          absentDurationSec: 45,
          degradedDurationSec: 15,
          totalBlinks: 32,
          furthestVideoTimeSec: 285
        },
        events: [
          {
            id: 'ev-1',
            type: 'pause',
            start: 60,
            end: 90,
            evidence: ['A', 'B'],
            confidence: 0.95,
            note: 'Physical absence detected'
          },
          {
            id: 'ev-2',
            type: 'bookmark',
            start: 180,
            end: 180,
            evidence: ['F'],
            confidence: 1.0,
            note: 'Intentional double-blink'
          }
        ],
        queue: [
          {
            id: 'q-1',
            start: 50,
            end: 90,
            duration: 40,
            chapterTitle: 'Graph Search',
            sourceEventIds: ['ev-1']
          }
        ]
      });

      const res = await agent.query({
        session: mockSession,
        engine: 'offline',
        language: 'english'
      });

      expect(res.providerUsed).toBe('offline');
      expect(res.modelUsed).toContain('Instant Offline Engine');
      expect(res.answer).toContain('algorithm-lecture.mp4');
      expect(res.answer).toContain('Watching Time:');
      expect(res.answer).toContain('4m');
      expect(res.answer).toContain('**Total Blinks:** 32');
      expect(res.answer).toContain('1:00 – 1:30');
      expect(res.answer).toContain('PAUSE');
      expect(res.answer).toContain('BOOKMARK');
      expect(res.answer).toContain('Recommended Rewatch Plan:');
      expect(res.answer).toContain('Graph Search');
    });

    it('query with engine: "offline" produces clean Hinglish output', async () => {
      const mockSession: SessionDocument = makeAgentSession({
        id: 'session-unit-test-2',
        source: {
          type: 'url',
          pathOrUrl: 'https://youtube.com/watch?v=test1234567',
          name: 'Operating Systems Lecture',
          duration: 120
        },
        endedAt: '2026-11-19T10:02:00.000Z',
        metrics: {
          watchingDurationSec: 120,
          absentDurationSec: 0,
          degradedDurationSec: 0,
          totalBlinks: 18,
          furthestVideoTimeSec: 120
        },
        events: [],
        queue: []
      });

      const res = await agent.query({
        session: mockSession,
        engine: 'offline',
        language: 'hinglish'
      });

      expect(res.providerUsed).toBe('offline');
      expect(res.answer).toContain('Session Summary:');
      expect(res.answer).toContain('Watching Time:');
      expect(res.answer).toContain('Koi missed interval detect nahi hua');
    });

    it('handles clean session with no missed events in English', async () => {
      const cleanSession: SessionDocument = makeAgentSession({
        id: 'session-unit-test-3',
        source: {
          type: 'local',
          pathOrUrl: '/videos/clean.mp4',
          name: 'clean.mp4',
          duration: 60
        },
        events: [],
        queue: []
      });

      const res = await agent.query({
        session: cleanSession,
        engine: 'offline',
        language: 'english'
      });

      expect(res.answer).toContain('No missed intervals detected.');
    });

    it('acknowledges custom user questions in offline fallback mode', async () => {
      const session: SessionDocument = makeAgentSession({
        id: 'session-unit-test-4',
        source: {
          type: 'local',
          pathOrUrl: '/videos/test.mp4',
          name: 'test.mp4',
          duration: 60
        },
        events: []
      });

      const res = await agent.query({
        session,
        engine: 'offline',
        language: 'hinglish',
        question: 'Main kitni der offline raha?'
      });

      expect(res.answer).toContain('Main kitni der offline raha?');
    });

    it('STRICT Section 12 Compliance: generated answers contain zero prohibited terms', async () => {
      const sampleSession: SessionDocument = makeAgentSession({
        id: 'session-unit-test-compliance',
        source: {
          type: 'local',
          pathOrUrl: '/videos/lecture.mp4',
          name: 'compliance-test.mp4',
          duration: 180
        },
        metrics: {
          watchingDurationSec: 150,
          absentDurationSec: 30,
          degradedDurationSec: 0,
          totalBlinks: 14,
          furthestVideoTimeSec: 180
        },
        events: [
          {
            id: 'ev-1',
            type: 'pause',
            start: 30,
            end: 60,
            evidence: ['A', 'B'],
            confidence: 0.9
          }
        ],
        queue: [
          {
            id: 'q-1',
            start: 20,
            end: 60,
            duration: 40,
            sourceEventIds: ['ev-1']
          }
        ]
      });

      const enRes = await agent.query({ session: sampleSession, engine: 'offline', language: 'english' });
      const hiRes = await agent.query({ session: sampleSession, engine: 'offline', language: 'hinglish' });

      const prohibited = ['sleep', 'drowsiness', 'fatigue', 'stress', 'focus', 'attention'];
      for (const term of prohibited) {
        const regex = new RegExp(`\\b${term}\\b`, 'i');
        expect(regex.test(enRes.answer)).toBe(false);
        expect(regex.test(hiRes.answer)).toBe(false);
      }
    });
  });
});
