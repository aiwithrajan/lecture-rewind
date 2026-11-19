import { DetectionEvent, SessionDocument, VideoSource } from '@shared/types';

export interface SourceInsight {
  source: VideoSource;
  sessionCount: number;
  typicalOffsetSec: number;
}

export interface PresenceBreakdown {
  watchingPct: number;
  absentPct: number;
  degradedPct: number;
  totalSec: number;
}

export class SessionInsights {
  /**
   * FR-12 Session History:
   * When 3 or more sessions of the same video/lecture exist,
   * report typical absence offset (median start of absence pauses and brief markers)
   * and offer to schedule a break there.
   */
  public static calculateSourceInsights(sessions: SessionDocument[]): SourceInsight[] {
    const groups: Record<string, { source: VideoSource; sessions: SessionDocument[] }> = {};

    for (const s of sessions) {
      if (!s.source) continue;
      const key = s.source.pathOrUrl || s.source.name;
      if (!key) continue;
      if (!groups[key]) {
        groups[key] = { source: s.source, sessions: [] };
      }
      groups[key].sessions.push(s);
    }

    const insights: SourceInsight[] = [];

    for (const group of Object.values(groups)) {
      if (group.sessions.length >= 3) {
        const absenceTimes: number[] = [];
        for (const s of group.sessions) {
          for (const ev of s.events || []) {
            if (ev.type === 'pause' || ev.type === 'marker') {
              absenceTimes.push(ev.start);
            }
          }
        }

        if (absenceTimes.length > 0) {
          absenceTimes.sort((a, b) => a - b);
          const median = absenceTimes[Math.floor(absenceTimes.length / 2)];
          insights.push({
            source: group.source,
            sessionCount: group.sessions.length,
            typicalOffsetSec: Math.round(median)
          });
        }
      }
    }

    return insights;
  }

  /**
   * Generates SVG path coordinates for the rPPG pulse context curve (FR-15).
   * Maps time -> X [0, 1000] and BPM [40, 110] -> Y [34, 4].
   */
  public static calculatePulseSvgPath(
    pulse: Array<{ timestamp: number; value: number }>,
    durationSec: number
  ): string {
    if (!pulse || pulse.length === 0 || durationSec <= 0) {
      return '';
    }

    return pulse
      .map((p, idx) => {
        const x = Math.min(1000, Math.max(0, (p.timestamp / durationSec) * 1000));
        const y = Math.min(34, Math.max(4, 34 - ((p.value - 40) / 70) * 30));
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  }

  /**
   * Calculates normalized percentages for the presence breakdown ring.
   */
  public static calculatePresenceBreakdown(
    watchingSec: number,
    absentSec: number,
    degradedSec: number
  ): PresenceBreakdown {
    const safeWatching = Math.max(0, watchingSec || 0);
    const safeAbsent = Math.max(0, absentSec || 0);
    const safeDegraded = Math.max(0, degradedSec || 0);
    const totalSec = safeWatching + safeAbsent + safeDegraded;

    if (totalSec <= 0) {
      return { watchingPct: 100, absentPct: 0, degradedPct: 0, totalSec: 0 };
    }

    const watchingPct = Math.round((safeWatching / totalSec) * 100);
    const absentPct = Math.round((safeAbsent / totalSec) * 100);
    const degradedPct = Math.max(0, 100 - watchingPct - absentPct);

    return {
      watchingPct,
      absentPct,
      degradedPct,
      totalSec: Math.round(totalSec)
    };
  }

  /**
   * FR-12: Determines if a scheduled break reminder should trigger.
   */
  public static shouldTriggerBreakReminder(
    currentTimeSec: number,
    scheduledBreakSec: number | null | undefined,
    alreadyTriggered: boolean
  ): boolean {
    if (alreadyTriggered) return false;
    if (!scheduledBreakSec || scheduledBreakSec <= 0) return false;
    return currentTimeSec >= scheduledBreakSec;
  }

  /**
   * Advances sequentially to the next clip in a queue.
   */
  public static advanceToNextClip(
    currentIndex: number,
    totalClips: number,
    isSequential: boolean
  ): number | null {
    if (!isSequential) return null;
    const next = currentIndex + 1;
    if (next < totalClips) {
      return next;
    }
    return null;
  }

  /**
   * Calculates 0% to 100% progress for a playback clip.
   */
  public static calculateClipProgress(
    currentTime: number,
    clipStart: number,
    clipEnd: number
  ): number {
    const span = Math.max(0.1, clipEnd - clipStart);
    const prog = ((currentTime - clipStart) / span) * 100;
    return Math.max(0, Math.min(100, Math.round(prog * 10) / 10));
  }

  /**
   * Parses MM:SS or HH:MM:SS text token into seconds.
   */
  public static parseTimestampTokenToSec(token: string): number {
    if (!token) return 0;
    const parts = token.trim().split(':').map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
  }

  /**
   * Extracts clean YouTube ID from various YouTube URL formats.
   */
  public static extractYouTubeId(rawUrl: string): string | null {
    if (!rawUrl) return null;
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();
      if (host === 'youtu.be') {
        const id = parsed.pathname.replace(/^\//, '').split('/')[0];
        return id && id.length >= 6 ? id : null;
      }
      if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) {
        const v = parsed.searchParams.get('v');
        if (v && v.length >= 6) return v;
        const parts = parsed.pathname.split('/').filter(Boolean);
        if ((parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') && parts[1]) {
          return parts[1];
        }
      }
    } catch {
      // Not a standard URL
    }
    return null;
  }

  /**
   * Resolves replay media source URL for local Electron videos and web URLs.
   */
  public static resolveReplayMediaSrc(source: VideoSource): string {
    const raw = source.pathOrUrl;
    if (!raw) return '';
    if (
      raw.startsWith('http://') ||
      raw.startsWith('https://') ||
      raw.startsWith('blob:') ||
      raw.startsWith('local-video:') ||
      raw.startsWith('file://')
    ) {
      return raw;
    }
    if (source.type === 'local' && (raw.startsWith('/') || /^[A-Za-z]:\\/.test(raw))) {
      return `local-video://media?path=${encodeURIComponent(raw)}`;
    }
    return raw;
  }

  /**
   * Toggles item in reviewed list without side effects.
   */
  public static toggleReviewedId(reviewedList: string[], id: string): string[] {
    if (reviewedList.includes(id)) {
      return reviewedList.filter((item) => item !== id);
    }
    return [...reviewedList, id];
  }
}
