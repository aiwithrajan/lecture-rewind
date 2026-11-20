import {
  AgentRequest,
  AgentResponse,
  AgentStatus,
  ChapterInfo,
  ConsentRecord,
  NetworkGuardStats,
  SessionDocument
} from '@shared/types';
import { SessionInsights } from './engine/SessionInsights';

/**
 * Browser polyfill for window.rewindApi when running as a standalone web app
 * (e.g. deployed to Vercel, Netlify, or running in a standard web browser).
 * Backs sessions and consent with local browser localStorage.
 */
if (typeof window !== 'undefined' && !(window as any).rewindApi) {
  const SESSIONS_STORAGE_KEY = 'lecture_rewind_sessions_v1';
  const CONSENT_STORAGE_KEY = 'lecture_rewind_consent_v1';

  const getStoredSessions = (): SessionDocument[] => {
    try {
      const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const saveStoredSessions = (sessions: SessionDocument[]) => {
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      // Ignore quota errors
    }
  };

  (window as any).rewindApi = {
    sessions: {
      list: async (): Promise<SessionDocument[]> => {
        return getStoredSessions();
      },
      get: async (id: string): Promise<SessionDocument | null> => {
        const list = getStoredSessions();
        return list.find((s) => s.id === id) || null;
      },
      save: async (doc: SessionDocument): Promise<void> => {
        const list = getStoredSessions();
        const existingIdx = list.findIndex((s) => s.id === doc.id);
        if (existingIdx >= 0) {
          list[existingIdx] = doc;
        } else {
          list.unshift(doc);
        }
        saveStoredSessions(list);
      },
      delete: async (id: string): Promise<boolean> => {
        const list = getStoredSessions();
        const filtered = list.filter((s) => s.id !== id);
        saveStoredSessions(filtered);
        return true;
      },
      deleteAllData: async (): Promise<boolean> => {
        try {
          localStorage.removeItem(SESSIONS_STORAGE_KEY);
          localStorage.removeItem(CONSENT_STORAGE_KEY);
          return true;
        } catch {
          return false;
        }
      }
    },
    consent: {
      get: async (): Promise<ConsentRecord> => {
        try {
          const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
          if (raw) return JSON.parse(raw);
        } catch {
          // Fallback
        }
        return {
          granted: true,
          timestamp: new Date().toISOString(),
          telemetryEnabled: false
        };
      },
      set: async (consent: ConsentRecord): Promise<void> => {
        try {
          localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
        } catch {
          // Ignore
        }
      }
    },
    network: {
      getStats: async (): Promise<NetworkGuardStats> => {
        return {
          blockedRequestsCount: 0,
          allowedRequestsCount: 0,
          applicationNetworkRequestsCount: 0,
          log: []
        };
      }
    },
    chapters: {
      parse: async (_filePath: string): Promise<ChapterInfo[]> => {
        return [];
      }
    },
    agent: {
      getStatus: async (): Promise<AgentStatus> => {
        return {
          geminiConfigured: false,
          ollamaAvailable: false,
          ollamaModels: [],
          defaultOllamaModel: 'Instant Offline Engine (0.0s)'
        };
      },
      query: async (req: AgentRequest): Promise<AgentResponse> => {
        const m = req.session.metrics;
        const watching = Math.round(m?.watchingDurationSec || 0);
        const absent = Math.round(m?.absentDurationSec || 0);
        const degraded = Math.round(m?.degradedDurationSec || 0);
        const events = req.session.events || [];
        const queue = req.session.queue || [];
        const isHinglish = req.language === 'hinglish';

        const lines: string[] = [];
        if (isHinglish) {
          lines.push(`### Session Summary: ${req.session.source.name}`);
          lines.push(`- **Watching Time:** ${watching}s | **Absent / Paused:** ${absent}s | **Low Signal:** ${degraded}s`);
          lines.push(`- **Total Blinks:** ${m?.totalBlinks ?? 0} | **Furthest Video Position:** ${Math.floor((m?.furthestVideoTimeSec || 0) / 60)}:${Math.floor((m?.furthestVideoTimeSec || 0) % 60).toString().padStart(2, '0')}`);
          lines.push('');
          if (events.length === 0 && queue.length === 0) {
            lines.push('**Koi missed interval detect nahi hua!** Poora video dhyaan se dekha gaya.');
          } else {
            lines.push('### Video Mein Kahan Kya Hua:');
            events.forEach((ev, i) => {
              const startFmt = `${Math.floor(ev.start / 60)}:${Math.floor(ev.start % 60).toString().padStart(2, '0')}`;
              const endFmt = `${Math.floor(ev.end / 60)}:${Math.floor(ev.end % 60).toString().padStart(2, '0')}`;
              lines.push(`${i + 1}. **${startFmt} – ${endFmt}** — ${ev.type.toUpperCase()}${ev.note ? ` (${ev.note})` : ''}`);
            });
            if (queue.length > 0) {
              lines.push('', '### Recommended Rewatch Order (Pre-roll ke saath):');
              queue.forEach((q, i) => {
                const s = `${Math.floor(q.start / 60)}:${Math.floor(q.start % 60).toString().padStart(2, '0')}`;
                const e = `${Math.floor(q.end / 60)}:${Math.floor(q.end % 60).toString().padStart(2, '0')}`;
                lines.push(`${i + 1}. **${s} → ${e}** (${Math.round(q.duration)}s)${q.chapterTitle ? ` — ${q.chapterTitle}` : ''}`);
              });
            }
          }
        } else {
          lines.push(`### Session Summary: ${req.session.source.name}`);
          lines.push(`- **Watching Time:** ${watching}s | **Absent / Paused:** ${absent}s | **Low Signal:** ${degraded}s`);
          lines.push(`- **Total Blinks:** ${m?.totalBlinks ?? 0} | **Furthest Video Position:** ${Math.floor((m?.furthestVideoTimeSec || 0) / 60)}:${Math.floor((m?.furthestVideoTimeSec || 0) % 60).toString().padStart(2, '0')}`);
          lines.push('');
          if (events.length === 0 && queue.length === 0) {
            lines.push('**No missed intervals detected.** All tracked segments were actively watched.');
          } else {
            lines.push('### Timestamped Session Events:');
            events.forEach((ev, i) => {
              const startFmt = `${Math.floor(ev.start / 60)}:${Math.floor(ev.start % 60).toString().padStart(2, '0')}`;
              const endFmt = `${Math.floor(ev.end / 60)}:${Math.floor(ev.end % 60).toString().padStart(2, '0')}`;
              lines.push(`${i + 1}. **${startFmt} – ${endFmt}** — ${ev.type.toUpperCase()}${ev.note ? ` (${ev.note})` : ''}`);
            });
            if (queue.length > 0) {
              lines.push('', '### Recommended Rewatch Plan:');
              queue.forEach((q, i) => {
                const s = `${Math.floor(q.start / 60)}:${Math.floor(q.start % 60).toString().padStart(2, '0')}`;
                const e = `${Math.floor(q.end / 60)}:${Math.floor(q.end % 60).toString().padStart(2, '0')}`;
                lines.push(`${i + 1}. **${s} → ${e}** (${Math.round(q.duration)}s)${q.chapterTitle ? ` — ${q.chapterTitle}` : ''}`);
              });
            }
          }
        }

        return {
          answer: lines.join('\n'),
          providerUsed: 'offline',
          modelUsed: 'Instant Offline Engine (0.0s)'
        };
      }
    }
  };
}
