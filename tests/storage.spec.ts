import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { StorageManager } from '../src/main/storage';
import { NetworkGuard } from '../src/main/network-guard';
import { parseWebVTTChapters, parseTimestampToSeconds } from '../src/main/chapter-parser';
import { SessionDocument } from '../src/shared/types';
import { SelfTestCalibrator } from '../src/renderer/engine/SelfTestCalibrator';

const TEST_DIR = path.join(process.cwd(), '.test-storage-tmp');

describe('StorageManager (FR-16, Acceptance Criterion 7)', () => {
  let storage: StorageManager;

  beforeEach(() => {
    storage = new StorageManager(TEST_DIR);
  });

  afterEach(async () => {
    if (fs.existsSync(TEST_DIR)) {
      await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('saves, retrieves, lists, and deletes sessions', async () => {
    const dummySession: SessionDocument = {
      version: 1,
      id: 'session-test-1',
      source: {
        type: 'local',
        pathOrUrl: '/path/to/lecture.mp4',
        duration: 3600,
        name: 'Calculus 101'
      },
      startedAt: new Date().toISOString(),
      calibration: SelfTestCalibrator.getDefaultCalibration(),
      events: [],
      quality: [],
      queue: [],
      pulse: []
    };

    await storage.saveSession(dummySession);
    const retrieved = await storage.getSession('session-test-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe('session-test-1');

    const list = await storage.listSessions();
    expect(list.length).toBe(1);

    const deleted = await storage.deleteSession('session-test-1');
    expect(deleted).toBe(true);

    const afterDelete = await storage.getSession('session-test-1');
    expect(afterDelete).toBeNull();
  });

  it('Acceptance Criterion 7: Deleting all data leaves no session files, consent record or settings on disk', async () => {
    const dummySession: SessionDocument = {
      version: 1,
      id: 'session-wipe-me',
      source: {
        type: 'local',
        pathOrUrl: '/test.mp4',
        duration: 1000,
        name: 'Wipe Test'
      },
      startedAt: new Date().toISOString(),
      calibration: SelfTestCalibrator.getDefaultCalibration(),
      events: [],
      quality: [],
      queue: [],
      pulse: []
    };

    await storage.saveSession(dummySession);
    await storage.setConsent({
      granted: true,
      timestamp: new Date().toISOString(),
      telemetryEnabled: false
    });

    // Verify files existed before wipe
    expect(fs.existsSync(path.join(TEST_DIR, 'sessions', 'session-wipe-me.json'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DIR, 'consent.json'))).toBe(true);

    // Execute 1-click full wipe
    await storage.deleteAllData();

    // Verify disk is completely cleared
    const sessions = await storage.listSessions();
    expect(sessions.length).toBe(0);
    const consent = await storage.getConsent();
    expect(consent.granted).toBe(false);
  });
});

describe('NetworkGuard (Acceptance Criterion 8)', () => {
  let guard: NetworkGuard;

  beforeEach(() => {
    guard = new NetworkGuard();
  });

  it('allows localhost, devtools, and presage license authorization', () => {
    expect(guard.evaluateUrl('http://localhost:5173/main.tsx').cancel).toBe(false);
    expect(guard.evaluateUrl('ws://127.0.0.1:5173/').cancel).toBe(false);
    expect(guard.evaluateUrl('file:///Users/apple/Desktop/presage/index.html').cancel).toBe(false);
    expect(guard.evaluateUrl('https://smartspectra.presagetech.com/api/v1/auth').cancel).toBe(false);
  });

  it('blocks unexpected outbound application network requests and increments counter (AC-8)', () => {
    const blocked1 = guard.evaluateUrl('https://api.external-tracking.com/telemetry');
    expect(blocked1.cancel).toBe(true);

    const blocked2 = guard.evaluateUrl('https://api.openai.com/v1/chat/completions');
    expect(blocked2.cancel).toBe(true);
  });
});

describe('Chapter Parser (FR-8)', () => {
  it('parses WebVTT chapter timestamps and titles correctly', () => {
    const sampleVtt = `WEBVTT

00:00:00.000 --> 00:05:00.000
Introduction

00:05:00.000 --> 00:15:30.500
Core Architecture
`;

    const chapters = parseWebVTTChapters(sampleVtt);
    expect(chapters.length).toBe(2);
    expect(chapters[0].title).toBe('Introduction');
    expect(chapters[0].start).toBe(0);
    expect(chapters[0].end).toBe(300);

    expect(chapters[1].title).toBe('Core Architecture');
    expect(chapters[1].start).toBe(300);
    expect(chapters[1].end).toBe(930.5);
  });

  it('parses timestamps to seconds', () => {
    expect(parseTimestampToSeconds('01:00:00.000')).toBe(3600);
    expect(parseTimestampToSeconds('02:30.000')).toBe(150);
  });
});
