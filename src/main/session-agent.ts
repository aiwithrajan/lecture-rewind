import * as fs from 'fs';
import * as path from 'path';
import {
  AgentChatMessage,
  AgentEngineMode,
  AgentLanguage,
  AgentRequest,
  AgentResponse,
  AgentStatus,
  SessionDocument
} from '@shared/types';

function formatTimestamp(sec: number): string {
  const safe = Math.max(0, Math.floor(sec || 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function formatDurationHuman(sec: number): string {
  const safe = Math.max(0, Math.round(sec || 0));
  if (safe < 60) return `${safe}s`;
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

interface YouTubeVideoContext {
  videoId: string;
  title?: string;
  cues: CaptionCue[];
}

function extractYouTubeVideoId(rawUrl: string): string | null {
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
    // Not a URL
  }
  return null;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseYouTubeTimedTextXml(xml: string): CaptionCue[] {
  const cues: CaptionCue[] = [];

  // Format 3: <p t="1234" d="5678">text</p>
  const pRegex = /<p\s+[^>]*t="(\d+)"(?:[^>]*d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = pRegex.exec(xml)) !== null) {
    const startSec = parseInt(match[1], 10) / 1000;
    const durSec = match[2] ? parseInt(match[2], 10) / 1000 : 3.0;
    const text = decodeHtmlEntities(match[3]);
    if (text) {
      cues.push({ startSec, endSec: startSec + durSec, text });
    }
  }

  if (cues.length > 0) return cues;

  // Legacy format: <text start="1.23" dur="4.56">text</text>
  const tRegex = /<text\s+[^>]*start="([\d.]+)"(?:[^>]*dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = tRegex.exec(xml)) !== null) {
    const startSec = parseFloat(match[1]);
    const durSec = match[2] ? parseFloat(match[2]) : 3.0;
    const text = decodeHtmlEntities(match[3]);
    if (text) {
      cues.push({ startSec, endSec: startSec + durSec, text });
    }
  }

  return cues;
}

function sliceTranscriptExcerpt(cues: CaptionCue[], startSec: number, endSec: number, maxChars = 360): string | undefined {
  if (cues.length === 0) return undefined;
  const winStart = Math.max(0, startSec - 5);
  const winEnd = Math.max(endSec + 5, startSec + 15);
  const matching = cues
    .filter((c) => c.endSec >= winStart && c.startSec <= winEnd)
    .map((c) => c.text);

  if (matching.length === 0) return undefined;
  const joined = matching.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars).trim()}...` : joined;
}

/**
 * Loads key=value pairs from .env.local without external dependencies.
 */
function loadLocalEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  const candidates = [
    path.join(process.cwd(), '.env.local'),
    path.join(__dirname, '../../.env.local')
  ];

  for (const envPath of candidates) {
    try {
      if (fs.existsSync(envPath)) {
        const raw = fs.readFileSync(envPath, 'utf-8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            result[key] = val;
          }
        }
        break;
      }
    } catch {
      // Ignore unreadable env file
    }
  }
  return result;
}

/**
 * SessionReviewAgent processes a Lecture Rewind SessionDocument JSON and generates
 * clear human-readable summaries and Q&A using a 3-tier hybrid architecture:
 *   Tier 1: Gemini 2.5 Flash (cloud API)
 *   Tier 2: Local Open-Source LLM via Ollama (automatic failover on quota/429 or user toggle)
 *   Tier 3: Deterministic Offline Analyzer (zero-dependency guaranteed fallback)
 */
export class SessionReviewAgent {
  private ytContextCache: Map<string, YouTubeVideoContext> = new Map();

  private async getYouTubeContext(rawUrl: string): Promise<YouTubeVideoContext | null> {
    const videoId = extractYouTubeVideoId(rawUrl);
    if (!videoId) return null;

    const cached = this.ytContextCache.get(videoId);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const watchRes = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      const html = await watchRes.text();
      const rawTitle = html.match(/<title>(.*?)<\/title>/)?.[1];
      const title = rawTitle ? decodeHtmlEntities(rawTitle.replace(/\s*-\s*YouTube\s*$/i, '')) : undefined;
      const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

      let cues: CaptionCue[] = [];
      if (apiKey) {
        const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' }
            }
          })
        });
        if (playerRes.ok) {
          const playerJson = (await playerRes.json()) as any;
          const tracks: any[] = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const preferred =
            tracks.find((t) => t.languageCode === 'en' && !t.kind) ||
            tracks.find((t) => String(t.languageCode || '').startsWith('en')) ||
            tracks[0];

          if (preferred?.baseUrl) {
            const capRes = await fetch(preferred.baseUrl, { signal: controller.signal });
            if (capRes.ok) {
              const xml = await capRes.text();
              cues = parseYouTubeTimedTextXml(xml);
            }
          }
        }
      }

      const ctx: YouTubeVideoContext = { videoId, title, cues };
      this.ytContextCache.set(videoId, ctx);
      return ctx;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private getConfig(): { geminiKey: string; ollamaUrl: string; defaultOllamaModel: string } {
    const fileEnv = loadLocalEnv();
    const geminiKey = process.env.GEMINI_API_KEY || fileEnv.GEMINI_API_KEY || '';
    const ollamaUrl = (process.env.OLLAMA_URL || fileEnv.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const defaultOllamaModel = process.env.OLLAMA_MODEL || fileEnv.OLLAMA_MODEL || 'lecture-rewind-gemma:latest';
    return { geminiKey, ollamaUrl, defaultOllamaModel };
  }

  public async getStatus(): Promise<AgentStatus> {
    const { geminiKey, ollamaUrl, defaultOllamaModel } = this.getConfig();
    let ollamaAvailable = false;
    let ollamaModels: string[] = [];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        ollamaAvailable = true;
        ollamaModels = (data.models || []).map((m) => m.name);
        // Prioritize custom lecture-rewind-* fine-tuned models at the top of the dropdown
        ollamaModels.sort((a, b) => {
          const aCustom = a.startsWith('lecture-rewind') ? 0 : 1;
          const bCustom = b.startsWith('lecture-rewind') ? 0 : 1;
          return aCustom - bCustom;
        });
      }
    } catch {
      ollamaAvailable = false;
    }

    const pickedDefault =
      ollamaModels.find((m) => m === defaultOllamaModel || m.startsWith('lecture-rewind')) ||
      ollamaModels[0] ||
      defaultOllamaModel;

    return {
      geminiConfigured: Boolean(geminiKey),
      ollamaAvailable,
      ollamaModels,
      defaultOllamaModel: pickedDefault
    };
  }

  public async query(req: AgentRequest): Promise<AgentResponse> {
    const { geminiKey, ollamaUrl, defaultOllamaModel } = this.getConfig();
    const engine: AgentEngineMode = req.engine || 'auto';
    const language: AgentLanguage = req.language || 'english';
    const selectedOllamaModel = req.ollamaModel || defaultOllamaModel;

    // Enrich YouTube lectures with video title & timestamped caption excerpts for missed segments
    const ytContext =
      req.session.source.type === 'url'
        ? await this.getYouTubeContext(req.session.source.pathOrUrl)
        : null;

    const { contextJson, matchedExcerptsCount } = this.buildSessionContextJson(req.session, ytContext);
    const transcriptContext = ytContext
      ? {
          videoTitle: ytContext.title,
          captionsAvailable: ytContext.cues.length > 0,
          matchedExcerptsCount
        }
      : undefined;

    const systemPrompt = this.buildSystemPrompt(contextJson, language, Boolean(ytContext && ytContext.cues.length > 0));
    const userPrompt = req.question?.trim() || this.buildDefaultAnalysisPrompt(language);
    const history = req.history || [];

    // Instant Deterministic Engine (Zero Latency 0.0s, Zero Cloud / GPU Dependency)
    if (engine === 'offline') {
      return {
        answer: this.buildOfflineFallback(req.session, language, req.question, ytContext),
        providerUsed: 'offline',
        modelUsed: 'Instant Offline Engine (0.0s)',
        transcriptContext
      };
    }

    // Force Local Open-Source Ollama
    if (engine === 'ollama') {
      try {
        const answer = await this.callOllama(ollamaUrl, selectedOllamaModel, systemPrompt, history, userPrompt);
        return {
          answer,
          providerUsed: 'ollama',
          modelUsed: selectedOllamaModel,
          transcriptContext
        };
      } catch (err: any) {
        return {
          answer: this.buildOfflineFallback(req.session, language, req.question, ytContext),
          providerUsed: 'offline',
          modelUsed: 'Instant Offline Engine (0.0s)',
          failoverReason: `Ollama unavailable (${err?.message || 'not running'}). Using Instant Offline Analysis.`,
          transcriptContext
        };
      }
    }

    // Force Gemini or Smart Hybrid Auto (Gemini -> Local Ollama -> Offline)
    let geminiFailReason: string | undefined;

    if (geminiKey) {
      try {
        const answer = await this.callGemini(geminiKey, systemPrompt, history, userPrompt);
        return {
          answer,
          providerUsed: 'gemini',
          modelUsed: 'gemini-2.5-flash',
          transcriptContext
        };
      } catch (err: any) {
        geminiFailReason = err?.message || 'Gemini API request failed';
        if (engine === 'gemini') {
          return {
            answer: this.buildOfflineFallback(req.session, language, req.question, ytContext),
            providerUsed: 'offline',
            modelUsed: 'Instant Offline Engine (0.0s)',
            failoverReason: `Gemini error: ${geminiFailReason}. Switched to Instant Analysis.`,
            transcriptContext
          };
        }
      }
    } else {
      geminiFailReason = 'GEMINI_API_KEY not configured';
    }

    // Auto-failover to Local Open-Source Ollama (zero rate limits!)
    try {
      const status = await this.getStatus();
      const targetModel = req.ollamaModel || status.defaultOllamaModel;
      if (status.ollamaAvailable && targetModel) {
        const answer = await this.callOllama(ollamaUrl, targetModel, systemPrompt, history, userPrompt);
        return {
          answer,
          providerUsed: 'ollama',
          modelUsed: targetModel,
          failoverReason: geminiFailReason
            ? `Auto-switched to local open-source ${targetModel} (${geminiFailReason})`
            : undefined,
          transcriptContext
        };
      }
    } catch (ollamaErr: any) {
      geminiFailReason = `${geminiFailReason || 'Gemini unavailable'}; Ollama failover failed (${ollamaErr?.message || 'not running'})`;
    }

    // Guaranteed Tier 3 Offline Fallback
    return {
      answer: this.buildOfflineFallback(req.session, language, req.question, ytContext),
      providerUsed: 'offline',
      modelUsed: 'Instant Offline Engine (0.0s)',
      failoverReason: geminiFailReason,
      transcriptContext
    };
  }

  private async callGemini(
    apiKey: string,
    systemPrompt: string,
    history: AgentChatMessage[],
    userPrompt: string
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

    const contents = [
      ...history.slice(-8).map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      })),
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7500);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 420,
            thinkingConfig: { thinkingBudget: 0 }
          }
        })
      });

      if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 429 || errBody.includes('RESOURCE_EXHAUSTED')) {
          throw new Error('Gemini rate/quota limit reached (HTTP 429)');
        }
        throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 140)}`);
      }

      const data = (await res.json()) as any;
      const text = data?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text || '')
        .join('')
        .trim();

      if (!text) {
        throw new Error('Empty response from Gemini');
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private async callOllama(
    ollamaUrl: string,
    model: string,
    systemPrompt: string,
    history: AgentChatMessage[],
    userPrompt: string
  ): Promise<string> {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: userPrompt }
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: 0.2,
            num_predict: 280,
            top_k: 20,
            top_p: 0.85
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 120)}`);
      }

      const data = (await res.json()) as any;
      const text = data?.message?.content?.trim();
      if (!text) {
        throw new Error('Empty response from Ollama');
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildSessionContextJson(
    session: SessionDocument,
    ytContext: YouTubeVideoContext | null
  ): { contextJson: string; matchedExcerptsCount: number } {
    const metrics = session.metrics;
    const pauses = (session.events || []).filter((e) => e.type === 'pause');
    const markers = (session.events || []).filter((e) => e.type === 'marker');
    const bookmarks = (session.events || []).filter((e) => e.type === 'bookmark');
    const cues = ytContext?.cues || [];
    let matchedExcerptsCount = 0;

    const totalWallSec =
      session.startedAt && session.endedAt
        ? Math.max(0, Math.round((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000))
        : Math.round((metrics?.watchingDurationSec || 0) + (metrics?.absentDurationSec || 0) + (metrics?.degradedDurationSec || 0));

    const detectedEvents = (session.events || []).map((ev) => {
      const excerpt = sliceTranscriptExcerpt(cues, ev.start, ev.end);
      if (excerpt) matchedExcerptsCount++;
      return {
        type: ev.type,
        videoRange: `${formatTimestamp(ev.start)} - ${formatTimestamp(ev.end)}`,
        evidenceRules: ev.evidence,
        reason: ev.note || ev.type,
        ...(excerpt ? { spokenTranscriptDuringInterval: excerpt } : {})
      };
    });

    const compiledRewindQueue = (session.queue || []).map((q, idx) => {
      const excerpt = sliceTranscriptExcerpt(cues, q.start, q.end);
      if (excerpt) matchedExcerptsCount++;
      return {
        step: idx + 1,
        chapter: q.chapterTitle || 'General',
        rewatchRange: `${formatTimestamp(q.start)} - ${formatTimestamp(q.end)}`,
        duration: formatDurationHuman(q.duration),
        ...(excerpt ? { spokenTranscriptDuringInterval: excerpt } : {})
      };
    });

    const summaryPayload = {
      lectureTitle: ytContext?.title || session.source.name,
      sourceType: session.source.type,
      captionsAvailable: cues.length > 0,
      videoDuration: formatTimestamp(session.source.duration || 0),
      videoDurationSec: Math.round(session.source.duration || 0),
      sessionWallTime: formatDurationHuman(totalWallSec),
      furthestVideoPosition: formatTimestamp(metrics?.furthestVideoTimeSec || 0),
      presenceStats: {
        watchingTime: formatDurationHuman(metrics?.watchingDurationSec || 0),
        watchingSec: Math.round(metrics?.watchingDurationSec || 0),
        absentOrPausedTime: formatDurationHuman(metrics?.absentDurationSec || 0),
        absentSec: Math.round(metrics?.absentDurationSec || 0),
        lowCameraQualityTime: formatDurationHuman(metrics?.degradedDurationSec || 0),
        totalBlinks: metrics?.totalBlinks ?? 0,
        pauseCount: pauses.length,
        briefClosureMarkerCount: markers.length,
        manualBookmarkCount: bookmarks.length
      },
      chapters: (session.source.chapters || []).map((c) => ({
        title: c.title,
        range: `${formatTimestamp(c.start)} - ${formatTimestamp(c.end)}`
      })),
      detectedEvents,
      compiledRewindQueue,
      stateTransitions: (metrics?.stateTimeline || []).slice(-25).map((seg) => ({
        state: seg.state,
        atVideoTime: formatTimestamp(seg.videoTimeSec),
        duration: formatDurationHuman(seg.endSec - seg.startSec)
      }))
    };

    return {
      contextJson: JSON.stringify(summaryPayload, null, 2),
      matchedExcerptsCount
    };
  }

  private buildSystemPrompt(contextJson: string, language: AgentLanguage, hasCaptions: boolean): string {
    const langInstruction =
      language === 'hinglish'
        ? 'Respond in clear, friendly Hinglish (natural mix of Hindi in Roman script and English technical terms, concise bullet points).'
        : 'Respond in clear, concise English with structured bullet points.';

    const captionInstruction = hasCaptions
      ? '- When `spokenTranscriptDuringInterval` is present for an event or queue interval, briefly summarize WHAT TOPIC the instructor was explaining during that exact missed timestamp!'
      : '- Never invent video topics or timestamps that are not in the JSON.';

    return [
      'You are the Lecture Rewind Session Review Agent.',
      'Your job is to inspect the recorded lecture session JSON below and tell the viewer clearly:',
      '1) How long they were actively watching vs absent/paused, plus total blinks and camera stability.',
      '2) Exactly WHERE in the lecture video intervals were missed, paused, briefly closed, or bookmarked (using MM:SS timestamps, chapter names, and spoken transcript context if present).',
      '3) Actionable rewatch order so they can recover missed segments fast.',
      '',
      'STRICT RULES:',
      '- Base every single timestamp, duration, event, and topic strictly on the Session JSON below.',
      captionInstruction,
      '- Use factual mechanical terms only: "watching", "prolonged eye closure", "brief eye closure", "viewer not present", "head drop", "bookmark", "low camera confidence". Never make medical or diagnostic claims.',
      `- ${langInstruction}`,
      '',
      'SESSION JSON DATA:',
      contextJson
    ].join('\n');
  }

  private buildDefaultAnalysisPrompt(language: AgentLanguage): string {
    if (language === 'hinglish') {
      return 'Is poore lecture session JSON ka clear summary do: kitni der watching raha, kitni der absent/missed raha, total blinks kitne hue, video mein kahan-kahan kya miss ya mark hua (exact timestamps aur transcript topic ke saath agar available ho), aur kahan se rewatch karna chahiye.';
    }
    return 'Analyze this complete lecture session JSON: summarize total watching vs absent time, blink count, every timestamp where an absence pause, brief closure marker, or bookmark occurred (including what topic was being taught if transcript excerpts are present), and give a clear step-by-step rewatch plan.';
  }

  private buildOfflineFallback(
    session: SessionDocument,
    language: AgentLanguage,
    question?: string,
    ytContext?: YouTubeVideoContext | null
  ): string {
    const m = session.metrics;
    const watching = formatDurationHuman(m?.watchingDurationSec || 0);
    const absent = formatDurationHuman(m?.absentDurationSec || 0);
    const degraded = formatDurationHuman(m?.degradedDurationSec || 0);
    const blinks = m?.totalBlinks ?? 0;
    const events = session.events || [];
    const queue = session.queue || [];
    const cues = ytContext?.cues || [];
    const displayTitle = ytContext?.title || session.source.name;

    const lines: string[] = [];

    if (language === 'hinglish') {
      lines.push(`### Session Summary: ${displayTitle}`);
      lines.push(`- **Watching Time:** ${watching} | **Absent / Paused:** ${absent} | **Low Signal:** ${degraded}`);
      lines.push(`- **Total Blinks:** ${blinks} | **Furthest Video Position:** ${formatTimestamp(m?.furthestVideoTimeSec || 0)}`);
      lines.push('');

      if (events.length === 0 && queue.length === 0) {
        lines.push('**Koi missed interval detect nahi hua!** Poora watched stretch clean tha.');
      } else {
        lines.push('### Video Mein Kahan Kya Hua:');
        events.forEach((ev, i) => {
          const label =
            ev.type === 'pause' ? 'Auto-Pause (Absent)' : ev.type === 'bookmark' ? 'Bookmark' : 'Brief Closure Marker';
          const excerpt = sliceTranscriptExcerpt(cues, ev.start, ev.end, 160);
          lines.push(
            `${i + 1}. **${formatTimestamp(ev.start)} – ${formatTimestamp(ev.end)}** — ${label}${ev.note ? ` (${ev.note})` : ''}${excerpt ? ` — Topic: "${excerpt}"` : ''}`
          );
        });

        if (queue.length > 0) {
          lines.push('', '### Recommended Rewatch Order (Pre-roll ke saath):');
          queue.forEach((q, i) => {
            lines.push(
              `${i + 1}. **${formatTimestamp(q.start)} → ${formatTimestamp(q.end)}** (${formatDurationHuman(q.duration)})${q.chapterTitle ? ` — ${q.chapterTitle}` : ''}`
            );
          });
        }
      }

      if (question) {
        lines.push('', `*(Note: Offline fallback mode active — question "${question}" ke liye upar exact timestamps aur stats diye gaye hain.)*`);
      }
    } else {
      lines.push(`### Session Summary: ${displayTitle}`);
      lines.push(`- **Watching Time:** ${watching} | **Absent / Paused:** ${absent} | **Low Signal:** ${degraded}`);
      lines.push(`- **Total Blinks:** ${blinks} | **Furthest Video Position:** ${formatTimestamp(m?.furthestVideoTimeSec || 0)}`);
      lines.push('');

      if (events.length === 0 && queue.length === 0) {
        lines.push('**No missed intervals detected.** All tracked segments were actively watched.');
      } else {
        lines.push('### Timestamped Session Events:');
        events.forEach((ev, i) => {
          const excerpt = sliceTranscriptExcerpt(cues, ev.start, ev.end, 160);
          lines.push(
            `${i + 1}. **${formatTimestamp(ev.start)} – ${formatTimestamp(ev.end)}** — ${ev.type.toUpperCase()}${ev.note ? ` (${ev.note})` : ''}${excerpt ? ` — Spoken context: "${excerpt}"` : ''}`
          );
        });

        if (queue.length > 0) {
          lines.push('', '### Recommended Rewatch Plan:');
          queue.forEach((q, i) => {
            lines.push(
              `${i + 1}. **${formatTimestamp(q.start)} → ${formatTimestamp(q.end)}** (${formatDurationHuman(q.duration)})${q.chapterTitle ? ` — ${q.chapterTitle}` : ''}`
            );
          });
        }
      }
    }

    return lines.join('\n');
  }
}
