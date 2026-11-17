import * as fs from 'fs';
import * as path from 'path';
import { ChapterInfo } from '@shared/types';

/**
 * Parses time string like "01:23:45.678" or "12:34.500" into seconds
 */
export function parseTimestampToSeconds(timeStr: string): number {
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2].replace(',', '.'));
    return hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1].replace(',', '.'));
    return minutes * 60 + seconds;
  }
  return parseFloat(timeStr) || 0;
}

/**
 * Parses WebVTT chapter format
 */
export function parseWebVTTChapters(vttContent: string): ChapterInfo[] {
  const chapters: ChapterInfo[] = [];
  const lines = vttContent.split(/\r?\n/);
  const timeRegex = /((?:\d{2}:)?\d{2}:\d{2}[\.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[\.,]\d{3})/;

  let currentStart = 0;
  let currentEnd = 0;
  let expectingTitle = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('WEBVTT') || line.startsWith('NOTE')) {
      continue;
    }

    const match = line.match(timeRegex);
    if (match) {
      currentStart = parseTimestampToSeconds(match[1]);
      currentEnd = parseTimestampToSeconds(match[2]);
      expectingTitle = true;
      continue;
    }

    if (expectingTitle) {
      chapters.push({
        title: line,
        start: currentStart,
        end: currentEnd
      });
      expectingTitle = false;
    }
  }

  return chapters;
}

/**
 * Parses chapters from sidecar files (.vtt, .json) or returns empty list (FR-8)
 */
export async function parseChaptersForVideo(videoFilePath: string): Promise<ChapterInfo[]> {
  try {
    const parsedPath = path.parse(videoFilePath);
    const dir = parsedPath.dir;
    const baseName = parsedPath.name;

    // Check potential sidecar files
    const candidates = [
      path.join(dir, `${baseName}.vtt`),
      path.join(dir, `${baseName}.chapters.vtt`),
      path.join(dir, `${baseName}.json`),
      path.join(dir, `${baseName}.chapters.json`)
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const content = await fs.promises.readFile(candidate, 'utf-8');
        if (candidate.endsWith('.vtt')) {
          const chapters = parseWebVTTChapters(content);
          if (chapters.length > 0) return chapters;
        } else if (candidate.endsWith('.json')) {
          try {
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
              return data.map((item: any) => ({
                title: String(item.title || item.name || 'Chapter'),
                start: Number(item.start || 0),
                end: Number(item.end || item.start + 60)
              }));
            }
          } catch {
            // Ignore corrupted JSON
          }
        }
      }
    }
  } catch {
    // Graceful fallback when sidecars are not accessible
  }

  return [];
}
