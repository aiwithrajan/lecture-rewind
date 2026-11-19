import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  AgentChatMessage,
  AgentEngineMode,
  AgentLanguage,
  AgentResponse,
  AgentStatus,
  NetworkGuardStats,
  QueueInterval,
  SessionDocument
} from '@shared/types';
import { QueueBuilder } from '../engine/QueueBuilder';
import { SessionInsights } from '../engine/SessionInsights';

interface ReviewAndPrivacyScreenProps {
  session: SessionDocument;
  onBackToHome: () => void;
  onPlayQueueInterval?: (interval: QueueInterval) => void;
  initialTab?: 'review' | 'privacy';
}

interface ActiveReplayClip {
  id: string;
  title: string;
  start: number;
  end: number;
  queueIndex?: number;
}

function parseTimestampTokenToSec(token: string): number {
  const parts = token.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function extractYouTubeId(rawUrl: string): string | null {
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

function resolveReplayMediaSrc(source: SessionDocument['source']): string {
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
 * Lightweight XSS-safe inline markdown formatter (**bold**, *italic*, `code`, clickable MM:SS timestamp badges).
 */
function renderInlineMarkdown(
  text: string,
  onTimestampClick?: (sec: number) => void
): React.ReactNode[] {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|\b\d{1,2}:\d{2}(?::\d{2})?\b)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={key++} style={{ color: '#f8fafc', fontWeight: 700 }}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={key++}
          style={{
            background: 'rgba(56, 189, 248, 0.14)',
            color: '#7dd3fc',
            padding: '1px 6px',
            borderRadius: '4px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px'
          }}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={key++} style={{ color: '#cbd5e1' }}>
          {token.slice(1, -1)}
        </em>
      );
    } else {
      // Clickable timestamp chip (e.g. 0:35 or 12:04) -> jumps straight into Recovery Clip Player
      const targetSec = parseTimestampTokenToSec(token);
      nodes.push(
        <button
          key={key++}
          type="button"
          onClick={() => onTimestampClick?.(targetSec)}
          title={`Jump to ${token} in Recovery Clip Player`}
          style={{
            background: 'rgba(56, 189, 248, 0.16)',
            border: '1px solid rgba(56, 189, 248, 0.45)',
            color: '#38bdf8',
            padding: '0px 6px',
            borderRadius: '4px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            fontWeight: 600,
            cursor: onTimestampClick ? 'pointer' : 'default',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '3px'
          }}
        >
          <span>▶</span>
          <span>{token}</span>
        </button>
      );
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/**
 * Renders structured LLM Markdown responses into crisp headings, bullet lists, numbered lists & paragraphs.
 */
function renderFormattedMarkdown(
  content: string,
  onTimestampClick?: (sec: number) => void
): React.ReactNode {
  const lines = content.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let listItems: Array<{ ordered: boolean; num?: string; text: string }> = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    const isOrdered = listItems[0].ordered;
    elements.push(
      <div
        key={`list-${key++}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          margin: '4px 0 8px 0'
        }}
      >
        {listItems.map((item, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
            <span
              style={{
                color: '#38bdf8',
                fontWeight: 700,
                fontSize: isOrdered ? '12px' : '14px',
                lineHeight: '20px',
                minWidth: isOrdered ? '18px' : '10px',
                fontFamily: isOrdered ? 'var(--font-mono)' : 'inherit'
              }}
            >
              {isOrdered ? `${item.num}.` : '•'}
            </span>
            <span style={{ flex: 1, color: '#cbd5e1' }}>{renderInlineMarkdown(item.text, onTimestampClick)}</span>
          </div>
        ))}
      </div>
    );
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      continue;
    }

    if (/^---+$/.test(line)) {
      flushList();
      elements.push(<hr key={`hr-${key++}`} style={{ border: 'none', borderTop: '1px solid #2e3c54', margin: '8px 0' }} />);
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      elements.push(
        <div
          key={`h-${key++}`}
          style={{
            fontSize: level === 1 ? '16px' : level === 2 ? '14px' : '13px',
            fontWeight: 700,
            color: level === 3 ? '#38bdf8' : '#f8fafc',
            marginTop: elements.length > 0 ? '10px' : '2px',
            marginBottom: '4px'
          }}
        >
          {renderInlineMarkdown(headingMatch[2], onTimestampClick)}
        </div>
      );
      continue;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      if (listItems.length > 0 && listItems[0].ordered) flushList();
      listItems.push({ ordered: false, text: bulletMatch[1] });
      continue;
    }

    const numMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numMatch) {
      if (listItems.length > 0 && !listItems[0].ordered) flushList();
      listItems.push({ ordered: true, num: numMatch[1], text: numMatch[2] });
      continue;
    }

    flushList();
    elements.push(
      <p key={`p-${key++}`} style={{ margin: '2px 0 6px 0', color: '#e2e8f0' }}>
        {renderInlineMarkdown(line, onTimestampClick)}
      </p>
    );
  }

  flushList();
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>{elements}</div>;
}

export const ReviewAndPrivacyScreen: React.FC<ReviewAndPrivacyScreenProps> = ({
  session,
  onBackToHome,
  onPlayQueueInterval,
  initialTab = 'review'
}) => {
  const [activeTab, setActiveTab] = useState<'review' | 'privacy'>(initialTab);
  const [networkStats, setNetworkStats] = useState<NetworkGuardStats>({
    blockedRequestsCount: 0,
    allowedRequestsCount: 0,
    applicationNetworkRequestsCount: 0,
    log: []
  });
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);

  // Hybrid AI Session Review Agent state (Gemini 2.5 Flash + Local Ollama Open-Source failover)
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({
    geminiConfigured: false,
    ollamaAvailable: false,
    ollamaModels: [],
    defaultOllamaModel: 'gemma:2b'
  });
  const [agentEngine, setAgentEngine] = useState<AgentEngineMode>('auto');
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>('gemma:2b');
  const [agentLanguage, setAgentLanguage] = useState<AgentLanguage>('english');
  const [agentLoading, setAgentLoading] = useState<boolean>(false);
  const [agentMeta, setAgentMeta] = useState<Pick<AgentResponse, 'providerUsed' | 'modelUsed' | 'failoverReason' | 'transcriptContext'> | null>(null);
  const [chatMessages, setChatMessages] = useState<AgentChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const hasAutoAnalyzedRef = useRef<boolean>(false);
  const [loadingElapsedSec, setLoadingElapsedSec] = useState<number>(0);

  // Recovery Clip Player state (1-click missed clip replay + sequential playback + mark reviewed)
  const [activeClip, setActiveClip] = useState<ActiveReplayClip | null>(null);
  const [isPlayingSequence, setIsPlayingSequence] = useState<boolean>(false);
  const [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const [clipCurrentTime, setClipCurrentTime] = useState<number>(0);
  const clipVideoRef = useRef<HTMLVideoElement | null>(null);
  const clipPlayerBoxRef = useRef<HTMLDivElement | null>(null);

  const youtubeVideoId = extractYouTubeId(session.source.pathOrUrl);
  const replayMediaSrc = resolveReplayMediaSrc(session.source);
  const [customReplaySrc, setCustomReplaySrc] = useState<string | null>(null);
  const [clipMediaError, setClipMediaError] = useState<boolean>(false);
  const replayFileInputRef = useRef<HTMLInputElement | null>(null);
  const activeReplaySrc = customReplaySrc || replayMediaSrc;
  const durationSec = session.source.duration || 3600;

  // Re-derive clean queue if the raw session queue was merged into a single video-length block
  // by legacy double-blink chatter, guaranteeing the user only replays actual missed segments!
  const queueList = useMemo(() => {
    const rawQueue = session.queue || [];
    const isSwallowedByLegacyChatter =
      rawQueue.length === 1 &&
      rawQueue[0].duration >= durationSec * 0.85 &&
      (session.events || []).some((e) => e.type === 'pause' || e.type === 'marker');

    if (isSwallowedByLegacyChatter) {
      const cleanEvents = (session.events || []).filter((e) => e.type === 'pause' || e.type === 'marker');
      const rebuilt = QueueBuilder.buildRewindQueue(
        cleanEvents,
        session.quality || [],
        session.source.chapters || [],
        durationSec
      );
      if (rebuilt.length > 0) return rebuilt;
    }
    return rawQueue;
  }, [session, durationSec]);

  const missedEvents = useMemo(() => {
    return (session.events || []).filter((e) => e.type === 'pause' || e.type === 'marker');
  }, [session.events]);

  const queueTotalSec = QueueBuilder.calculateTotalDuration(queueList);
  const headline = QueueBuilder.formatReviewHeadline(durationSec, queueTotalSec);
  const metrics = session.metrics;

  // Presence breakdown percentages (Watching vs Absent vs Low Camera Signal)
  const watchingSec = metrics?.watchingDurationSec || 0;
  const absentSec = metrics?.absentDurationSec || 0;
  const degradedSec = metrics?.degradedDurationSec || 0;
  const trackedTotalSec = watchingSec + absentSec + degradedSec;
  const watchingPct = trackedTotalSec > 0
    ? Math.round((watchingSec / trackedTotalSec) * 100)
    : Math.max(0, Math.round(((durationSec - queueTotalSec) / Math.max(1, durationSec)) * 100));
  const absentPct = trackedTotalSec > 0
    ? Math.round((absentSec / trackedTotalSec) * 100)
    : Math.min(100 - watchingPct, Math.round((queueTotalSec / Math.max(1, durationSec)) * 100));
  const degradedPct = Math.max(0, 100 - watchingPct - absentPct);
  const blinksPerMin = trackedTotalSec >= 5 && metrics
    ? ((metrics.totalBlinks / trackedTotalSec) * 60).toFixed(1)
    : '0.0';
  const ringRadius = 30;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringDashOffset = ringCircumference * (1 - watchingPct / 100);

  const markClipReviewed = (id: string) => {
    setReviewedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const toggleClipReviewed = (id: string) => {
    setReviewedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const openQueueClip = (item: QueueInterval, idx: number, sequential = false) => {
    setIsPlayingSequence(sequential);
    setActiveClip({
      id: item.id,
      title: item.chapterTitle || `Missed Segment #${idx + 1}`,
      start: item.start,
      end: item.end,
      queueIndex: idx
    });
    setClipCurrentTime(item.start);
    onPlayQueueInterval?.(item);
    setTimeout(() => {
      clipPlayerBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const handlePlayAllSequential = () => {
    if (queueList.length === 0) return;
    openQueueClip(queueList[0], 0, true);
  };

  const handleTimestampChipClick = (sec: number) => {
    const startSec = Math.max(0, sec - 5);
    const endSec = Math.min(durationSec, sec + 25);
    setIsPlayingSequence(false);
    setActiveClip({
      id: `jump-${sec}-${Date.now()}`,
      title: `Timestamp Jump (${formatSec(sec)})`,
      start: startSec,
      end: endSec
    });
    setClipCurrentTime(startSec);
    setTimeout(() => {
      clipPlayerBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const handleClipEnded = () => {
    if (!activeClip) return;
    if (activeClip.queueIndex !== undefined) {
      markClipReviewed(activeClip.id);
      if (isPlayingSequence && activeClip.queueIndex + 1 < queueList.length) {
        const nextIdx = activeClip.queueIndex + 1;
        openQueueClip(queueList[nextIdx], nextIdx, true);
        return;
      }
    }
    setIsPlayingSequence(false);
  };

  // Seek and auto-play HTML5 local video whenever activeClip changes
  useEffect(() => {
    if (!activeClip || youtubeVideoId || !clipVideoRef.current) return;
    const vid = clipVideoRef.current;
    const seekAndPlay = () => {
      vid.currentTime = activeClip.start;
      vid.play().catch(() => {});
    };
    if (vid.readyState >= 1) {
      seekAndPlay();
    } else {
      vid.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      return () => vid.removeEventListener('loadedmetadata', seekAndPlay);
    }
  }, [activeClip, youtubeVideoId]);

  // Detect YouTube clip finish (playerState === 0) to mark reviewed & advance in sequential mode
  useEffect(() => {
    if (!activeClip || !youtubeVideoId) return;
    const onMsg = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'infoDelivery' && msg.info) {
          if (typeof msg.info.currentTime === 'number') {
            setClipCurrentTime(msg.info.currentTime);
          }
          if (msg.info.playerState === 0) {
            handleClipEnded();
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [activeClip, youtubeVideoId, isPlayingSequence]);

  useEffect(() => {
    loadNetworkStats();
    loadAgentStatus();
    loadConsentStatus();
  }, []);

  const loadConsentStatus = async () => {
    try {
      if ((window as any).rewindApi?.consent) {
        const consent = await (window as any).rewindApi.consent.get();
        if (consent && typeof consent.telemetryEnabled === 'boolean') {
          setTelemetryEnabled(consent.telemetryEnabled);
        }
      }
    } catch {
      // Standalone default
    }
  };

  useEffect(() => {
    // Auto-run session analysis once when opening a real lecture review
    if (
      activeTab === 'review' &&
      session.id !== 'settings-privacy' &&
      !hasAutoAnalyzedRef.current
    ) {
      hasAutoAnalyzedRef.current = true;
      (async () => {
        // Step 1: Render instant offline overview in 0.001s so the screen is never blank!
        try {
          if ((window as any).rewindApi?.agent) {
            const instantRes: AgentResponse = await (window as any).rewindApi.agent.query({
              session,
              engine: 'offline',
              language: agentLanguage
            });
            setChatMessages([{ role: 'assistant', content: instantRes.answer }]);
            setAgentMeta({
              providerUsed: instantRes.providerUsed,
              modelUsed: instantRes.modelUsed,
              failoverReason: instantRes.failoverReason,
              transcriptContext: instantRes.transcriptContext
            });
          }
        } catch {
          // Ignore
        }

        // Step 2: If configured engine is not offline, run fast AI enhancement
        if (agentEngine !== 'offline') {
          runAgentQuery();
        }
      })();
    }
  }, [activeTab, session.id]);

  useEffect(() => {
    if (!agentLoading) {
      setLoadingElapsedSec(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setLoadingElapsedSec((Date.now() - start) / 1000);
    }, 100);
    return () => clearInterval(timer);
  }, [agentLoading]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, agentLoading]);

  const loadAgentStatus = async () => {
    try {
      if ((window as any).rewindApi?.agent) {
        const status: AgentStatus = await (window as any).rewindApi.agent.getStatus();
        setAgentStatus(status);
        if (status.defaultOllamaModel) {
          setSelectedOllamaModel(status.defaultOllamaModel);
        }
      }
    } catch {
      // Standalone fallback
    }
  };

  const runAgentQuery = async (customQuestion?: string, overrideEngine?: AgentEngineMode, overrideLang?: AgentLanguage) => {
    if (agentLoading) return;
    const trimmedQ = customQuestion?.trim();
    const useEngine = overrideEngine || agentEngine;
    const useLang = overrideLang || agentLanguage;

    const historySnapshot = trimmedQ ? [...chatMessages] : [];
    if (trimmedQ) {
      setChatMessages((prev) => [...prev, { role: 'user', content: trimmedQ }]);
      setChatInput('');
    }

    setAgentLoading(true);
    try {
      if ((window as any).rewindApi?.agent) {
        const res: AgentResponse = await (window as any).rewindApi.agent.query({
          session,
          question: trimmedQ,
          history: historySnapshot,
          engine: useEngine,
          ollamaModel: selectedOllamaModel,
          language: useLang
        });
        setAgentMeta({
          providerUsed: res.providerUsed,
          modelUsed: res.modelUsed,
          failoverReason: res.failoverReason,
          transcriptContext: res.transcriptContext
        });
        if (trimmedQ) {
          setChatMessages((prev) => [...prev, { role: 'assistant', content: res.answer }]);
        } else {
          setChatMessages([{ role: 'assistant', content: res.answer }]);
        }
      } else {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: 'Agent IPC is only available inside the Electron desktop app.'
          }
        ]);
      }
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Agent error: ${err?.message || 'Unable to analyze session right now.'}`
        }
      ]);
    } finally {
      setAgentLoading(false);
    }
  };

  const formatDurationShort = (sec: number) => {
    const s = Math.max(0, Math.round(sec || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
  };

  const loadNetworkStats = async () => {
    try {
      if ((window as any).rewindApi?.network) {
        const stats = await (window as any).rewindApi.network.getStats();
        setNetworkStats(stats);
      }
    } catch {
      // Simulation default
    }
  };

  const handleExportMarkdown = () => {
    const lines = [
      `# Lecture Rewind Summary: ${session.source.name}`,
      ``,
      `**Date:** ${new Date(session.startedAt).toLocaleString()}`,
      `**Headline:** ${headline}`,
      `**Total Session Duration:** ${Math.round(durationSec / 60)} minutes`,
      `**Rewind Queue Duration:** ${Math.round(queueTotalSec / 60)} minutes (${queueTotalSec} seconds)`,
      ``,
      `## Rewind Queue Intervals (Recovery Playlist)`,
      ``,
      `| Interval | Chapter | Start Time | End Time | Duration |`,
      `| :--- | :--- | :--- | :--- | :--- |`
    ];

    (session.queue || []).forEach((q, idx) => {
      const startMin = (q.start / 60).toFixed(1);
      const endMin = (q.end / 60).toFixed(1);
      lines.push(
        `| #${idx + 1} | ${q.chapterTitle || 'General'} | ${startMin}m (${q.start}s) | ${endMin}m (${q.end}s) | ${q.duration}s |`
      );
    });

    lines.push(``, `## Absence Events & Markers`, ``);
    (session.events || []).forEach((ev) => {
      lines.push(
        `- **${ev.type.toUpperCase()}** at ${ev.start.toFixed(1)}s (Evidence: ${ev.evidence.join(', ')}) ${ev.note ? `- ${ev.note}` : ''}`
      );
    });

    lines.push(``, `---`, `*Generated locally by Lecture Rewind. Zero cloud telemetry.*`);

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lecture-rewind-${session.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lecture-rewind-${session.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handle1ClickWipeAll = async () => {
    try {
      if ((window as any).rewindApi?.sessions) {
        await (window as any).rewindApi.sessions.deleteAllData();
      }
    } catch {
      // Ignored
    }
    setDeleteConfirmation(false);
    onBackToHome();
  };

  const formatSec = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#0b0f19' }}>
      {/* Top Header */}
      <header style={{
        height: '56px',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <button
            onClick={onBackToHome}
            style={{
              background: 'transparent',
              border: '1px solid #2e3c54',
              color: '#94a3b8',
              padding: '6px 14px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            ← Back to Home
          </button>
          <span style={{ fontSize: '16px', fontWeight: 600, color: '#f8fafc' }}>
            {session.source.name}
          </span>
        </div>

        {/* Tab Toggle */}
        <div style={{ display: 'flex', background: '#151d2f', padding: '3px', borderRadius: '8px', border: '1px solid #2e3c54' }}>
          <button
            onClick={() => setActiveTab('review')}
            style={{
              background: activeTab === 'review' ? '#2563eb' : 'transparent',
              color: activeTab === 'review' ? '#fff' : '#94a3b8',
              border: 'none',
              padding: '6px 18px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            Rewind Queue & Timeline
          </button>
          <button
            onClick={() => setActiveTab('privacy')}
            style={{
              background: activeTab === 'privacy' ? '#2563eb' : 'transparent',
              color: activeTab === 'privacy' ? '#fff' : '#94a3b8',
              border: 'none',
              padding: '6px 18px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            Privacy & Firewall
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 48px' }}>
        {activeTab === 'review' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '32px', maxWidth: '1080px', margin: '0 auto' }}>
            {/* Headline Card */}
            <div style={{
              background: 'linear-gradient(135deg, #151d2f, #1e293b)',
              border: '1px solid #2e3c54',
              borderRadius: '16px',
              padding: '28px 36px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <span style={{ fontSize: '12px', color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>
                  Session Recovery Summary
                </span>
                <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#f8fafc', marginTop: '4px' }}>
                  {headline}
                </h1>
                <p style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px' }}>
                  Derived from prolonged eye closures and physical absences with 10s pre-roll and chapter boundary snapping.
                </p>
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={handleExportMarkdown}
                  style={{
                    background: '#1e293b',
                    border: '1px solid #3b82f6',
                    color: '#38bdf8',
                    padding: '10px 18px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  Export Markdown
                </button>
                <button
                  onClick={handleExportJson}
                  style={{
                    background: '#1e293b',
                    border: '1px solid #2e3c54',
                    color: '#cbd5e1',
                    padding: '10px 18px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    cursor: 'pointer'
                  }}
                >
                  Export JSON
                </button>
              </div>
            </div>

            {/* Session Presence Stats Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
              <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '10px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>Watching Time</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: '#10b981', fontFamily: 'monospace', marginTop: '4px' }}>
                  {formatDurationShort(metrics?.watchingDurationSec || 0)}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                  Furthest video: {formatSec(metrics?.furthestVideoTimeSec || 0)}
                </div>
              </div>

              <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '10px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>Absent / Paused</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: '#f43f5e', fontFamily: 'monospace', marginTop: '4px' }}>
                  {formatDurationShort(metrics?.absentDurationSec || 0)}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                  Low camera signal: {formatDurationShort(metrics?.degradedDurationSec || 0)}
                </div>
              </div>

              <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '10px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>Total Blinks</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: '#38bdf8', fontFamily: 'monospace', marginTop: '4px' }}>
                  {metrics?.totalBlinks ?? 0}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                  478-pt live eye mesh
                </div>
              </div>

              <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '10px', padding: '16px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>Recorded Events</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: '#f59e0b', fontFamily: 'monospace', marginTop: '4px' }}>
                  {(session.events || []).length}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                  {(session.events || []).filter((e) => e.type === 'pause').length} pauses · {(session.events || []).filter((e) => e.type === 'marker').length} markers · {(session.events || []).filter((e) => e.type === 'bookmark').length} bookmarks
                </div>
              </div>
            </div>

            {/* Visual Presence Breakdown Bar & Ring */}
            <div style={{
              background: '#151d2f',
              border: '1px solid #2e3c54',
              borderRadius: '12px',
              padding: '20px 24px',
              display: 'flex',
              alignItems: 'center',
              gap: '24px'
            }}>
              {/* SVG Circular Watching Ring */}
              <div style={{ position: 'relative', width: '76px', height: '76px', flexShrink: 0 }}>
                <svg width="76" height="76" viewBox="0 0 76 76" style={{ transform: 'rotate(-90deg)' }}>
                  <circle
                    cx="38"
                    cy="38"
                    r={ringRadius}
                    fill="none"
                    stroke="#1e293b"
                    strokeWidth="7"
                  />
                  <circle
                    cx="38"
                    cy="38"
                    r={ringRadius}
                    fill="none"
                    stroke={watchingPct >= 75 ? '#10b981' : watchingPct >= 50 ? '#f59e0b' : '#f43f5e'}
                    strokeWidth="7"
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringDashOffset}
                    strokeLinecap="round"
                  />
                </svg>
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <span style={{ fontSize: '16px', fontWeight: 800, color: '#f8fafc', fontFamily: 'var(--font-mono)' }}>
                    {watchingPct}%
                  </span>
                  <span style={{ fontSize: '8px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Present
                  </span>
                </div>
              </div>

              {/* 3-Segment Presence Distribution Bar */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                    Session Presence Breakdown
                  </span>
                  <span style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: '#38bdf8',
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    padding: '2px 8px',
                    borderRadius: '10px'
                  }}>
                    Blink Rate: {blinksPerMin} / min
                  </span>
                </div>

                {/* Stacked Proportional Bar */}
                <div style={{
                  height: '12px',
                  width: '100%',
                  background: '#0b0f19',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  display: 'flex',
                  border: '1px solid #1e293b'
                }}>
                  {watchingPct > 0 && (
                    <div
                      title={`Watching: ${formatDurationShort(watchingSec)} (${watchingPct}%)`}
                      style={{
                        width: `${watchingPct}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #059669, #10b981)',
                        transition: 'width 0.3s ease'
                      }}
                    />
                  )}
                  {absentPct > 0 && (
                    <div
                      title={`Absent / Paused: ${formatDurationShort(absentSec)} (${absentPct}%)`}
                      style={{
                        width: `${absentPct}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #e11d48, #f43f5e)',
                        transition: 'width 0.3s ease'
                      }}
                    />
                  )}
                  {degradedPct > 0 && (
                    <div
                      title={`Low Camera Signal: ${formatDurationShort(degradedSec)} (${degradedPct}%)`}
                      style={{
                        width: `${degradedPct}%`,
                        height: '100%',
                        background: '#475569',
                        transition: 'width 0.3s ease'
                      }}
                    />
                  )}
                </div>

                {/* Legend Row */}
                <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', fontSize: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#cbd5e1' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#10b981' }} />
                    <span>Watching: <strong style={{ color: '#f8fafc' }}>{watchingPct}%</strong> ({formatDurationShort(watchingSec)})</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#cbd5e1' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#f43f5e' }} />
                    <span>Absent / Paused: <strong style={{ color: '#f8fafc' }}>{absentPct}%</strong> ({formatDurationShort(absentSec)})</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#cbd5e1' }}>
                    <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: '#64748b' }} />
                    <span>Low Signal: <strong style={{ color: '#f8fafc' }}>{degradedPct}%</strong> ({formatDurationShort(degradedSec)})</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Hybrid AI Session Review Agent (Gemini 2.5 Flash + Local Open-Source Ollama Failover) */}
            <div style={{
              background: '#151d2f',
              border: '1px solid #3b82f6',
              borderRadius: '14px',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h2 style={{ fontSize: '17px', fontWeight: 700, color: '#f8fafc' }}>
                      AI Session Review Agent
                    </h2>
                    {agentMeta && (
                      <span style={{
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontWeight: 600,
                        background: agentMeta.providerUsed === 'gemini'
                          ? 'rgba(59, 130, 246, 0.2)'
                          : agentMeta.providerUsed === 'ollama'
                          ? 'rgba(16, 185, 129, 0.2)'
                          : 'rgba(148, 163, 184, 0.2)',
                        border: `1px solid ${
                          agentMeta.providerUsed === 'gemini'
                            ? '#3b82f6'
                            : agentMeta.providerUsed === 'ollama'
                            ? '#10b981'
                            : '#64748b'
                        }`,
                        color: agentMeta.providerUsed === 'gemini'
                          ? '#60a5fa'
                          : agentMeta.providerUsed === 'ollama'
                          ? '#34d399'
                          : '#cbd5e1'
                      }}>
                        {agentMeta.providerUsed === 'gemini'
                          ? `Gemini: ${agentMeta.modelUsed}`
                          : agentMeta.providerUsed === 'ollama'
                          ? `Local Open-Source: ${agentMeta.modelUsed}`
                          : 'Offline Local Engine'}
                      </span>
                    )}
                    {agentMeta?.transcriptContext?.captionsAvailable && (
                      <span style={{
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontWeight: 600,
                        background: 'rgba(139, 92, 246, 0.18)',
                        border: '1px solid #8b5cf6',
                        color: '#c4b5fd'
                      }}>
                        CC Transcript Synced{agentMeta.transcriptContext.matchedExcerptsCount > 0 ? ` (${agentMeta.transcriptContext.matchedExcerptsCount} excerpts)` : ''}
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '3px' }}>
                    Processes your session JSON into exact timestamps, watching breakdown & rewatch guidance. Auto-switches to local Ollama on quota limits.
                  </p>
                </div>

                {/* Engine, Local Model & Language Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <select
                    value={agentEngine}
                    onChange={(e) => {
                      const nextEngine = e.target.value as AgentEngineMode;
                      setAgentEngine(nextEngine);
                      runAgentQuery(undefined, nextEngine);
                    }}
                    title="Select AI Engine"
                    style={{
                      background: '#0b0f19',
                      border: '1px solid #2e3c54',
                      color: '#f8fafc',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="auto">Auto (Gemini ⚡ Fast → Local Ollama)</option>
                    <option value="gemini" disabled={!agentStatus.geminiConfigured}>
                      Gemini 2.5 Flash (⚡ Fast) {!agentStatus.geminiConfigured ? '(No Key)' : ''}
                    </option>
                    <option value="ollama">
                      Local Open-Source (Ollama)
                    </option>
                    <option value="offline">
                      ⚡ Instant Engine (Offline, 0.0s)
                    </option>
                  </select>

                  {agentStatus.ollamaModels.length > 0 && (
                    <select
                      value={selectedOllamaModel}
                      onChange={(e) => {
                        const nextModel = e.target.value;
                        setSelectedOllamaModel(nextModel);
                        if (agentEngine === 'ollama') {
                          runAgentQuery(undefined, 'ollama');
                        }
                      }}
                      title="Local Open-Source Ollama Model (Failover / Local Mode)"
                      style={{
                        background: '#0b0f19',
                        border: '1px solid #2e3c54',
                        color: '#34d399',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer'
                      }}
                    >
                      {agentStatus.ollamaModels.map((modelName) => (
                        <option key={modelName} value={modelName}>
                          Local: {modelName}
                        </option>
                      ))}
                    </select>
                  )}

                  <select
                    value={agentLanguage}
                    onChange={(e) => {
                      const nextLang = e.target.value as AgentLanguage;
                      setAgentLanguage(nextLang);
                      runAgentQuery(undefined, undefined, nextLang);
                    }}
                    title="Response Language"
                    style={{
                      background: '#0b0f19',
                      border: '1px solid #2e3c54',
                      color: '#cbd5e1',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="english">English</option>
                    <option value="hinglish">Hinglish</option>
                  </select>

                  <button
                    onClick={() => runAgentQuery()}
                    disabled={agentLoading}
                    style={{
                      background: agentLoading ? '#1e293b' : '#2563eb',
                      border: 'none',
                      color: '#fff',
                      padding: '7px 14px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: agentLoading ? 'wait' : 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                  >
                    {agentLoading ? (
                      <>
                        <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8', animation: 'pulse 1s infinite' }} />
                        <span>Analyzing ({loadingElapsedSec.toFixed(1)}s)...</span>
                      </>
                    ) : (
                      'Re-Analyze JSON'
                    )}
                  </button>
                </div>
              </div>

              {agentMeta?.failoverReason && (
                <div style={{
                  background: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid #f59e0b',
                  color: '#fcd34d',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  fontSize: '12px'
                }}>
                  ⚡ {agentMeta.failoverReason}
                </div>
              )}

              {/* Agent Output & Conversation Stream */}
              <div style={{
                background: '#0b0f19',
                border: '1px solid #1e293b',
                borderRadius: '10px',
                padding: '16px',
                maxHeight: '340px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}>
                {chatMessages.length === 0 && !agentLoading && (
                  <div style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', padding: '16px' }}>
                    Click "Re-Analyze JSON" or ask a question below to inspect your lecture session.
                  </div>
                )}

                {chatMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    style={{
                      alignSelf: msg.role === 'user' ? 'flex-end' : 'stretch',
                      background: msg.role === 'user' ? '#1d4ed8' : '#151d2f',
                      border: msg.role === 'user' ? 'none' : '1px solid #2e3c54',
                      borderRadius: '10px',
                      padding: '12px 14px',
                      maxWidth: msg.role === 'user' ? '78%' : '100%',
                      fontSize: '13px',
                      lineHeight: 1.6,
                      color: '#e2e8f0',
                      userSelect: 'text',
                      WebkitUserSelect: 'text'
                    }}
                  >
                    <div style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.6px',
                      color: msg.role === 'user' ? '#bfdbfe' : '#38bdf8',
                      marginBottom: '6px'
                    }}>
                      {msg.role === 'user' ? 'You' : 'Lecture Rewind Agent'}
                    </div>
                    {msg.role === 'assistant'
                      ? renderFormattedMarkdown(msg.content, handleTimestampChipClick)
                      : msg.content}
                  </div>
                ))}

                {agentLoading && (
                  <div style={{
                    background: '#151d2f',
                    border: '1px solid rgba(56, 189, 248, 0.4)',
                    borderRadius: '10px',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{
                          display: 'inline-block',
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          background: '#38bdf8'
                        }} />
                        <span style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 600 }}>
                          Analyzing session JSON timestamps ({loadingElapsedSec.toFixed(1)}s)...
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setAgentEngine('offline');
                          runAgentQuery(undefined, 'offline');
                        }}
                        style={{
                          background: 'rgba(56, 189, 248, 0.16)',
                          border: '1px solid #38bdf8',
                          color: '#38bdf8',
                          padding: '3px 8px',
                          borderRadius: '6px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        ⚡ Show Instant Summary (0.0s)
                      </button>
                    </div>
                    <div style={{ width: '100%', height: '3px', background: '#0b0f19', borderRadius: '2px', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, Math.max(15, (loadingElapsedSec / 2.5) * 100))}%`,
                          background: 'linear-gradient(90deg, #38bdf8, #818cf8)',
                          transition: 'width 0.15s ease-out'
                        }}
                      />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Quick Question Chips */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {[
                  'Where did I miss parts of the lecture?',
                  'How long was I watching vs absent?',
                  'Give me a step-by-step rewatch plan',
                  'Explain all recorded events & bookmarks'
                ].map((chip) => (
                  <button
                    key={chip}
                    disabled={agentLoading}
                    onClick={() => runAgentQuery(chip)}
                    style={{
                      background: '#1e293b',
                      border: '1px solid #2e3c54',
                      color: '#cbd5e1',
                      padding: '5px 10px',
                      borderRadius: '14px',
                      fontSize: '11px',
                      cursor: agentLoading ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {chip}
                  </button>
                ))}
              </div>

              {/* Ask Follow-Up Question Form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chatInput.trim()) runAgentQuery(chatInput);
                }}
                style={{ display: 'flex', gap: '8px' }}
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask anything about this lecture session (e.g., missed timestamps, watching duration)..."
                  disabled={agentLoading}
                  style={{
                    flex: 1,
                    background: '#0b0f19',
                    border: '1px solid #2e3c54',
                    borderRadius: '8px',
                    padding: '10px 14px',
                    color: '#f8fafc',
                    fontSize: '13px'
                  }}
                />
                <button
                  type="submit"
                  disabled={agentLoading || !chatInput.trim()}
                  style={{
                    background: !agentLoading && chatInput.trim() ? '#2563eb' : '#1e293b',
                    border: 'none',
                    color: !agentLoading && chatInput.trim() ? '#fff' : '#64748b',
                    padding: '10px 18px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: !agentLoading && chatInput.trim() ? 'pointer' : 'not-allowed'
                  }}
                >
                  Ask Agent
                </button>
              </form>
            </div>

            {/* Interactive Timeline Visualizer */}
            <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '12px', padding: '24px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f8fafc', marginBottom: '16px' }}>
                Full-Session Timeline
              </h2>

              {/* 1. Quality Ribbon Strip (FR-10, AC-5) */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', marginBottom: '4px' }}>
                  <span>Signal Quality Ribbon</span>
                  <span>Muted: Low Confidence (Excluded from Queue)</span>
                </div>
                <div style={{ height: '10px', background: '#10b981', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                  {(session.quality || []).map((q, i) => (
                    q.isDegraded ? (
                      <div
                        key={i}
                        title={`Low confidence stretch (${formatSec(q.timestamp)} - ${formatSec(q.timestamp + q.duration)})`}
                        style={{
                          position: 'absolute',
                          left: `${(q.timestamp / durationSec) * 100}%`,
                          width: `${(q.duration / durationSec) * 100}%`,
                          height: '100%',
                          background: '#475569'
                        }}
                      />
                    ) : null
                  ))}
                </div>
              </div>

              {/* 2. Detected Absences & Markers Strip */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', marginBottom: '4px' }}>
                  <span>Detected Lapses & Absences</span>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <span style={{ color: '#f43f5e' }}>● Pauses</span>
                    <span style={{ color: '#f59e0b' }}>● Brief Markers</span>
                    <span style={{ color: '#10b981' }}>● Bookmarks</span>
                  </div>
                </div>
                <div style={{ height: '16px', background: '#0b0f19', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                  {(session.events || []).map((ev, i) => (
                    <div
                      key={i}
                      title={`Click to replay ${ev.type.toUpperCase()} at ${formatSec(ev.start)}: ${ev.note || ev.type}`}
                      onClick={() => handleTimestampChipClick(ev.start)}
                      style={{
                        position: 'absolute',
                        left: `${(ev.start / durationSec) * 100}%`,
                        width: `${Math.max(1.2, ((ev.end - ev.start) / durationSec) * 100)}%`,
                        height: '100%',
                        background: ev.type === 'pause' ? '#f43f5e' : ev.type === 'bookmark' ? '#10b981' : '#f59e0b',
                        borderRadius: '2px',
                        cursor: 'pointer',
                        transition: 'opacity 0.15s'
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* 3. Rewind Queue Intervals (Resulting Recovery Playlist) */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', marginBottom: '4px' }}>
                  <span>Compiled Rewind Queue (Pre-rolled + Chapter Snapped)</span>
                  <span style={{ color: '#38bdf8' }}>Total: {formatSec(queueTotalSec)}</span>
                </div>
                <div style={{ height: '14px', background: '#0b0f19', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                  {(queueList || []).map((q, i) => (
                    <div
                      key={i}
                      title={`Click to play Queue #${i + 1}: ${formatSec(q.start)} - ${formatSec(q.end)} (${q.chapterTitle || 'General'})`}
                      onClick={() => openQueueClip(q, i, false)}
                      style={{
                        position: 'absolute',
                        left: `${(q.start / durationSec) * 100}%`,
                        width: `${Math.max(1.5, ((q.end - q.start) / durationSec) * 100)}%`,
                        height: '100%',
                        background: '#38bdf8',
                        borderRadius: '2px',
                        cursor: 'pointer',
                        transition: 'opacity 0.15s'
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* 4. Pulse Context Line (FR-15, PRD Section 8.1 & Section 12) */}
              <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #1e293b' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: '#ec4899' }}>♥</span>
                    <span style={{ fontWeight: 600, color: '#f472b6' }}>Pulse Context (FR-15)</span>
                    <span style={{ color: '#64748b' }}>— 12-second rolling average</span>
                  </div>
                  <span style={{ color: '#64748b', fontStyle: 'italic' }}>
                    Informational only. Never used as an absence trigger or medical assessment.
                  </span>
                </div>

                {(session.pulse || []).length > 0 ? (
                  <div style={{ height: '36px', background: '#0b0f19', borderRadius: '4px', position: 'relative', overflow: 'hidden' }}>
                    <svg style={{ width: '100%', height: '100%', display: 'block' }} viewBox="0 0 1000 36" preserveAspectRatio="none">
                      <line x1="0" y1="26" x2="1000" y2="26" stroke="#1e293b" strokeDasharray="3,3" />
                      <line x1="0" y1="10" x2="1000" y2="10" stroke="#1e293b" strokeDasharray="3,3" />
                      <path
                        d={SessionInsights.calculatePulseSvgPath(session.pulse || [], durationSec)}
                        fill="none"
                        stroke="#ec4899"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                ) : (
                  <div style={{ height: '28px', background: '#0b0f19', borderRadius: '4px', display: 'flex', alignItems: 'center', padding: '0 12px' }}>
                    <span style={{ fontSize: '11px', color: '#64748b' }}>
                      rPPG pulse sensor was inactive during this session. (Informational context only)
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Recovery Clip Player (Opens on 1-click Queue Play or AI Timestamp Click) */}
            {activeClip && (
              <div
                ref={clipPlayerBoxRef}
                style={{
                  background: '#151d2f',
                  border: '1px solid #38bdf8',
                  borderRadius: '14px',
                  overflow: 'hidden',
                  boxShadow: '0 10px 32px rgba(0, 0, 0, 0.45)'
                }}
              >
                <div style={{
                  background: '#0b0f19',
                  borderBottom: '1px solid #1e293b',
                  padding: '12px 20px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '10px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{
                      background: 'rgba(56, 189, 248, 0.2)',
                      color: '#38bdf8',
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '6px',
                      fontFamily: 'var(--font-mono)'
                    }}>
                      {isPlayingSequence ? 'SEQUENTIAL REWIND' : 'RECOVERY CLIP'}
                    </span>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                      {activeClip.title}
                    </span>
                    <span style={{ fontSize: '12px', color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                      {formatSec(activeClip.start)} → {formatSec(activeClip.end)}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button
                      onClick={() => {
                        if (clipVideoRef.current && !youtubeVideoId) {
                          clipVideoRef.current.currentTime = activeClip.start;
                          clipVideoRef.current.play().catch(() => {});
                        } else {
                          setActiveClip({ ...activeClip });
                        }
                      }}
                      style={{
                        background: '#1e293b',
                        border: '1px solid #334155',
                        color: '#cbd5e1',
                        padding: '5px 10px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer'
                      }}
                    >
                      ↺ Replay
                    </button>

                    {activeClip.queueIndex !== undefined && activeClip.queueIndex + 1 < queueList.length && (
                      <button
                        onClick={() => openQueueClip(queueList[activeClip.queueIndex! + 1], activeClip.queueIndex! + 1, isPlayingSequence)}
                        style={{
                          background: '#2563eb',
                          border: 'none',
                          color: '#fff',
                          padding: '5px 12px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        Next Clip ▶
                      </button>
                    )}

                    {activeClip.queueIndex !== undefined && (
                      <button
                        onClick={() => toggleClipReviewed(activeClip.id)}
                        style={{
                          background: reviewedIds.includes(activeClip.id) ? 'rgba(16, 185, 129, 0.2)' : '#1e293b',
                          border: `1px solid ${reviewedIds.includes(activeClip.id) ? '#10b981' : '#334155'}`,
                          color: reviewedIds.includes(activeClip.id) ? '#34d399' : '#cbd5e1',
                          padding: '5px 10px',
                          borderRadius: '6px',
                          fontSize: '12px',
                          cursor: 'pointer'
                        }}
                      >
                        {reviewedIds.includes(activeClip.id) ? '✓ Reviewed' : 'Mark Reviewed'}
                      </button>
                    )}

                    <button
                      onClick={() => {
                        setIsPlayingSequence(false);
                        setActiveClip(null);
                      }}
                      style={{
                        background: 'transparent',
                        border: '1px solid #334155',
                        color: '#94a3b8',
                        padding: '5px 10px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer'
                      }}
                    >
                      ✕ Close
                    </button>
                  </div>
                </div>

                {/* Embedded Recovery Player */}
                <div style={{ background: '#000', height: '340px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {youtubeVideoId ? (
                    <iframe
                      key={`${activeClip.id}-${activeClip.start}-${activeClip.end}`}
                      src={`https://www.youtube.com/embed/${youtubeVideoId}?start=${Math.floor(activeClip.start)}&end=${Math.ceil(activeClip.end)}&autoplay=1&enablejsapi=1&rel=0&modestbranding=1`}
                      title={activeClip.title}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      style={{ width: '100%', height: '100%', border: 'none' }}
                    />
                  ) : clipMediaError ? (
                    <div style={{ textAlign: 'center', padding: '32px 20px', color: '#94a3b8' }}>
                      <p style={{ fontSize: '13px', marginBottom: '14px', color: '#cbd5e1' }}>
                        Local video source requires re-selection (e.g. browser refreshed).
                      </p>
                      <button
                        onClick={() => replayFileInputRef.current?.click()}
                        style={{
                          background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                          border: 'none',
                          color: '#fff',
                          padding: '8px 18px',
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        📁 Re-select Video File ({session.source.name})
                      </button>
                      <input
                        ref={replayFileInputRef}
                        type="file"
                        accept="video/*,.mp4,.webm,.mkv,.mov"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setCustomReplaySrc(URL.createObjectURL(file));
                            setClipMediaError(false);
                          }
                        }}
                        style={{ display: 'none' }}
                      />
                    </div>
                  ) : (
                    <video
                      ref={clipVideoRef}
                      src={activeReplaySrc}
                      controls
                      onError={() => setClipMediaError(true)}
                      onTimeUpdate={() => {
                        if (!clipVideoRef.current || !activeClip) return;
                        const t = clipVideoRef.current.currentTime;
                        setClipCurrentTime(t);
                        if (t >= activeClip.end) {
                          clipVideoRef.current.pause();
                          handleClipEnded();
                        }
                      }}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  )}
                </div>

                {/* Clip Progress Strip */}
                <div style={{ padding: '8px 20px', background: '#0b0f19', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                    {formatSec(clipCurrentTime)}
                  </span>
                  <div style={{ flex: 1, height: '6px', background: '#1e293b', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.max(0, Math.min(100, ((clipCurrentTime - activeClip.start) / Math.max(1, activeClip.end - activeClip.start)) * 100))}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #3b82f6, #38bdf8)',
                      transition: 'width 0.15s linear'
                    }} />
                  </div>
                  <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                    {formatSec(activeClip.end)}
                  </span>
                </div>
              </div>
            )}

            {/* Rewind Queue Items List */}
            <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '12px', padding: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f8fafc' }}>
                    Rewind Queue Items ({queueList.length})
                  </h2>
                  {queueList.length > 0 && (
                    <span style={{
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: reviewedIds.length === queueList.length ? 'rgba(16, 185, 129, 0.2)' : 'rgba(56, 189, 248, 0.14)',
                      border: `1px solid ${reviewedIds.length === queueList.length ? '#10b981' : '#38bdf8'}`,
                      color: reviewedIds.length === queueList.length ? '#34d399' : '#38bdf8'
                    }}>
                      Reviewed: {reviewedIds.length} / {queueList.length}
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {queueList.length > 0 && (
                    <button
                      onClick={handlePlayAllSequential}
                      style={{
                        background: 'linear-gradient(135deg, #2563eb, #0284c7)',
                        color: '#fff',
                        border: 'none',
                        padding: '7px 14px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: 600
                      }}
                    >
                      ▶ Play All Missed Clips
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {queueList.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#64748b', padding: '30px', fontSize: '13px' }}>
                    No absence intervals detected. You watched the entire lecture!
                  </div>
                ) : (
                  queueList.map((item, idx) => {
                    const isReviewed = reviewedIds.includes(item.id);
                    const isCurrentlyPlaying = activeClip?.id === item.id;
                    return (
                      <div
                        key={item.id}
                        style={{
                          background: isCurrentlyPlaying ? 'rgba(37, 99, 235, 0.18)' : '#1e293b',
                          border: `1px solid ${isCurrentlyPlaying ? '#38bdf8' : isReviewed ? '#10b981' : '#2e3c54'}`,
                          borderRadius: '8px',
                          padding: '14px 20px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          opacity: isReviewed && !isCurrentlyPlaying ? 0.78 : 1
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{
                              background: isReviewed ? '#10b981' : '#2563eb',
                              color: '#fff',
                              width: '24px',
                              height: '24px',
                              borderRadius: '50%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '12px',
                              fontWeight: 700
                            }}>
                              {isReviewed ? '✓' : idx + 1}
                            </span>
                            <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                              {item.chapterTitle || `Segment ${idx + 1}`}
                            </span>
                            {isCurrentlyPlaying && (
                              <span style={{ fontSize: '10px', color: '#38bdf8', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                NOW PLAYING
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px', marginLeft: '34px' }}>
                            Range: {formatSec(item.start)} → {formatSec(item.end)} (+10s pre-roll applied)
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#38bdf8', fontFamily: 'monospace' }}>
                            {item.duration}s
                          </span>
                          <button
                            onClick={() => toggleClipReviewed(item.id)}
                            style={{
                              background: isReviewed ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                              border: `1px solid ${isReviewed ? '#10b981' : '#334155'}`,
                              color: isReviewed ? '#34d399' : '#94a3b8',
                              padding: '6px 10px',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              fontSize: '11px',
                              fontWeight: 500
                            }}
                          >
                            {isReviewed ? '✓ Reviewed' : 'Mark Reviewed'}
                          </button>
                          <button
                            onClick={() => openQueueClip(item, idx, false)}
                            style={{
                              background: isCurrentlyPlaying ? '#0284c7' : '#3b82f6',
                              color: '#fff',
                              border: 'none',
                              padding: '6px 14px',
                              borderRadius: '6px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontWeight: 600
                            }}
                          >
                            {isCurrentlyPlaying ? 'Playing...' : 'Play Clip ▶'}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Individual Detected Missed Moments (Instant 1-Click Lapses Replay) */}
              {missedEvents.length > 0 && (
                <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #2e3c54' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                        Individual Detected Missed Lapses ({missedEvents.length})
                      </span>
                      <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                        (Exact timestamps where absence or closure was detected)
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {missedEvents.map((ev, i) => {
                      const isCurrent = activeClip?.id === `event-${ev.id}`;
                      const dur = Math.max(1, Math.round(ev.end - ev.start));
                      return (
                        <div
                          key={ev.id || i}
                          style={{
                            background: isCurrent ? 'rgba(37, 99, 235, 0.18)' : '#101625',
                            border: `1px solid ${isCurrent ? '#38bdf8' : '#233048'}`,
                            borderRadius: '8px',
                            padding: '10px 16px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              background: ev.type === 'pause' ? '#f43f5e' : '#f59e0b'
                            }} />
                            <span style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc' }}>
                              Lapse #{i + 1}: {formatSec(ev.start)} → {formatSec(ev.end)}
                            </span>
                            <span style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>
                              ({ev.note || (ev.type === 'pause' ? 'Absence Auto-Pause' : 'Brief Eye Closure')})
                            </span>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '12px', color: '#38bdf8', fontFamily: 'monospace' }}>
                              {dur}s missed
                            </span>
                            <button
                              onClick={() => {
                                const startSec = Math.max(0, ev.start - 5);
                                const endSec = Math.min(durationSec, ev.end + 2);
                                setIsPlayingSequence(false);
                                setActiveClip({
                                  id: `event-${ev.id}`,
                                  title: `Missed Lapse #${i + 1} (${formatSec(ev.start)} → ${formatSec(ev.end)})`,
                                  start: startSec,
                                  end: endSec
                                });
                                setClipCurrentTime(startSec);
                                setTimeout(() => {
                                  clipPlayerBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }, 60);
                              }}
                              style={{
                                background: isCurrent ? '#0284c7' : '#2563eb',
                                color: '#fff',
                                border: 'none',
                                padding: '5px 12px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: 600
                              }}
                            >
                              {isCurrent ? 'Playing Clip...' : '▶ Play Missed Clip'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Privacy & Firewall Panel */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '780px', margin: '0 auto' }}>
            <div style={{ background: '#151d2f', border: '1px solid #2e3c54', borderRadius: '12px', padding: '28px' }}>
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: '#f8fafc', marginBottom: '8px' }}>
                Local Privacy Firewall (Acceptance Criterion 8)
              </h2>
              <p style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '20px' }}>
                Lecture Rewind operates in total isolation on your machine. Outbound network requests are intercepted and counted by Electron's native session firewall.
              </p>

              {/* Verified Network Request Counter (AC-8) */}
              <div style={{
                background: '#0b0f19',
                border: '1px solid #10b981',
                borderRadius: '10px',
                padding: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '20px'
              }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 600, textTransform: 'uppercase' }}>
                    Verified Local Isolation
                  </div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', marginTop: '2px' }}>
                    Application Network Requests: {networkStats.applicationNetworkRequestsCount}
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                    Internal dev server allowed: {networkStats.allowedRequestsCount} | External blocked: {networkStats.blockedRequestsCount}
                  </div>
                </div>
                <div style={{ fontSize: '32px' }}>🛡️</div>
              </div>

              {/* SDK Telemetry Control (FR-18) */}
              <div style={{ background: '#1e293b', border: '1px solid #2e3c54', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                      SmartSpectra SDK Telemetry (FR-18)
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
                      Disabled by default. When enabled, sends aggregate session metrics only (never video or numeric landmarks).
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={telemetryEnabled}
                      onChange={async (e) => {
                        const val = e.target.checked;
                        setTelemetryEnabled(val);
                        try {
                          if ((window as any).rewindApi?.consent) {
                            const current = await (window as any).rewindApi.consent.get();
                            await (window as any).rewindApi.consent.set({
                              granted: current?.granted ?? true,
                              timestamp: current?.timestamp || new Date().toISOString(),
                              telemetryEnabled: val
                            });
                          }
                        } catch {
                          // Standalone fallback
                        }
                      }}
                    />
                    <span style={{ fontSize: '13px', color: telemetryEnabled ? '#38bdf8' : '#64748b' }}>
                      {telemetryEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
              </div>

              {/* 1-Click Complete Data Wipe (FR-16, Acceptance Criterion 7) */}
              <div style={{ borderTop: '1px solid #2e3c54', paddingTop: '20px' }}>
                <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#f43f5e', marginBottom: '6px' }}>
                  Irreversible Data Erasure (FR-16, AC-7)
                </h3>
                <p style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '14px' }}>
                  Permanently wipe all session histories, consent timestamps, and local calibration parameters from your device.
                </p>

                {deleteConfirmation ? (
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <button
                      onClick={handle1ClickWipeAll}
                      style={{
                        background: '#dc2626',
                        color: '#fff',
                        border: 'none',
                        padding: '10px 18px',
                        borderRadius: '8px',
                        fontWeight: 600,
                        fontSize: '13px',
                        cursor: 'pointer'
                      }}
                    >
                      Confirm Permanent Wipe
                    </button>
                    <button
                      onClick={() => setDeleteConfirmation(false)}
                      style={{
                        background: 'transparent',
                        color: '#94a3b8',
                        border: '1px solid #2e3c54',
                        padding: '10px 18px',
                        borderRadius: '8px',
                        fontSize: '13px',
                        cursor: 'pointer'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteConfirmation(true)}
                    style={{
                      background: 'rgba(244, 63, 94, 0.15)',
                      border: '1px solid #f43f5e',
                      color: '#f43f5e',
                      padding: '10px 18px',
                      borderRadius: '8px',
                      fontWeight: 600,
                      fontSize: '13px',
                      cursor: 'pointer'
                    }}
                  >
                    1-Click Delete All Data
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
