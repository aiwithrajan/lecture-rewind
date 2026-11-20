import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SessionDocument, VideoSource } from '@shared/types';
import { QueueBuilder } from '../engine/QueueBuilder';
import { SessionInsights } from '../engine/SessionInsights';

interface HomeScreenProps {
  onStartSession: (source: VideoSource, simulatedMode: boolean) => void;
  onOpenReview: (session: SessionDocument) => void;
  onOpenPrivacy: () => void;
  simulatedMode: boolean;
  onToggleSimulatedMode: (enabled: boolean) => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  onStartSession,
  onOpenReview,
  onOpenPrivacy,
  simulatedMode,
  onToggleSimulatedMode
}) => {
  const [recentSessions, setRecentSessions] = useState<SessionDocument[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    setLoading(true);
    try {
      if ((window as any).rewindApi?.sessions) {
        const sessions = await (window as any).rewindApi.sessions.list();
        setRecentSessions(sessions);
      }
    } catch {
      // In standalone browser or simulation mode
    } finally {
      setLoading(false);
    }
  };

  // FR-12 Session history: When 3 or more sessions of the same source exist,
  // report typical absence offset and offer to schedule a break there.
  const sourceInsights = useMemo(() => {
    return SessionInsights.calculateSourceInsights(recentSessions);
  }, [recentSessions]);

  const handlePickLocalFile = async () => {
    const isElectron =
      typeof navigator !== 'undefined' &&
      /electron/i.test(navigator.userAgent) &&
      Boolean((window as any).rewindApi?.dialog?.openVideoFile);

    if (isElectron) {
      try {
        const filePath = await (window as any).rewindApi.dialog.openVideoFile();
        if (filePath) {
          const fileName = filePath.split(/[/\\]/).pop() || 'Local Lecture Video';
          onStartSession(
            {
              type: 'local',
              pathOrUrl: filePath,
              duration: 3600,
              name: fileName
            },
            simulatedMode
          );
          return;
        }
      } catch (err) {
        console.warn('Native Electron openVideoFile error, falling back to browser picker:', err);
      }
    }

    // In web browser / Vercel deployment: open native file selection dialog
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleBrowserFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const nativePath = (file as any).path as string | undefined;
    const blobOrPath = nativePath || URL.createObjectURL(file);
    onStartSession(
      {
        type: 'local',
        pathOrUrl: blobOrPath,
        duration: 3600,
        name: file.name || 'Local Lecture Video'
      },
      simulatedMode
    );
    e.target.value = '';
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = urlInput.trim();
    if (!raw) return;

    let displayName = raw.split('/').pop() || 'Web Lecture';
    try {
      const parsed = new URL(raw);
      const ytId = parsed.searchParams.get('v');
      if (parsed.hostname.includes('youtube.com') && ytId) {
        displayName = `YouTube Lecture (${ytId})`;
      } else if (parsed.hostname === 'youtu.be') {
        displayName = `YouTube Lecture (${parsed.pathname.replace(/^\//, '')})`;
      }
    } catch {
      // Keep fallback display name
    }

    onStartSession(
      {
        type: 'url',
        pathOrUrl: raw,
        duration: 3600,
        name: displayName
      },
      simulatedMode
    );
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: '32px 48px' }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '36px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px', color: '#f8fafc' }}>
            Lecture Rewind
          </h1>
          <p style={{ fontSize: '14px', color: '#94a3b8', marginTop: '4px' }}>
            Watches a recorded lecture with you and turns absent intervals into a recovery queue.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Simulated Mode Toggle (FR-17, AC-6) */}
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: simulatedMode ? 'rgba(59, 130, 246, 0.15)' : 'rgba(30, 41, 59, 0.6)',
            padding: '8px 14px',
            borderRadius: '8px',
            border: `1px solid ${simulatedMode ? '#3b82f6' : '#2e3c54'}`,
            cursor: 'pointer',
            fontSize: '13px',
            color: simulatedMode ? '#60a5fa' : '#94a3b8'
          }}>
            <input
              type="checkbox"
              checked={simulatedMode}
              onChange={(e) => onToggleSimulatedMode(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <span>Simulated Mode (No Camera / Trace Replay)</span>
          </label>

          <button
            onClick={onOpenPrivacy}
            style={{
              background: 'transparent',
              border: '1px solid #2e3c54',
              color: '#94a3b8',
              padding: '8px 14px',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            Privacy & Firewall
          </button>
        </div>
      </header>

      {/* Main Grid: Source Picker & Recent Sessions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '32px', flex: 1, minHeight: 0 }}>
        {/* Source Selection Card */}
        <section style={{
          background: '#151d2f',
          border: '1px solid #2e3c54',
          borderRadius: '12px',
          padding: '28px',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px'
        }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#f8fafc', marginBottom: '8px' }}>
              Select a Lecture Video
            </h2>
            <p style={{ fontSize: '13px', color: '#94a3b8' }}>
              Select a local MP4, MKV, or WebM video file from your computer or device. Chapter markers (.vtt or .json) are parsed automatically.
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mp4,.mkv,.webm,.mov,.m4v,.avi"
            onChange={handleBrowserFileSelected}
            style={{ display: 'none' }}
          />

          <button
            onClick={handlePickLocalFile}
            style={{
              padding: '20px',
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              border: 'none',
              borderRadius: '10px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              boxShadow: '0 4px 12px rgba(37, 99, 235, 0.25)'
            }}
          >
            <span style={{ fontSize: '20px' }}>📁</span>
            Choose / Upload Video File (.mp4, .webm)
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '-4px' }}>
            <span style={{ fontSize: '12px', color: '#64748b' }}>Quick Sample:</span>
            <button
              type="button"
              onClick={() => {
                const isElectron =
                  typeof navigator !== 'undefined' &&
                  /electron/i.test(navigator.userAgent);
                const sampleSrc = isElectron
                  ? '/Users/apple/Desktop/relay-demo.mp4'
                  : 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
                onStartSession(
                  {
                    type: isElectron ? 'local' : 'url',
                    pathOrUrl: sampleSrc,
                    duration: 134,
                    name: isElectron ? 'relay-demo.mp4' : 'sample-lecture.mp4'
                  },
                  simulatedMode
                );
              }}
              style={{
                background: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                color: '#38bdf8',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: 'pointer',
                fontWeight: 600
              }}
            >
              ▶ Start with Quick Sample
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '4px 0' }}>
            <div style={{ flex: 1, height: '1px', background: '#2e3c54' }}></div>
            <span style={{ fontSize: '12px', color: '#64748b' }}>OR PLAY FROM URL</span>
            <div style={{ flex: 1, height: '1px', background: '#2e3c54' }}></div>
          </div>

          <form onSubmit={handleUrlSubmit} style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              placeholder="https://www.youtube.com/watch?v=... or direct .mp4 URL"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              style={{
                flex: 1,
                padding: '12px 14px',
                background: '#0b0f19',
                border: '1px solid #2e3c54',
                borderRadius: '8px',
                color: '#f8fafc',
                fontSize: '13px'
              }}
            />
            <button
              type="submit"
              disabled={!urlInput.trim()}
              style={{
                padding: '12px 18px',
                background: urlInput.trim() ? '#3b82f6' : '#1e293b',
                color: urlInput.trim() ? '#fff' : '#64748b',
                border: 'none',
                borderRadius: '8px',
                cursor: urlInput.trim() ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                fontSize: '13px'
              }}
            >
              Play
            </button>
          </form>

          {/* Compliance & Principle Note */}
          <div style={{
            marginTop: 'auto',
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid #1e293b',
            borderRadius: '8px',
            padding: '14px',
            fontSize: '12px',
            color: '#94a3b8',
            lineHeight: 1.5
          }}>
            <strong style={{ color: '#cbd5e1' }}>Design Principle:</strong> Physical presence, never comprehension.
            Lecture Rewind observes camera visibility and eyelid aperture strictly to locate parts of the lecture that played while you were away.
          </div>
        </section>

        {/* Recent Sessions List */}
        <section style={{
          background: '#151d2f',
          border: '1px solid #2e3c54',
          borderRadius: '12px',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#f8fafc', marginBottom: '14px' }}>
            Recent Sessions
          </h2>

          {/* FR-12: Typical Absence Offset Recommendation */}
          {sourceInsights.length > 0 && (
            <div style={{
              background: 'rgba(56, 189, 248, 0.12)',
              border: '1px solid #0284c7',
              borderRadius: '8px',
              padding: '12px 14px',
              marginBottom: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '14px' }}>💡</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8' }}>
                  Session History Insight (FR-12)
                </span>
              </div>
              {sourceInsights.map((insight, idx) => {
                const mins = Math.floor(insight.typicalOffsetSec / 60);
                const secs = insight.typicalOffsetSec % 60;
                const formatted = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
                return (
                  <div key={idx} style={{ fontSize: '12px', color: '#cbd5e1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <span style={{ flex: 1, minWidth: '220px' }}>
                      Across {insight.sessionCount} sessions of <strong>{insight.source.name}</strong>, physical absence typically occurred around <strong>{formatted}</strong>.
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartSession(
                          { ...insight.source, scheduledBreakSec: insight.typicalOffsetSec },
                          simulatedMode
                        );
                      }}
                      style={{
                        background: '#0284c7',
                        border: 'none',
                        color: '#fff',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      ⏱ Schedule Break at {formatted}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {loading ? (
              <div style={{ color: '#64748b', fontSize: '13px', padding: '20px' }}>Loading sessions...</div>
            ) : recentSessions.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '13px', padding: '30px 10px', textAlign: 'center' }}>
                No completed sessions yet. Start a lecture to generate your first Rewind Queue.
              </div>
            ) : (
              recentSessions.map((session) => {
                const totalRewatchSec = QueueBuilder.calculateTotalDuration(session.queue || []);
                const watchedSec = session.source.duration || 3600;
                const headline = QueueBuilder.formatReviewHeadline(watchedSec, totalRewatchSec);

                return (
                  <div
                    key={session.id}
                    onClick={() => onOpenReview(session)}
                    style={{
                      background: '#1e293b',
                      border: '1px solid #2e3c54',
                      borderRadius: '8px',
                      padding: '12px 16px',
                      cursor: 'pointer',
                      transition: 'background 0.2s',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
                        {session.source.name}
                      </span>
                      <span style={{ fontSize: '11px', color: '#64748b' }}>
                        {new Date(session.startedAt).toLocaleDateString()}
                      </span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: '#38bdf8' }}>
                        {headline}
                      </span>
                      <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                        {(session.queue || []).length} queue items
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
