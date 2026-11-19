import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseTimestampToSeconds,
  parseWebVTTChapters,
  parseChaptersForVideo
} from '../src/main/chapter-parser';

describe('Chapter Parser (FR-8 & Sidecar Detection)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-chapters-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('parseTimestampToSeconds', () => {
    it('parses HH:MM:SS.mmm format accurately', () => {
      expect(parseTimestampToSeconds('01:23:45.678')).toBeCloseTo(5025.678, 3);
      expect(parseTimestampToSeconds('00:01:30.000')).toBe(90);
    });

    it('parses MM:SS.mmm format accurately', () => {
      expect(parseTimestampToSeconds('12:34.500')).toBeCloseTo(754.5, 3);
      expect(parseTimestampToSeconds('05:00.000')).toBe(300);
    });

    it('handles comma millisecond separator (standard WebVTT format)', () => {
      expect(parseTimestampToSeconds('00:02:15,400')).toBeCloseTo(135.4, 3);
      expect(parseTimestampToSeconds('01:00:00,500')).toBeCloseTo(3600.5, 3);
    });

    it('handles simple MM:SS without milliseconds', () => {
      expect(parseTimestampToSeconds('04:20')).toBe(260);
      expect(parseTimestampToSeconds('10:00')).toBe(600);
    });

    it('handles direct numeric strings and fallback values', () => {
      expect(parseTimestampToSeconds('123.45')).toBe(123.45);
      expect(parseTimestampToSeconds('0')).toBe(0);
      expect(parseTimestampToSeconds('invalid')).toBe(0);
      expect(parseTimestampToSeconds('')).toBe(0);
    });
  });

  describe('parseWebVTTChapters', () => {
    it('parses standard WebVTT chapters with arrow cues and headers', () => {
      const vtt = `WEBVTT - Lecture Chapters

00:00:00.000 --> 00:02:15.000
Introduction and Overview

00:02:15.000 --> 00:07:45.500
Core Architecture

00:07:45.500 --> 00:15:00.000
Deep Learning Pipeline`;

      const chapters = parseWebVTTChapters(vtt);
      expect(chapters.length).toBe(3);
      expect(chapters[0]).toEqual({
        title: 'Introduction and Overview',
        start: 0,
        end: 135
      });
      expect(chapters[1].title).toBe('Core Architecture');
      expect(chapters[1].start).toBe(135);
      expect(chapters[1].end).toBeCloseTo(465.5, 1);
      expect(chapters[2].title).toBe('Deep Learning Pipeline');
      expect(chapters[2].start).toBeCloseTo(465.5, 1);
      expect(chapters[2].end).toBe(900);
    });

    it('parses cues without hour components (MM:SS.mmm)', () => {
      const vtt = `WEBVTT

01:10.000 --> 03:25.000
Short Format Chapter 1

03:25.000 --> 08:00.000
Short Format Chapter 2`;

      const chapters = parseWebVTTChapters(vtt);
      expect(chapters.length).toBe(2);
      expect(chapters[0].start).toBe(70);
      expect(chapters[0].end).toBe(205);
      expect(chapters[0].title).toBe('Short Format Chapter 1');
    });

    it('ignores NOTE comment blocks and empty lines', () => {
      const vtt = `WEBVTT

NOTE This is a sidecar comment that should be skipped

00:00:05.000 --> 00:01:00.000
Valid Chapter

NOTE Another comment block
`;

      const chapters = parseWebVTTChapters(vtt);
      expect(chapters.length).toBe(1);
      expect(chapters[0].title).toBe('Valid Chapter');
      expect(chapters[0].start).toBe(5);
      expect(chapters[0].end).toBe(60);
    });

    it('handles Windows CRLF newlines properly', () => {
      const vtt = 'WEBVTT\r\n\r\n00:00:00.000 --> 00:01:00.000\r\nCRLF Chapter\r\n';
      const chapters = parseWebVTTChapters(vtt);
      expect(chapters.length).toBe(1);
      expect(chapters[0].title).toBe('CRLF Chapter');
    });

    it('returns empty array when content has no valid cues', () => {
      expect(parseWebVTTChapters('')).toEqual([]);
      expect(parseWebVTTChapters('WEBVTT\nJust a header with no cues')).toEqual([]);
    });
  });

  describe('parseChaptersForVideo (Sidecar Resolution)', () => {
    it('discovers and loads [basename].vtt sidecar file', async () => {
      const videoPath = path.join(tempDir, 'physics-lecture.mp4');
      const sidecarVtt = path.join(tempDir, 'physics-lecture.vtt');
      fs.writeFileSync(videoPath, 'fake-video-content');
      fs.writeFileSync(
        sidecarVtt,
        `WEBVTT\n\n00:00:00.000 --> 00:10:00.000\nQuantum Mechanics Intro`
      );

      const chapters = await parseChaptersForVideo(videoPath);
      expect(chapters.length).toBe(1);
      expect(chapters[0].title).toBe('Quantum Mechanics Intro');
      expect(chapters[0].end).toBe(600);
    });

    it('discovers and loads [basename].chapters.vtt sidecar file', async () => {
      const videoPath = path.join(tempDir, 'chem-lecture.mp4');
      const sidecarVtt = path.join(tempDir, 'chem-lecture.chapters.vtt');
      fs.writeFileSync(videoPath, 'fake-video-content');
      fs.writeFileSync(
        sidecarVtt,
        `WEBVTT\n\n00:00:00.000 --> 00:05:00.000\nOrganic Synthesis`
      );

      const chapters = await parseChaptersForVideo(videoPath);
      expect(chapters.length).toBe(1);
      expect(chapters[0].title).toBe('Organic Synthesis');
    });

    it('discovers and loads [basename].json sidecar file', async () => {
      const videoPath = path.join(tempDir, 'math-lecture.mp4');
      const sidecarJson = path.join(tempDir, 'math-lecture.json');
      fs.writeFileSync(videoPath, 'fake-video-content');
      fs.writeFileSync(
        sidecarJson,
        JSON.stringify([
          { title: 'Linear Algebra', start: 0, end: 300 },
          { name: 'Eigenvalues', start: 300, end: 600 }
        ])
      );

      const chapters = await parseChaptersForVideo(videoPath);
      expect(chapters.length).toBe(2);
      expect(chapters[0].title).toBe('Linear Algebra');
      expect(chapters[1].title).toBe('Eigenvalues');
    });

    it('discovers and loads [basename].chapters.json sidecar file', async () => {
      const videoPath = path.join(tempDir, 'bio-lecture.mp4');
      const sidecarJson = path.join(tempDir, 'bio-lecture.chapters.json');
      fs.writeFileSync(videoPath, 'fake-video-content');
      fs.writeFileSync(
        sidecarJson,
        JSON.stringify([{ title: 'Cell Biology', start: 10, end: 200 }])
      );

      const chapters = await parseChaptersForVideo(videoPath);
      expect(chapters.length).toBe(1);
      expect(chapters[0].title).toBe('Cell Biology');
    });

    it('returns empty array when no sidecar file exists', async () => {
      const videoPath = path.join(tempDir, 'no-sidecar.mp4');
      fs.writeFileSync(videoPath, 'fake-video-content');

      const chapters = await parseChaptersForVideo(videoPath);
      expect(chapters).toEqual([]);
    });

    it('gracefully handles corrupted JSON sidecar without throwing', async () => {
      const videoPath = path.join(tempDir, 'corrupt.mp4');
      const sidecarJson = path.join(tempDir, 'corrupt.json');
      fs.writeFileSync(videoPath, 'fake-video-content');
      fs.writeFileSync(sidecarJson, '{ bad json: true,');

      const chapters = await parseChaptersForVideo(videoPath);
      expect(chapters).toEqual([]);
    });
  });
});
