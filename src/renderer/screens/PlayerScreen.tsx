import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  AbsenceState,
  CalibrationResult,
  ChapterInfo,
  DetectionEvent,
  PulsePoint,
  QualityBucket,
  SessionDocument,
  VideoSource
} from '@shared/types';
import { AbsenceStateMachine } from '../engine/AbsenceStateMachine';
import { EvidenceEvaluator } from '../engine/EvidenceEvaluator';
import { QualityRibbon } from '../engine/QualityRibbon';
import { QueueBuilder } from '../engine/QueueBuilder';
import { SignalProvider } from '../providers/SignalProvider';

interface PlayerScreenProps {
  source: VideoSource;
  calibration: CalibrationResult;
  provider: SignalProvider;
  onFinishSession: (sessionDoc: SessionDocument) => void;
  onExit: () => void;
}

export const PlayerScreen: React.FC<PlayerScreenProps> = ({
  source,
  calibration,
  provider,
  onFinishSession,
  onExit
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(source.duration || 3600);
  const [playbackRate, setPlaybackRate] = useState(1.0);

  // Absence engine & state machine
  const [absenceState, setAbsenceState] = useState<AbsenceState>('Watching');
  const [guardEnabled, setGuardEnabled] = useState(true);
  const [notesMode, setNotesMode] = useState(false);
  const [currentEar, setCurrentEar] = useState<number | null>(null);

  // Session records
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [pulsePoints, setPulsePoints] = useState<PulsePoint[]>([]);
  const qualityRibbonRef = useRef<QualityRibbon>(new QualityRibbon(calibration.qualityThreshold));
  const evaluatorRef = useRef<EvidenceEvaluator>(new EvidenceEvaluator(calibration));
  const stateMachineRef = useRef<AbsenceStateMachine | null>(null);

  // Break mode timer
  const [isBreakActive, setIsBreakActive] = useState(false);
  const [breakSecondsLeft, setBreakSecondsLeft] = useState(120);

  // Chapters
  const [chapters, setChapters] = useState<ChapterInfo[]>(source.chapters || []);
  const [currentChapterTitle, setCurrentChapterTitle] = useState<string>('');

  // Live Camera PIP Preview state
  const [isCameraPipOpen, setIsCameraPipOpen] = useState(true);
  const [isPipMinimized, setIsPipMinimized] = useState(false);
  const [hasWebcamStream, setHasWebcamStream] = useState(false);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);

  const startTimeRef = useRef<string>(new Date().toISOString());

  // Helper to pause video
  const pausePlayback = useCallback(() => {
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  }, []);

  // Helper to resume from 30s earlier
  const resumePlayback30sEarlier = useCallback(() => {
    if (videoRef.current) {
      const targetTime = Math.max(0, videoRef.current.currentTime - 30);
      videoRef.current.currentTime = targetTime;
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
    stateMachineRef.current?.confirmResume();
    setIsBreakActive(false);
  }, []);

  // Manual bookmark
  const triggerBookmark = useCallback(() => {
    if (!videoRef.current) return;
    const ts = videoRef.current.currentTime;
    const newBookmark: DetectionEvent = {
      id: `bookmark-${ts.toFixed(1)}`,
      type: 'bookmark',
      start: ts,
      end: ts,
      evidence: ['F'],
      confidence: 1.0,
      note: 'Manual bookmark (B key)'
    };
    setEvents((prev) => [...prev, newBookmark]);
  }, []);

  // Start 2-minute break
  const startBreak = useCallback(() => {
    setIsBreakActive(true);
    setBreakSecondsLeft(120);
    pausePlayback();
  }, [pausePlayback]);

  // Finish session
  const finishSession = useCallback(() => {
    pausePlayback();
    provider.stop();

    const qualityBuckets = qualityRibbonRef.current.getBuckets();
    const queue = QueueBuilder.buildRewindQueue(
      events,
      qualityBuckets,
      chapters,
      duration
    );

    const doc: SessionDocument = {
      version: 1,
      id: `session-${Date.now()}`,
      source: {
        ...source,
        duration,
        chapters
      },
      startedAt: startTimeRef.current,
      endedAt: new Date().toISOString(),
      calibration,
      events,
      quality: qualityBuckets,
      queue,
      pulse: pulsePoints
    };

    // Save to storage via IPC if available
    try {
      if ((window as any).rewindApi?.sessions) {
        (window as any).rewindApi.sessions.save(doc);
      }
    } catch {
      // Ignored in stand-alone
    }

    onFinishSession(doc);
  }, [pausePlayback, provider, events, chapters, duration, source, calibration, pulsePoints, onFinishSession]);

  // Setup state machine & signal subscribers
  useEffect(() => {
    const sm = new AbsenceStateMachine({
      onStateChange: (newState) => {
        setAbsenceState(newState);
      },
      onPauseRequested: (pauseEv) => {
        pausePlayback();
        setEvents((prev) => [...prev, pauseEv]);
      },
      onMarkerEmitted: (markerEv) => {
        setEvents((prev) => [...prev, markerEv]);
      },
      onBookmarkEmitted: (bmEv) => {
        setEvents((prev) => [...prev, bmEv]);
      }
    });

    stateMachineRef.current = sm;

    // Load chapters if available
    if (source.pathOrUrl && (window as any).rewindApi?.chapters) {
      (window as any).rewindApi.chapters.parse(source.pathOrUrl).then((parsed: ChapterInfo[]) => {
        if (parsed && parsed.length > 0) {
          setChapters(parsed);
        }
      });
    }

    // Subscribe to frames from provider
    provider.onFrame((frame) => {
      // Synchronize frame with video playback time
      const videoTs = videoRef.current ? videoRef.current.currentTime : frame.timestamp;
      const syncedFrame = { ...frame, timestamp: videoTs };

      // Record quality bucket
      qualityRibbonRef.current.addFrame(syncedFrame);

      // Record pulse context if available
      if (frame.pulseRate) {
        setPulsePoints((prev) => [
          ...prev,
          { timestamp: videoTs, value: frame.pulseRate!, confidence: frame.confidence }
        ]);
      }

      // Evaluate detection rules
      const evidence = evaluatorRef.current.evaluateFrame(syncedFrame);
      setCurrentEar(evidence.ear);

      // Draw facial landmark wireframe on the PIP canvas
      if (pipCanvasRef.current && frame.landmarks && frame.landmarks.length >= 468) {
        const canvas = pipCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const W = canvas.width;
          const H = canvas.height;
          const lm = frame.landmarks;
          const isClosed = evidence.ear !== null && evidence.ear < calibration.closureThreshold;

          ctx.strokeStyle = isClosed ? '#f43f5e' : '#38bdf8';
          ctx.lineWidth = 1.5;

          const drawRing = (indices: number[]) => {
            ctx.beginPath();
            indices.forEach((idx, i) => {
              const pt = lm[idx];
              if (!pt) return;
              const x = pt.x * W;
              const y = pt.y * H;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.stroke();
          };

          // Left eye and Right eye rings
          drawRing([33, 160, 158, 133, 153, 144]);
          drawRing([362, 385, 387, 263, 373, 380]);

          // Vertical pitch vector (168 -> 152)
          if (lm[168] && lm[152]) {
            ctx.strokeStyle = '#6366f1';
            ctx.beginPath();
            ctx.moveTo(lm[168].x * W, lm[168].y * H);
            ctx.lineTo(lm[152].x * W, lm[152].y * H);
            ctx.stroke();
          }

          // Horizontal yaw vector (33 -> 263)
          if (lm[33] && lm[263]) {
            ctx.strokeStyle = '#38bdf8';
            ctx.beginPath();
            ctx.moveTo(lm[33].x * W, lm[33].y * H);
            ctx.lineTo(lm[263].x * W, lm[263].y * H);
            ctx.stroke();
          }
        }
      }

      // Run state machine
      sm.processFrame(evidence, syncedFrame);
    });

    return () => {
      provider.stop();
    };
  }, [provider, pausePlayback, source.pathOrUrl, calibration.closureThreshold]);

  // Acquire local webcam stream for picture-in-picture box
  useEffect(() => {
    let active = true;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ video: { width: 320, height: 240 } })
        .then((stream) => {
          if (!active) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          webcamStreamRef.current = stream;
          setHasWebcamStream(true);
          if (pipVideoRef.current) {
            pipVideoRef.current.srcObject = stream;
            pipVideoRef.current.play().catch(() => {});
          }
        })
        .catch(() => {
          setHasWebcamStream(false);
        });
    }

    return () => {
      active = false;
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach((t) => t.stop());
        webcamStreamRef.current = null;
      }
    };
  }, []);

  // Update guard and notes mode in engine
  useEffect(() => {
    stateMachineRef.current?.setGuardEnabled(guardEnabled);
  }, [guardEnabled]);

  useEffect(() => {
    evaluatorRef.current.setNotesMode(notesMode);
  }, [notesMode]);

  // Break timer countdown
  useEffect(() => {
    if (!isBreakActive) return;
    const timer = setInterval(() => {
      setBreakSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setIsBreakActive(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isBreakActive]);

  // Track active chapter
  useEffect(() => {
    const current = chapters.find((ch) => currentTime >= ch.start && currentTime <= ch.end);
    setCurrentChapterTitle(current ? current.title : '');
  }, [currentTime, chapters]);

  // Keyboard accessibility (Section 15, PRD Section 6.3)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      if (e.code === 'Space') {
        e.preventDefault();
        if (absenceState === 'Waiting' || absenceState === 'Returned') {
          resumePlayback30sEarlier();
        } else if (videoRef.current) {
          if (videoRef.current.paused) {
            videoRef.current.play().catch(() => {});
            setIsPlaying(true);
          } else {
            videoRef.current.pause();
            setIsPlaying(false);
          }
        }
      } else if (key === 't') {
        e.preventDefault();
        startBreak();
      } else if (key === 'b') {
        e.preventDefault();
        triggerBookmark();
      } else if (key === 'g') {
        e.preventDefault();
        setGuardEnabled((prev) => !prev);
      } else if (key === 'n') {
        e.preventDefault();
        setNotesMode((prev) => !prev);
      } else if (key === 'escape') {
        if (isBreakActive) {
          setIsBreakActive(false);
        } else {
          onExit();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [absenceState, isBreakActive, resumePlayback30sEarlier, startBreak, triggerBookmark, onExit]);

  const formatTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${mins}:${s < 10 ? '0' : ''}${s}`;
  };

  const getStatusColor = () => {
    switch (absenceState) {
      case 'Watching':
        return '#10b981'; // Green
      case 'Suspect':
        return '#f59e0b'; // Amber
      case 'Absent':
      case 'Waiting':
      case 'Returned':
        return '#f43f5e'; // Rose
      case 'Degraded':
        return '#64748b'; // Gray
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#070a12', position: 'relative' }}>
      {/* Top Header Strip */}
      <div style={{
        height: '48px',
        background: '#0b0f19',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={onExit}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: '13px'
            }}
          >
            ← Exit
          </button>
          <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
            {source.name}
          </span>
          {currentChapterTitle && (
            <span style={{ fontSize: '12px', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '2px 8px', borderRadius: '4px' }}>
              {currentChapterTitle}
            </span>
          )}
        </div>

        {/* Status Indicators & Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Signal Status Dot */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#cbd5e1' }}>
            <div style={{
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              backgroundColor: getStatusColor(),
              boxShadow: absenceState === 'Absent' ? '0 0 10px #f43f5e' : 'none'
            }} />
            <span>State: {absenceState}</span>
            {currentEar !== null && (
              <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>
                EAR: {currentEar.toFixed(2)}
              </span>
            )}
          </div>

          {/* Notes Mode Toggle (N key) */}
          <button
            onClick={() => setNotesMode(!notesMode)}
            style={{
              background: notesMode ? 'rgba(56, 189, 248, 0.2)' : '#1e293b',
              border: `1px solid ${notesMode ? '#38bdf8' : '#2e3c54'}`,
              color: notesMode ? '#38bdf8' : '#94a3b8',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Notes Mode [N]: {notesMode ? 'ON' : 'OFF'}
          </button>

          {/* Absence Guard Toggle (G key) */}
          <button
            onClick={() => setGuardEnabled(!guardEnabled)}
            style={{
              background: guardEnabled ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)',
              border: `1px solid ${guardEnabled ? '#10b981' : '#f43f5e'}`,
              color: guardEnabled ? '#10b981' : '#f43f5e',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Guard [G]: {guardEnabled ? 'ACTIVE' : 'SUSPENDED'}
          </button>

          {/* Camera PIP Toggle */}
          <button
            onClick={() => setIsCameraPipOpen(!isCameraPipOpen)}
            style={{
              background: isCameraPipOpen ? 'rgba(56, 189, 248, 0.2)' : '#1e293b',
              border: `1px solid ${isCameraPipOpen ? '#38bdf8' : '#2e3c54'}`,
              color: isCameraPipOpen ? '#38bdf8' : '#94a3b8',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Camera [{isCameraPipOpen ? 'ON' : 'OFF'}]
          </button>

          {/* Finish & View Queue */}
          <button
            onClick={finishSession}
            style={{
              background: '#2563eb',
              border: 'none',
              color: '#fff',
              padding: '6px 14px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Finish & Review Queue
          </button>
        </div>
      </div>

      {/* Main Video View Area */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
        <video
          ref={videoRef}
          src={source.pathOrUrl}
          onTimeUpdate={() => videoRef.current && setCurrentTime(videoRef.current.currentTime)}
          onLoadedMetadata={() => videoRef.current && setDuration(videoRef.current.duration)}
          onEnded={finishSession}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />

        {/* 2-Minute Break Overlay (FR-11) */}
        {isBreakActive && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(11, 15, 25, 0.95)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '20px',
            zIndex: 30
          }}>
            <div style={{ fontSize: '48px' }}>☕</div>
            <h2 style={{ fontSize: '24px', fontWeight: 600, color: '#f8fafc' }}>
              2-Minute Rest Break
            </h2>
            <div style={{ fontSize: '54px', fontWeight: 700, fontFamily: 'monospace', color: '#38bdf8' }}>
              {formatTime(breakSecondsLeft)}
            </div>
            <p style={{ fontSize: '14px', color: '#94a3b8' }}>
              Relax your eyes and stretch. Press Space or click below to resume.
            </p>
            <button
              onClick={resumePlayback30sEarlier}
              style={{
                marginTop: '12px',
                padding: '12px 28px',
                background: '#2563eb',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Resume Lecture (-30s)
            </button>
          </div>
        )}

        {/* Absence Overlay (PRD Section 6.3) */}
        {(absenceState === 'Waiting' || absenceState === 'Returned') && !isBreakActive && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(11, 15, 25, 0.88)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '24px',
            zIndex: 20
          }}>
            <div style={{
              background: '#151d2f',
              border: '1px solid #2e3c54',
              borderRadius: '16px',
              padding: '36px 48px',
              maxWidth: '560px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              gap: '20px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
            }}>
              <div>
                <span style={{ fontSize: '32px' }}>
                  {absenceState === 'Returned' ? '👋' : '⏸️'}
                </span>
                <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#f8fafc', marginTop: '12px' }}>
                  {absenceState === 'Returned' ? 'Welcome Back' : 'Absence Detected — Playback Paused'}
                </h2>
                <p style={{ fontSize: '13px', color: '#94a3b8', marginTop: '6px' }}>
                  {absenceState === 'Returned'
                    ? 'Presence verified for 3 seconds. Select an option below or press Space.'
                    : 'Playback is paused while prolonged eye closure or physical absence is detected.'}
                </p>
              </div>

              {/* Two Equal Actions (PRD Section 6.3 & Section 12) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <button
                  onClick={resumePlayback30sEarlier}
                  style={{
                    padding: '16px',
                    background: '#2563eb',
                    border: 'none',
                    borderRadius: '10px',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '14px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <span>Resume (-30s)</span>
                  <span style={{ fontSize: '11px', opacity: 0.8 }}>Space or Double-Blink</span>
                </button>

                <button
                  onClick={startBreak}
                  style={{
                    padding: '16px',
                    background: '#1e293b',
                    border: '1px solid #2e3c54',
                    borderRadius: '10px',
                    color: '#f8fafc',
                    fontWeight: 600,
                    fontSize: '14px',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <span>Take 2 Minutes</span>
                  <span style={{ fontSize: '11px', color: '#94a3b8' }}>Press 'T' Key</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Live Camera Picture-in-Picture Box */}
        {isCameraPipOpen && (
          <div style={{
            position: 'absolute',
            bottom: '24px',
            right: '24px',
            width: isPipMinimized ? '190px' : '260px',
            height: isPipMinimized ? '38px' : '200px',
            background: 'rgba(15, 23, 42, 0.94)',
            backdropFilter: 'blur(8px)',
            border: `2px solid ${getStatusColor()}`,
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: `0 8px 30px rgba(0, 0, 0, 0.7), 0 0 12px ${getStatusColor()}33`,
            display: 'flex',
            flexDirection: 'column',
            zIndex: 25,
            transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            {/* Header / Strip */}
            <div style={{
              height: '36px',
              background: '#0b0f19',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 10px',
              borderBottom: isPipMinimized ? 'none' : '1px solid #1e293b'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: getStatusColor(),
                  boxShadow: `0 0 6px ${getStatusColor()}`
                }} />
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#f8fafc', letterSpacing: '0.5px' }}>
                  {hasWebcamStream ? 'LIVE CAMERA' : 'TRACKING MESH'}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <button
                  onClick={() => setIsPipMinimized(!isPipMinimized)}
                  title={isPipMinimized ? 'Expand Camera Box' : 'Minimize'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '2px 6px',
                    borderRadius: '4px'
                  }}
                >
                  {isPipMinimized ? '▢' : '—'}
                </button>
                <button
                  onClick={() => setIsCameraPipOpen(false)}
                  title="Hide Camera Box"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: '12px',
                    padding: '2px 6px',
                    borderRadius: '4px'
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Video & Canvas Area */}
            {!isPipMinimized && (
              <div style={{ flex: 1, position: 'relative', background: '#070a12', overflow: 'hidden' }}>
                {/* Live Webcam Video Feed */}
                <video
                  ref={pipVideoRef}
                  muted
                  playsInline
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    transform: 'scaleX(-1)', // mirror for natural feel
                    display: hasWebcamStream ? 'block' : 'none'
                  }}
                />

                {/* Tracking Mesh Overlay Canvas */}
                <canvas
                  ref={pipCanvasRef}
                  width={260}
                  height={136}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    transform: 'scaleX(-1)' // mirror matching video
                  }}
                />

                {/* Fallback Graphic if no webcam hardware active */}
                {!hasWebcamStream && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    color: '#64748b',
                    fontSize: '11px'
                  }}>
                    <span style={{ fontSize: '28px' }}>👁️</span>
                    <span>Geometric Tracking Wireframe</span>
                  </div>
                )}

                {/* Bottom Telemetry HUD Bar */}
                <div style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  background: 'rgba(11, 15, 25, 0.88)',
                  backdropFilter: 'blur(4px)',
                  padding: '4px 8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '10px',
                  fontFamily: 'monospace'
                }}>
                  <span style={{
                    color: currentEar !== null && currentEar < calibration.closureThreshold ? '#f43f5e' : '#38bdf8',
                    fontWeight: 700
                  }}>
                    EAR: {currentEar !== null ? currentEar.toFixed(2) : '--'}
                  </span>
                  <span style={{ color: '#94a3b8' }}>
                    THR: {calibration.closureThreshold.toFixed(2)}
                  </span>
                  <span style={{ color: getStatusColor(), fontWeight: 600 }}>
                    {absenceState.toUpperCase()}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Restore button if user closed the camera box */}
        {!isCameraPipOpen && (
          <button
            onClick={() => setIsCameraPipOpen(true)}
            style={{
              position: 'absolute',
              bottom: '24px',
              right: '24px',
              background: '#151d2f',
              border: '1px solid #2e3c54',
              color: '#38bdf8',
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '12px',
              cursor: 'pointer',
              zIndex: 15,
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <span>📹 Show Camera Feed</span>
          </button>
        )}
      </div>

      {/* Bottom Timeline & Controls Bar */}
      <div style={{
        height: '80px',
        background: '#0b0f19',
        borderTop: '1px solid #1e293b',
        padding: '0 24px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: '8px'
      }}>
        {/* Timeline Progress Bar with Marker Strips */}
        <div
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            if (videoRef.current) {
              videoRef.current.currentTime = pct * duration;
            }
          }}
          style={{
            height: '8px',
            background: '#1e293b',
            borderRadius: '4px',
            position: 'relative',
            cursor: 'pointer'
          }}
        >
          {/* Watched progress */}
          <div style={{
            width: `${(currentTime / (duration || 1)) * 100}%`,
            height: '100%',
            background: '#3b82f6',
            borderRadius: '4px'
          }} />

          {/* Marker and Pause dots along the strip */}
          {events.map((ev, i) => (
            <div
              key={i}
              title={`${ev.type} at ${formatTime(ev.start)}`}
              style={{
                position: 'absolute',
                left: `${(ev.start / (duration || 1)) * 100}%`,
                top: '-2px',
                width: '6px',
                height: '12px',
                borderRadius: '2px',
                backgroundColor: ev.type === 'pause' ? '#f43f5e' : ev.type === 'bookmark' ? '#10b981' : '#f59e0b',
                pointerEvents: 'none'
              }}
            />
          ))}
        </div>

        {/* Playback Controls & Time */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
              onClick={() => {
                if (videoRef.current) {
                  if (videoRef.current.paused) {
                    videoRef.current.play().catch(() => {});
                    setIsPlaying(true);
                  } else {
                    videoRef.current.pause();
                    setIsPlaying(false);
                  }
                }
              }}
              style={{
                background: 'transparent',
                border: '1px solid #2e3c54',
                color: '#f8fafc',
                padding: '4px 12px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              {isPlaying ? 'Pause [Space]' : 'Play [Space]'}
            </button>

            <button
              onClick={triggerBookmark}
              style={{
                background: 'transparent',
                border: '1px solid #2e3c54',
                color: '#10b981',
                padding: '4px 10px',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Bookmark [B]
            </button>

            <span style={{ fontSize: '12px', color: '#94a3b8', fontFamily: 'monospace' }}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          {/* Speed control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: '#64748b' }}>Speed:</span>
            {[0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => (
              <button
                key={rate}
                onClick={() => {
                  setPlaybackRate(rate);
                  if (videoRef.current) videoRef.current.playbackRate = rate;
                }}
                style={{
                  background: playbackRate === rate ? '#3b82f6' : 'transparent',
                  border: '1px solid #2e3c54',
                  color: playbackRate === rate ? '#fff' : '#94a3b8',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  cursor: 'pointer'
                }}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
