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
  private getConfig(): { geminiKey: string; ollamaUrl: string; defaultOllamaModel: string } {
    const fileEnv = loadLocalEnv();
    const geminiKey = process.env.GEMINI_API_KEY || fileEnv.GEMINI_API_KEY || '';
    const ollamaUrl = (process.env.OLLAMA_URL || fileEnv.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const defaultOllamaModel = process.env.OLLAMA_MODEL || fileEnv.OLLAMA_MODEL || 'gemma:2b';
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
      }
    } catch {
      ollamaAvailable = false;
    }

    const pickedDefault =
      ollamaModels.includes(defaultOllamaModel)
        ? defaultOllamaModel
        : ollamaModels[0] || defaultOllamaModel;

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
    const language: AgentLanguage = req.language || 'hinglish';
    const selectedOllamaModel = req.ollamaModel || defaultOllamaModel;

    const systemPrompt = this.buildSystemPrompt(req.session, language);
    const userPrompt = req.question?.trim() || this.buildDefaultAnalysisPrompt(language);
    const history = req.history || [];

    // Force Local Open-Source Ollama
    if (engine === 'ollama') {
      try {
        const answer = await this.callOllama(ollamaUrl, selectedOllamaModel, systemPrompt, history, userPrompt);
        return {
          answer,
          providerUsed: 'ollama',
          modelUsed: selectedOllamaModel
        };
      } catch (err: any) {
        return {
          answer: this.buildOfflineFallback(req.session, language, req.question),
          providerUsed: 'offline',
          modelUsed: 'Local Deterministic Analyzer',
          failoverReason: `Ollama unavailable (${err?.message || 'not running'}). Start Ollama with "ollama serve" to use local open-source models.`
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
          modelUsed: 'gemini-2.5-flash'
        };
      } catch (err: any) {
        geminiFailReason = err?.message || 'Gemini API request failed';
        if (engine === 'gemini') {
          return {
            answer: this.buildOfflineFallback(req.session, language, req.question),
            providerUsed: 'offline',
            modelUsed: 'Local Deterministic Analyzer',
            failoverReason: `Gemini error: ${geminiFailReason}`
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
            : undefined
        };
      }
    } catch (ollamaErr: any) {
      geminiFailReason = `${geminiFailReason || 'Gemini unavailable'}; Ollama failover failed (${ollamaErr?.message || 'not running'})`;
    }

    // Guaranteed Tier 3 Offline Fallback
    return {
      answer: this.buildOfflineFallback(req.session, language, req.question),
      providerUsed: 'offline',
      modelUsed: 'Local Deterministic Analyzer',
      failoverReason: geminiFailReason
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
    const timer = setTimeout(() => controller.abort(), 22000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 900
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
    const timer = setTimeout(() => controller.abort(), 60000);

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
            temperature: 0.3,
            num_predict: 650
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

  private buildSessionContextJson(session: SessionDocument): string {
    const metrics = session.metrics;
    const pauses = (session.events || []).filter((e) => e.type === 'pause');
    const markers = (session.events || []).filter((e) => e.type === 'marker');
    const bookmarks = (session.events || []).filter((e) => e.type === 'bookmark');

    const totalWallSec =
      session.startedAt && session.endedAt
        ? Math.max(0, Math.round((new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000))
        : Math.round((metrics?.watchingDurationSec || 0) + (metrics?.absentDurationSec || 0) + (metrics?.degradedDurationSec || 0));

    const summaryPayload = {
      lectureTitle: session.source.name,
      sourceType: session.source.type,
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
      detectedEvents: (session.events || []).map((ev) => ({
        type: ev.type,
        videoRange: `${formatTimestamp(ev.start)} - ${formatTimestamp(ev.end)}`,
        evidenceRules: ev.evidence,
        reason: ev.note || ev.type
      })),
      compiledRewindQueue: (session.queue || []).map((q, idx) => ({
        step: idx + 1,
        chapter: q.chapterTitle || 'General',
        rewatchRange: `${formatTimestamp(q.start)} - ${formatTimestamp(q.end)}`,
        duration: formatDurationHuman(q.duration)
      })),
      stateTransitions: (metrics?.stateTimeline || []).slice(-25).map((seg) => ({
        state: seg.state,
        atVideoTime: formatTimestamp(seg.videoTimeSec),
        duration: formatDurationHuman(seg.endSec - seg.startSec)
      }))
    };

    return JSON.stringify(summaryPayload, null, 2);
  }

  private buildSystemPrompt(session: SessionDocument, language: AgentLanguage): string {
    const langInstruction =
      language === 'hinglish'
        ? 'Respond in clear, friendly Hinglish (natural mix of Hindi in Roman script and English technical terms, concise bullet points).'
        : 'Respond in clear, concise English with structured bullet points.';

    return [
      'You are the Lecture Rewind Session Review Agent.',
      'Your job is to inspect the recorded lecture session JSON below and tell the viewer clearly:',
      '1) How long they were actively watching vs absent/paused, plus total blinks and camera stability.',
      '2) Exactly WHERE in the lecture video intervals were missed, paused, briefly closed, or bookmarked (using MM:SS timestamps and chapter names if present).',
      '3) Actionable rewatch order so they can recover missed segments fast.',
      '',
      'STRICT RULES:',
      '- Base every single timestamp, duration, and event strictly on the Session JSON below. Never invent video topics or timestamps that are not in the JSON.',
      '- Use factual mechanical terms only: "watching", "prolonged eye closure", "brief eye closure", "viewer not present", "head drop", "bookmark", "low camera confidence". Never make medical or diagnostic claims.',
      `- ${langInstruction}`,
      '',
      'SESSION JSON DATA:',
      this.buildSessionContextJson(session)
    ].join('\n');
  }

  private buildDefaultAnalysisPrompt(language: AgentLanguage): string {
    if (language === 'hinglish') {
      return 'Is poore lecture session JSON ka clear summary do: kitni der watching raha, kitni der absent/missed raha, total blinks kitne hue, video mein kahan-kahan kya miss ya mark hua (exact timestamps ke saath), aur kahan se rewatch karna chahiye.';
    }
    return 'Analyze this complete lecture session JSON: summarize total watching vs absent time, blink count, every timestamp where an absence pause, brief closure marker, or bookmark occurred, and give a clear step-by-step rewatch plan.';
  }

  private buildOfflineFallback(session: SessionDocument, language: AgentLanguage, question?: string): string {
    const m = session.metrics;
    const watching = formatDurationHuman(m?.watchingDurationSec || 0);
    const absent = formatDurationHuman(m?.absentDurationSec || 0);
    const degraded = formatDurationHuman(m?.degradedDurationSec || 0);
    const blinks = m?.totalBlinks ?? 0;
    const events = session.events || [];
    const queue = session.queue || [];

    const lines: string[] = [];

    if (language === 'hinglish') {
      lines.push(`### Session Summary: ${session.source.name}`);
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
          lines.push(
            `${i + 1}. **${formatTimestamp(ev.start)} – ${formatTimestamp(ev.end)}** — ${label}${ev.note ? ` (${ev.note})` : ''}`
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
      lines.push(`### Session Summary: ${session.source.name}`);
      lines.push(`- **Watching Time:** ${watching} | **Absent / Paused:** ${absent} | **Low Signal:** ${degraded}`);
      lines.push(`- **Total Blinks:** ${blinks} | **Furthest Video Position:** ${formatTimestamp(m?.furthestVideoTimeSec || 0)}`);
      lines.push('');

      if (events.length === 0 && queue.length === 0) {
        lines.push('**No missed intervals detected.** All tracked segments were actively watched.');
      } else {
        lines.push('### Timestamped Session Events:');
        events.forEach((ev, i) => {
          lines.push(
            `${i + 1}. **${formatTimestamp(ev.start)} – ${formatTimestamp(ev.end)}** — ${ev.type.toUpperCase()}${ev.note ? ` (${ev.note})` : ''}`
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
