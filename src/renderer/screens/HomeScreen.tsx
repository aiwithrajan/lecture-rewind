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
  const [activeNav, setActiveNav] = useState<'home' | 'history' | 'settings' | 'about'>('home');
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

  // Demo fallback session to ensure recent sessions list always looks populated
  const displaySessions: SessionDocument[] = useMemo(() => {
    if (recentSessions.length > 0) return recentSessions;
    return [
      {
        version: 1,
        id: 'demo-devbridge-1',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        source: {
          type: 'url',
          pathOrUrl: 'https://www.youtube.com/watch?v=DL14YK4us90',
          duration: 115,
          name: 'DevBridge_Demo_Video.mp4'
        },
        calibration: {
          completedAt: new Date().toISOString(),
          baselineEar: 0.28,
          closureThreshold: 0.20,
          detectionLatencyMs: 190,
          baselinePitch: 0,
          baselineYaw: 0,
          qualityThreshold: 0.6,
          userSensitivity: 6.0,
          verdicts: {
            ear: { reliable: true, score: 0.95 },
            pose: { reliable: true, score: 0.92 },
            overall: 'reliable'
          }
        },
        events: [],
        quality: [],
        pulse: [],
        queue: [
          {
            id: 'demo-q1',
            start: 21,
            end: 43,
            duration: 22,
            chapterTitle: 'Segment 1: Spoken Code Briefing',
            sourceEventIds: ['demo-e1']
          }
        ]
      }
    ];
  }, [recentSessions]);

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      width: '100vw',
      background: '#090d16',
      color: '#f8fafc',
      overflow: 'hidden',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      {/* Hidden file input for web / electron file picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mp4,.mkv,.webm,.mov,.m4v,.avi"
        onChange={handleBrowserFileSelected}
        style={{ display: 'none' }}
      />

      {/* 1. Left Sidebar Navigation */}
      <aside style={{
        width: '90px',
        background: '#070a12',
        borderRight: '1px solid rgba(255, 255, 255, 0.06)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '24px 0 20px 0',
        zIndex: 20
      }}>
        {/* Brand App Icon */}
        <div style={{
          width: '46px',
          height: '46px',
          borderRadius: '14px',
          background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(6, 182, 212, 0.2))',
          border: '1px solid rgba(99, 102, 241, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '36px',
          boxShadow: '0 0 24px rgba(99, 102, 241, 0.3)'
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 4V1L8 5L12 9V6C15.31 6 18 8.69 18 12C18 13.01 17.75 13.97 17.3 14.8L18.76 16.26C19.54 15.03 20 13.57 20 12C20 7.58 16.42 4 12 4ZM12 18C8.69 18 6 15.31 6 12C6 10.99 6.25 10.03 6.7 9.2L5.24 7.74C4.46 8.97 4 10.43 4 12C4 16.42 7.58 20 12 20V23L16 19L12 15V18Z" fill="url(#brandGrad)" />
            <polygon points="10,9 15,12 10,15" fill="#38bdf8" />
            <defs>
              <linearGradient id="brandGrad" x1="4" y1="4" x2="20" y2="20">
                <stop stopColor="#a855f7" />
                <stop offset="1" stopColor="#06b6d4" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* Nav Links */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%', padding: '0 12px' }}>
          {/* Home Tab */}
          <button
            onClick={() => setActiveNav('home')}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              padding: '12px 6px',
              borderRadius: '12px',
              border: activeNav === 'home' ? 'none' : '1px solid transparent',
              background: activeNav === 'home'
                ? 'linear-gradient(135deg, #4f46e5, #2563eb)'
                : 'transparent',
              color: activeNav === 'home' ? '#fff' : '#64748b',
              cursor: 'pointer',
              boxShadow: activeNav === 'home' ? '0 4px 16px rgba(79, 70, 229, 0.4)' : 'none',
              transition: 'all 0.2s'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span style={{ fontSize: '11px', fontWeight: 600 }}>Home</span>
          </button>

          {/* History Tab */}
          <button
            onClick={() => {
              setActiveNav('history');
              if (displaySessions[0]) onOpenReview(displaySessions[0]);
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              padding: '12px 6px',
              borderRadius: '12px',
              border: activeNav === 'history' ? 'none' : '1px solid transparent',
              background: activeNav === 'history' ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: activeNav === 'history' ? '#f8fafc' : '#64748b',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span style={{ fontSize: '11px', fontWeight: 500 }}>History</span>
          </button>

          {/* Settings Tab */}
          <button
            onClick={() => {
              setActiveNav('settings');
              onToggleSimulatedMode(!simulatedMode);
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              padding: '12px 6px',
              borderRadius: '12px',
              border: activeNav === 'settings' ? 'none' : '1px solid transparent',
              background: activeNav === 'settings' ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: activeNav === 'settings' ? '#f8fafc' : '#64748b',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span style={{ fontSize: '11px', fontWeight: 500 }}>Settings</span>
          </button>

          {/* About / Privacy Tab */}
          <button
            onClick={() => {
              setActiveNav('about');
              onOpenPrivacy();
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              padding: '12px 6px',
              borderRadius: '12px',
              border: activeNav === 'about' ? 'none' : '1px solid transparent',
              background: activeNav === 'about' ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: activeNav === 'about' ? '#f8fafc' : '#64748b',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span style={{ fontSize: '11px', fontWeight: 500 }}>About</span>
          </button>
        </nav>

        {/* Bottom AI Status Card in Sidebar */}
        <div style={{
          marginTop: 'auto',
          background: 'rgba(15, 23, 42, 0.8)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          padding: '10px 8px',
          width: '74px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px'
        }}>
          <div style={{
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            background: 'rgba(234, 179, 8, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#eab308',
            fontSize: '12px'
          }}>
            ⚡
          </div>
          <span style={{ fontSize: '9px', color: '#94a3b8', textAlign: 'center', lineHeight: 1.2 }}>Powered by AI</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 6px #10b981' }}></span>
            <span style={{ fontSize: '9px', color: '#10b981', fontWeight: 600 }}>Online</span>
          </div>
        </div>
      </aside>

      {/* 2. Main Content Dashboard */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        padding: '28px 40px',
        position: 'relative'
      }}>
        {/* Top Hero Header */}
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '26px'
        }}>
          {/* Left Title & Description */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
            {/* Glowing Logo Circle */}
            <div style={{
              width: '54px',
              height: '54px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(56, 189, 248, 0.25) 0%, rgba(99, 102, 241, 0.1) 70%, transparent 100%)',
              border: '2px solid rgba(56, 189, 248, 0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 28px rgba(56, 189, 248, 0.35)'
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M12 4V1L8 5L12 9V6C15.31 6 18 8.69 18 12C18 13.01 17.75 13.97 17.3 14.8L18.76 16.26C19.54 15.03 20 13.57 20 12C20 7.58 16.42 4 12 4Z" fill="#38bdf8" />
                <path d="M12 18C8.69 18 6 15.31 6 12C6 10.99 6.25 10.03 6.7 9.2L5.24 7.74C4.46 8.97 4 10.43 4 12C4 16.42 7.58 20 12 20V23L16 19L12 15V18Z" fill="#a855f7" />
                <polygon points="10,9 15,12 10,15" fill="#38bdf8" />
              </svg>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <h1 style={{ fontSize: '32px', fontWeight: 800, letterSpacing: '-0.5px', margin: 0 }}>
                  Lecture <span style={{
                    background: 'linear-gradient(135deg, #c084fc, #38bdf8)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent'
                  }}>Rewind</span>
                </h1>
              </div>
              <p style={{ fontSize: '13px', color: '#94a3b8', margin: '4px 0 10px 0' }}>
                Watch a recorded lecture with you and turns absent intervals into a recovery queue.
              </p>

              {/* 3 Pill Badges */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  background: 'rgba(30, 41, 59, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '20px',
                  padding: '4px 12px',
                  fontSize: '11px',
                  color: '#e2e8f0'
                }}>
                  <span style={{ color: '#eab308' }}>⚡</span> Smart Detection
                </span>

                <span style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  background: 'rgba(30, 41, 59, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '20px',
                  padding: '4px 12px',
                  fontSize: '11px',
                  color: '#e2e8f0'
                }}>
                  <span style={{ color: '#38bdf8' }}>✨</span> Instant Rewind
                </span>

                <span style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  background: 'rgba(30, 41, 59, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '20px',
                  padding: '4px 12px',
                  fontSize: '11px',
                  color: '#e2e8f0'
                }}>
                  <span style={{ color: '#10b981' }}>📊</span> Track Progress
                </span>
              </div>
            </div>
          </div>

          {/* Right Hero Graphic & Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Status Pill Badge */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'rgba(15, 23, 42, 0.8)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: '24px',
              padding: '6px 14px',
              fontSize: '12px',
              color: '#f8fafc',
              boxShadow: '0 0 16px rgba(16, 185, 129, 0.15)'
            }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }}></span>
              <span style={{ fontWeight: 600 }}>Ready to Rewind</span>
              <svg width="20" height="12" viewBox="0 0 24 12" fill="none">
                <path d="M0 6Q3 0 6 6T12 6T18 6T24 6" stroke="#38bdf8" strokeWidth="2" fill="none" />
              </svg>
            </div>

            {/* Profile Avatar */}
            <div style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #a855f7, #6366f1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '14px',
              color: '#fff',
              boxShadow: '0 0 12px rgba(168, 85, 247, 0.4)'
            }}>
              R
            </div>
          </div>
        </header>

        {/* 3. Main Dual Column Grid */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr',
          gap: '24px',
          flex: 1,
          minHeight: 0
        }}>
          {/* Card Left: Select a Lecture Video */}
          <section style={{
            background: 'linear-gradient(180deg, rgba(21, 29, 47, 0.95), rgba(15, 23, 42, 0.95))',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: '16px',
            padding: '24px 28px',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 0 24px rgba(56, 189, 248, 0.08)'
          }}>
            {/* Header with Cloud Icon */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(56, 189, 248, 0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38bdf8'
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
                </svg>
              </div>
              <div>
                <h2 style={{ fontSize: '17px', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  Select a Lecture Video
                </h2>
                <p style={{ fontSize: '12px', color: '#94a3b8', margin: '2px 0 0 0' }}>
                  Choose a local file or paste a YouTube URL. We'll find the moments you missed.
                </p>
              </div>
            </div>

            {/* Glowing Big Upload Dropzone */}
            <div
              onClick={handlePickLocalFile}
              style={{
                border: '1.5px dashed rgba(56, 189, 248, 0.45)',
                borderRadius: '14px',
                padding: '30px 20px',
                background: 'linear-gradient(180deg, rgba(30, 41, 59, 0.35), rgba(15, 23, 42, 0.6))',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                boxShadow: 'inset 0 0 20px rgba(56, 189, 248, 0.04)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#38bdf8';
                e.currentTarget.style.boxShadow = '0 0 20px rgba(56, 189, 248, 0.15), inset 0 0 20px rgba(56, 189, 248, 0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.45)';
                e.currentTarget.style.boxShadow = 'inset 0 0 20px rgba(56, 189, 248, 0.04)';
              }}
            >
              <div style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                background: 'rgba(56, 189, 248, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38bdf8'
              }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                  <path d="M12 12v9" />
                  <path d="m8 16 4-4 4 4" />
                </svg>
              </div>

              <div style={{ textAlign: 'center' }}>
                <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc', display: 'block' }}>
                  Choose / Upload Video File
                </span>
                <span style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px', display: 'block' }}>
                  MP4, MKV, or WebM • Max size: 500MB
                </span>
              </div>
            </div>

            {/* Quick Sample Button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '12px', color: '#64748b' }}>Quick Sample:</span>
              <button
                type="button"
                onClick={() => {
                  onStartSession(
                    {
                      type: 'url',
                      pathOrUrl: 'https://www.youtube.com/watch?v=DL14YK4us90',
                      duration: 115,
                      name: 'Presage Challenge Demo (YouTube)',
                      chapters: [
                        { start: 0, end: 35, title: 'Introduction & Mission' },
                        { start: 35, end: 75, title: 'Face Mesh & Signal Tracking' },
                        { start: 75, end: 115, title: 'Rewind Queue & Privacy' }
                      ]
                    },
                    simulatedMode
                  );
                }}
                style={{
                  background: 'rgba(79, 70, 229, 0.15)',
                  border: '1px solid rgba(99, 102, 241, 0.4)',
                  color: '#818cf8',
                  borderRadius: '20px',
                  padding: '6px 16px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.2s',
                  boxShadow: '0 0 12px rgba(99, 102, 241, 0.2)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(79, 70, 229, 0.3)';
                  e.currentTarget.style.borderColor = '#818cf8';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(79, 70, 229, 0.15)';
                  e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.4)';
                }}
              >
                <span>▶</span> Start with Demo Video
              </button>
            </div>

            {/* OR PLAY FROM URL Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '2px 0' }}>
              <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }}></div>
              <span style={{ fontSize: '11px', letterSpacing: '0.5px', color: '#64748b', fontWeight: 600 }}>OR PLAY FROM URL</span>
              <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }}></div>
            </div>

            {/* URL Input Form */}
            <form onSubmit={handleUrlSubmit} style={{ display: 'flex', gap: '8px' }}>
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: '#0c1220',
                border: '1px solid #1e293b',
                borderRadius: '8px',
                padding: '0 12px'
              }}>
                <span style={{ color: '#64748b', fontSize: '14px' }}>🔗</span>
                <input
                  type="text"
                  placeholder="https://www.youtube.com/watch?v=... or direct .mp4 URL"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    color: '#f8fafc',
                    fontSize: '12px',
                    padding: '12px 0',
                    outline: 'none'
                  }}
                />
              </div>

              <button
                type="submit"
                style={{
                  padding: '0 20px',
                  background: 'linear-gradient(135deg, #a855f7, #06b6d4)',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 16px rgba(168, 85, 247, 0.35)'
                }}
              >
                <span>▶</span> Play
              </button>
            </form>

            {/* Bottom Design Principle Box */}
            <div style={{
              marginTop: 'auto',
              background: 'rgba(15, 23, 42, 0.65)',
              border: '1px solid rgba(56, 189, 248, 0.2)',
              borderRadius: '10px',
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px'
            }}>
              <div style={{
                width: '30px',
                height: '30px',
                borderRadius: '50%',
                background: 'rgba(56, 189, 248, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38bdf8',
                flexShrink: 0
              }}>
                💡
              </div>
              <div style={{ flex: 1, fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                <strong style={{ color: '#38bdf8', display: 'block', marginBottom: '2px' }}>Design Principle</strong>
                Physical presence, never comprehension: Lecture Rewind observes camera visibility and eyelid aperture strictly to locate parts of the lecture that played while you were away.
              </div>
              <div style={{ color: '#64748b', opacity: 0.6, flexShrink: 0 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                  <line x1="2" y1="2" x2="22" y2="22" />
                </svg>
              </div>
            </div>
          </section>

          {/* Card Right: Recent Sessions */}
          <section style={{
            background: 'linear-gradient(180deg, rgba(21, 29, 47, 0.95), rgba(15, 23, 42, 0.95))',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '16px',
            padding: '24px 28px',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)'
          }}>
            {/* Header with Clock Icon & View All Button */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px', color: '#818cf8' }}>🕒</span>
                <h2 style={{ fontSize: '17px', fontWeight: 700, color: '#f8fafc', margin: 0 }}>
                  Recent Sessions
                </h2>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (displaySessions[0]) onOpenReview(displaySessions[0]);
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '20px',
                  padding: '4px 12px',
                  color: '#cbd5e1',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                View All →
              </button>
            </div>

            {/* FR-12 Session History Insights */}
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
                        Across {insight.sessionCount} sessions of <strong>{insight.source.name}</strong>, absence typically occurred around <strong>{formatted}</strong>.
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
                          padding: '4px 10px',
                          borderRadius: '6px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        ⏱ Break at {formatted}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Sessions List */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {displaySessions.map((session) => {
                const totalRewatchSec = QueueBuilder.calculateTotalDuration(session.queue || []);
                const watchedSec = session.source.duration || 3600;
                const queueCount = (session.queue || []).length;

                return (
                  <div
                    key={session.id}
                    onClick={() => onOpenReview(session)}
                    style={{
                      background: 'rgba(15, 23, 42, 0.75)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '12px',
                      padding: '12px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '14px'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                      e.currentTarget.style.background = 'rgba(30, 41, 59, 0.85)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                      e.currentTarget.style.background = 'rgba(15, 23, 42, 0.75)';
                    }}
                  >
                    {/* Video Thumbnail with Play Button */}
                    <div style={{
                      width: '92px',
                      height: '58px',
                      borderRadius: '8px',
                      background: '#0b0f19',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      position: 'relative',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      <img
                        src="https://img.youtube.com/vi/DL14YK4us90/mqdefault.jpg"
                        alt="Thumbnail"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.7 }}
                        onError={(e) => {
                          (e.target as any).style.display = 'none';
                        }}
                      />
                      <div style={{
                        position: 'absolute',
                        width: '26px',
                        height: '26px',
                        borderRadius: '50%',
                        background: 'rgba(0, 0, 0, 0.75)',
                        border: '1px solid rgba(255, 255, 255, 0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        fontSize: '10px'
                      }}>
                        ▶
                      </div>
                    </div>

                    {/* Metadata */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <span style={{
                          fontSize: '13px',
                          fontWeight: 700,
                          color: '#f8fafc',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {session.source.name}
                        </span>

                        <span style={{
                          background: 'rgba(16, 185, 129, 0.15)',
                          border: '1px solid rgba(16, 185, 129, 0.35)',
                          color: '#10b981',
                          borderRadius: '12px',
                          padding: '2px 8px',
                          fontSize: '10px',
                          fontWeight: 600,
                          flexShrink: 0
                        }}>
                          {queueCount} Queue Item{queueCount !== 1 ? 's' : ''}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px', fontSize: '11px', color: '#94a3b8' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          📅 {new Date(session.startedAt).toLocaleDateString()}
                        </span>
                        <span>•</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          🕒 {Math.round(watchedSec / 60)} min watched, {Math.round(totalRewatchSec / 60) || 1} min to rewatch
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        {/* 4. Bottom Footer Bar */}
        <footer style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '20px',
          padding: '10px 18px',
          background: 'rgba(15, 23, 42, 0.6)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: '12px',
          fontSize: '12px',
          color: '#94a3b8'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: '#818cf8' }}>✨</span>
            <span style={{ fontWeight: 600, color: '#f8fafc' }}>Study Smarter. Not Harder.</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Simulated Mode Quick Toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '11px', color: simulatedMode ? '#38bdf8' : '#64748b' }}>
              <input
                type="checkbox"
                checked={simulatedMode}
                onChange={(e) => onToggleSimulatedMode(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>Simulated Mode (No Camera)</span>
            </label>

            <span style={{ color: 'rgba(255, 255, 255, 0.15)' }}>|</span>

            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#64748b' }}>
              <span>📊</span> Replay • Learn • Grow
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
};
