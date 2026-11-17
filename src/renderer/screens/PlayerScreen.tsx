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
import { SmartSpectraProvider } from '../providers/SmartSpectraProvider';
import { SimulatedTraceProvider } from '../providers/SimulatedTraceProvider';

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

  // Live Camera PIP Preview & Real-Time Blink Counter state
  const isSimulatedProvider = provider instanceof SimulatedTraceProvider;
  const [isCameraPipOpen, setIsCameraPipOpen] = useState(true);
  const [isPipMinimized, setIsPipMinimized] = useState(false);
  const [hasWebcamStream, setHasWebcamStream] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [liveClosedDuration, setLiveClosedDuration] = useState(0);
  const [livePitch, setLivePitch] = useState(0);
  const [liveYaw, setLiveYaw] = useState(0);
  const [blinkCount, setBlinkCount] = useState(0);
  const [blinkFlash, setBlinkFlash] = useState(false);
  const [effectiveThreshold, setEffectiveThreshold] = useState(calibration.closureThreshold);
  const earHistoryRef = useRef<number[]>([]);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);

  // Adaptive blink edge detector refs (immune to React closure staleness)
  const effectiveThresholdRef = useRef<number>(calibration.closureThreshold);
  const adaptiveOpenEarRef = useRef<number>(calibration.baselineEar || 0.28);
  const openEarSeedSamplesRef = useRef<number[]>([]);
  const hasAdaptedDefaultCalibRef = useRef<boolean>(false);
  const isEyeClosedForBlinkRef = useRef<boolean>(false);
  const eyeClosedStartMsRef = useRef<number>(0);
  const lastBlinkEndMsRef = useRef<number>(0);
  const blinkFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const mapEventToVideoTime = (ev: DetectionEvent): DetectionEvent => {
      const videoNow = videoRef.current?.currentTime;
      if (typeof videoNow === 'number' && Number.isFinite(videoNow)) {
        const dur = Math.max(0, ev.end - ev.start);
        return {
          ...ev,
          start: Math.max(0, videoNow - dur),
          end: videoNow
        };
      }
      return ev;
    };

    const sm = new AbsenceStateMachine({
      onStateChange: (newState) => {
        setAbsenceState(newState);
      },
      onPauseRequested: (pauseEv) => {
        pausePlayback();
        setEvents((prev) => [...prev, mapEventToVideoTime(pauseEv)]);
      },
      onMarkerEmitted: (markerEv) => {
        setEvents((prev) => [...prev, mapEventToVideoTime(markerEv)]);
      },
      onBookmarkEmitted: (bmEv) => {
        setEvents((prev) => [...prev, mapEventToVideoTime(bmEv)]);
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

    // Clear any stale listeners from calibration screen and ensure provider is running
    provider.clearFrameListeners?.();
    if (provider instanceof SmartSpectraProvider) {
      provider.setBlinkThreshold(calibration.closureThreshold);
    }
    provider.start().catch(() => {});

    // Subscribe to frames from provider
    provider.onFrame((frame) => {
      // Use monotonic provider timestamp for detection timers so eye-closure & blink tracking
      // work continuously even when the lecture video is paused or unstarted.
      const videoTs = videoRef.current && videoRef.current.currentTime > 0
        ? videoRef.current.currentTime
        : frame.timestamp;

      // Record quality bucket against video timeline
      qualityRibbonRef.current.addFrame({ ...frame, timestamp: videoTs });

      // Record pulse context if available
      if (frame.pulseRate) {
        setPulsePoints((prev) => [
          ...prev,
          { timestamp: videoTs, value: frame.pulseRate!, confidence: frame.confidence }
        ]);
      }

      // Evaluate detection rules using monotonic frame.timestamp
      const evidence = evaluatorRef.current.evaluateFrame(frame);
      const hasFace = Boolean(frame.landmarks && frame.landmarks.length >= 468);
      setFaceDetected(hasFace);
      setCurrentEar(evidence.ear);
      setLiveClosedDuration(evidence.closedDurationSec);
      if (evidence.relativePose) {
        setLivePitch(evidence.relativePose.pitch);
        setLiveYaw(evidence.relativePose.yaw);
      }

      // Real-time adaptive blink detector & threshold tracking
      let activeCloseThr = calibration.closureThreshold;
      if (evidence.ear !== null) {
        const ear = evidence.ear;

        // Seed adaptive open-eye baseline from initial frames so skipped calibrations still lock on
        if (openEarSeedSamplesRef.current.length < 15 && ear > 0.18) {
          openEarSeedSamplesRef.current.push(ear);
          const sorted = [...openEarSeedSamplesRef.current].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length * 0.7)];
          adaptiveOpenEarRef.current = median;

          // If user skipped straight through with default calibration (0.28 / 0.18),
          // align evaluator's closure threshold to the real webcam geometry once seeded
          if (
            openEarSeedSamplesRef.current.length === 15 &&
            !hasAdaptedDefaultCalibRef.current &&
            calibration.baselineEar === 0.28 &&
            calibration.closureThreshold === 0.18 &&
            Math.abs(median - 0.28) > 0.03
          ) {
            hasAdaptedDefaultCalibRef.current = true;
            const adaptedThr = Number((median * 0.70).toFixed(4));
            effectiveThresholdRef.current = adaptedThr;
            evaluatorRef.current.updateCalibration({
              ...calibration,
              baselineEar: Number(median.toFixed(4)),
              closureThreshold: adaptedThr
            });
            setEffectiveThreshold(adaptedThr);
          }
        } else if (ear > adaptiveOpenEarRef.current * 0.85) {
          // Gentle EMA tracking of natural open-eye aperture
          adaptiveOpenEarRef.current = adaptiveOpenEarRef.current * 0.97 + ear * 0.03;
        }

        // Hysteresis thresholds catch fast 1-frame webcam blinks cleanly without noise chatter
        activeCloseThr = Math.max(effectiveThresholdRef.current, adaptiveOpenEarRef.current * 0.75);
        const activeOpenThr = Math.max(activeCloseThr + 0.012, adaptiveOpenEarRef.current * 0.81);

        if (provider instanceof SmartSpectraProvider) {
          provider.setBlinkThreshold(activeCloseThr);
        }

        const nowMs = performance.now();
        if (ear < activeCloseThr) {
          if (!isEyeClosedForBlinkRef.current) {
            isEyeClosedForBlinkRef.current = true;
            eyeClosedStartMsRef.current = nowMs;
          }
        } else if (ear >= activeOpenThr && isEyeClosedForBlinkRef.current) {
          isEyeClosedForBlinkRef.current = false;
          const closedMs = nowMs - eyeClosedStartMsRef.current;
          const sinceLastBlinkMs = nowMs - lastBlinkEndMsRef.current;

          // Count distinct blinks (30ms - 2000ms closure, 160ms refractory debounce)
          if (closedMs >= 30 && closedMs <= 2000 && sinceLastBlinkMs >= 160) {
            lastBlinkEndMsRef.current = nowMs;
            setBlinkCount((c) => c + 1);
            setBlinkFlash(true);
            if (blinkFlashTimerRef.current) {
              clearTimeout(blinkFlashTimerRef.current);
            }
            blinkFlashTimerRef.current = setTimeout(() => {
              setBlinkFlash(false);
            }, 350);
          }
        }

        // Track rolling EAR history for live waveform graph
        earHistoryRef.current.push(ear);
        if (earHistoryRef.current.length > 50) {
          earHistoryRef.current.shift();
        }
      }

      // Draw real-time computer vision detection mesh on PIP canvas
      if (pipCanvasRef.current) {
        const canvas = pipCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const W = canvas.width;
          const H = canvas.height;
          ctx.clearRect(0, 0, W, H);

          const isClosed = evidence.ear !== null && evidence.ear < activeCloseThr;

          if (hasFace && frame.landmarks) {
            const lm = frame.landmarks;

            // Mirror ONLY the facial landmark overlay so it aligns with mirrored <video>
            ctx.save();
            ctx.translate(W, 0);
            ctx.scale(-1, 1);

            // 1. Face targeting corner brackets
            const bx = W * 0.18;
            const by = H * 0.10;
            const bw = W * 0.64;
            const bh = H * 0.60;
            ctx.strokeStyle = isClosed ? '#f43f5e' : '#38bdf8';
            ctx.lineWidth = 1.2;
            const cLen = 14;
            ctx.beginPath();
            ctx.moveTo(bx, by + cLen); ctx.lineTo(bx, by); ctx.lineTo(bx + cLen, by);
            ctx.moveTo(bx + bw - cLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cLen);
            ctx.moveTo(bx, by + bh - cLen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cLen, by + bh);
            ctx.moveTo(bx + bw - cLen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cLen);
            ctx.stroke();

            // 2. Eye polygon contour loops
            ctx.strokeStyle = isClosed ? '#f43f5e' : '#38bdf8';
            ctx.lineWidth = isClosed ? 2.2 : 1.6;

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

            drawRing([33, 160, 158, 133, 153, 144]);
            drawRing([362, 385, 387, 263, 373, 380]);

            // Iris center tracking dots
            const leftCenter = lm[160];
            if (leftCenter) {
              ctx.fillStyle = isClosed ? '#f43f5e' : '#10b981';
              ctx.beginPath();
              ctx.arc(leftCenter.x * W, leftCenter.y * H, isClosed ? 1.8 : 2.6, 0, Math.PI * 2);
              ctx.fill();
            }
            const rightCenter = lm[385];
            if (rightCenter) {
              ctx.fillStyle = isClosed ? '#f43f5e' : '#10b981';
              ctx.beginPath();
              ctx.arc(rightCenter.x * W, rightCenter.y * H, isClosed ? 1.8 : 2.6, 0, Math.PI * 2);
              ctx.fill();
            }

            // 3. Head pose vertical pitch vector (168 -> 152)
            if (lm[168] && lm[152]) {
              ctx.strokeStyle = '#6366f1';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(lm[168].x * W, lm[168].y * H);
              ctx.lineTo(lm[152].x * W, lm[152].y * H);
              ctx.stroke();
            }

            // 4. Head pose horizontal yaw vector (33 -> 263)
            if (lm[33] && lm[263]) {
              ctx.strokeStyle = '#38bdf8';
              ctx.lineWidth = 1.0;
              ctx.beginPath();
              ctx.moveTo(lm[33].x * W, lm[33].y * H);
              ctx.lineTo(lm[263].x * W, lm[263].y * H);
              ctx.stroke();
            }

            ctx.restore();
          } else {
            // Clear warning badge when face is not visible
            ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
            ctx.font = 'bold 11px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText('NO FACE DETECTED', W / 2, H * 0.42);
          }

          // 5. Real-Time Scrolling EAR Waveform Graph (un-flipped left-to-right, bottom 34px)
          const graphH = 34;
          const graphY = H - graphH;
          ctx.fillStyle = 'rgba(7, 10, 18, 0.88)';
          ctx.fillRect(0, graphY, W, graphH);
          ctx.strokeStyle = '#1e293b';
          ctx.lineWidth = 1;
          ctx.strokeRect(0, graphY, W, graphH);

          // Dynamic scale adapts cleanly to user's actual open EAR range
          const minEar = 0.05;
          const maxEar = Math.max(0.40, adaptiveOpenEarRef.current + 0.08);
          const normY = (v: number) =>
            graphY + graphH - Math.max(3, Math.min(graphH - 4, ((v - minEar) / (maxEar - minEar)) * (graphH - 6)));
          const thrY = normY(activeCloseThr);

          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, thrY);
          ctx.lineTo(W, thrY);
          ctx.stroke();
          ctx.restore();

          // Left-to-right EAR wave path
          const history = earHistoryRef.current;
          if (history.length > 1) {
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            history.forEach((val, i) => {
              const x = (i / 49) * W;
              const y = normY(val);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.strokeStyle = isClosed ? '#f43f5e' : '#38bdf8';
            ctx.stroke();

            // Leading wave pulse dot
            const lastVal = history[history.length - 1];
            const lastX = ((history.length - 1) / 49) * W;
            const lastY = normY(lastVal);
            ctx.fillStyle = isClosed ? '#f43f5e' : '#10b981';
            ctx.beginPath();
            ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // Subtle graph label
          ctx.fillStyle = '#64748b';
          ctx.font = '9px ui-monospace, monospace';
          ctx.textAlign = 'left';
          ctx.fillText('EAR LIVE', 5, graphY + 10);
        }
      }

      // Run state machine with monotonic frame.timestamp
      sm.processFrame(evidence, frame);
    });

    return () => {
      if (blinkFlashTimerRef.current) {
        clearTimeout(blinkFlashTimerRef.current);
      }
      provider.clearFrameListeners?.();
      if (provider instanceof SmartSpectraProvider) {
        provider.setOnStreamAvailable(undefined);
      }
      provider.stop();
    };
  }, [provider, pausePlayback, source.pathOrUrl, calibration]);

  // Attach webcam stream to PIP video (reuses SmartSpectraProvider stream to avoid duplicate getUserMedia)
  useEffect(() => {
    let active = true;
    let ownsStandaloneStream = false;

    const attachStream = (stream: MediaStream) => {
      if (!active) return;
      webcamStreamRef.current = stream;
      setHasWebcamStream(true);
      if (pipVideoRef.current) {
        pipVideoRef.current.srcObject = stream;
        pipVideoRef.current.play().catch(() => {});
      }
    };

    if (provider instanceof SmartSpectraProvider) {
      const existing = provider.getMediaStream();
      if (existing) {
        attachStream(existing);
      }
      provider.setOnStreamAvailable(attachStream);
    } else if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      // Optional visual webcam preview in Simulated Mode
      navigator.mediaDevices
        .getUserMedia({ video: { width: 320, height: 240 } })
        .then((stream) => {
          if (!active) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          ownsStandaloneStream = true;
          attachStream(stream);
        })
        .catch(() => {
          setHasWebcamStream(false);
        });
    }

    return () => {
      active = false;
      if (ownsStandaloneStream && webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach((t) => t.stop());
        webcamStreamRef.current = null;
      }
    };
  }, [provider]);

  // Re-attach webcam stream when PIP box is expanded or reopened
  useEffect(() => {
    if (isCameraPipOpen && !isPipMinimized && pipVideoRef.current && webcamStreamRef.current) {
      if (pipVideoRef.current.srcObject !== webcamStreamRef.current) {
        pipVideoRef.current.srcObject = webcamStreamRef.current;
      }
      pipVideoRef.current.play().catch(() => {});
    }
  }, [isCameraPipOpen, isPipMinimized, hasWebcamStream]);

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
      } else if (key === '1') {
        (provider as any).triggerBlink?.();
      } else if (key === '2') {
        (provider as any).triggerBriefLapse?.(3.5);
      } else if (key === '3') {
        (provider as any).triggerProlongedAbsence?.(6.5);
      } else if (key === '4') {
        (provider as any).triggerHeadDrop?.(5.0);
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
            <span style={{
              fontSize: '11px',
              fontFamily: 'monospace',
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: '10px',
              background: blinkFlash ? 'rgba(16, 185, 129, 0.35)' : 'rgba(56, 189, 248, 0.14)',
              border: `1px solid ${blinkFlash ? '#10b981' : '#38bdf8'}`,
              color: blinkFlash ? '#6ee7b7' : '#38bdf8',
              transition: 'all 0.15s ease'
            }}>
              Blinks: {blinkCount}
            </span>
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

        {/* Live Camera Picture-in-Picture Box with Real-Time Detection HUD */}
        {isCameraPipOpen && (
          <div style={{
            position: 'absolute',
            bottom: '24px',
            right: '24px',
            width: isPipMinimized ? '200px' : '310px',
            height: isPipMinimized ? '38px' : '285px',
            background: 'rgba(15, 23, 42, 0.95)',
            backdropFilter: 'blur(8px)',
            border: `2px solid ${getStatusColor()}`,
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: `0 8px 30px rgba(0, 0, 0, 0.7), 0 0 16px ${getStatusColor()}44`,
            display: 'flex',
            flexDirection: 'column',
            zIndex: 25,
            transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)'
          }}>
            {/* Header / Strip */}
            <div style={{
              height: '34px',
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
                  boxShadow: `0 0 8px ${getStatusColor()}`
                }} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#f8fafc', letterSpacing: '0.5px' }}>
                  {isSimulatedProvider ? 'SIMULATED TRACE HUD' : hasWebcamStream ? 'LIVE WEBCAM (478-PT)' : 'REAL-TIME TRACKING HUD'}
                </span>
                {blinkFlash && (
                  <span style={{
                    fontSize: '9px',
                    fontWeight: 800,
                    background: '#10b981',
                    color: '#06281c',
                    padding: '1px 5px',
                    borderRadius: '4px',
                    fontFamily: 'monospace'
                  }}>
                    BLINK!
                  </span>
                )}
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

            {/* Video, Canvas & Real-Time Detection HUD */}
            {!isPipMinimized && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#070a12', overflow: 'hidden' }}>
                {/* Real-time Status Alert Banner */}
                <div style={{
                  background: liveClosedDuration > 0
                    ? (liveClosedDuration >= (calibration.userSensitivity || 6.0) ? 'rgba(239, 68, 68, 0.35)' : 'rgba(245, 158, 11, 0.25)')
                    : 'rgba(30, 41, 59, 0.6)',
                  borderBottom: '1px solid #1e293b',
                  padding: '4px 8px',
                  fontSize: '10px',
                  fontFamily: 'monospace',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  color: liveClosedDuration > 0 ? '#fca5a5' : '#38bdf8'
                }}>
                  {liveClosedDuration > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%' }}>
                      <span style={{ fontWeight: 700, color: '#f43f5e' }}>
                        CLOSURE: {liveClosedDuration.toFixed(1)}s / {(calibration.userSensitivity || 6.0).toFixed(1)}s
                      </span>
                      <div style={{ flex: 1, height: '4px', background: '#334155', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{
                          width: `${Math.min(100, (liveClosedDuration / (calibration.userSensitivity || 6.0)) * 100)}%`,
                          height: '100%',
                          background: '#f43f5e'
                        }} />
                      </div>
                    </div>
                  ) : (
                    <span>
                      {faceDetected ? 'FACE LOCKED' : 'SEARCHING...'} | PITCH: {livePitch >= 0 ? '+' : ''}{livePitch.toFixed(0)}° | YAW: {liveYaw >= 0 ? '+' : ''}{liveYaw.toFixed(0)}°
                    </span>
                  )}
                </div>

                {/* Video & Tracking Canvas Area */}
                <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: '140px' }}>
                  {/* Live Webcam Video Feed */}
                  <video
                    ref={pipVideoRef}
                    muted
                    playsInline
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      transform: 'scaleX(-1)',
                      display: hasWebcamStream ? 'block' : 'none'
                    }}
                  />

                  {/* Tracking Mesh (mirrored in 2D ctx) & Un-flipped Left-to-Right EAR Waveform Canvas */}
                  <canvas
                    ref={pipCanvasRef}
                    width={310}
                    height={150}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      pointerEvents: 'none'
                    }}
                  />

                  {/* Fallback Graphic if webcam not connected */}
                  {!hasWebcamStream && (
                    <div style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                      color: '#64748b',
                      fontSize: '11px',
                      pointerEvents: 'none'
                    }}>
                      <span style={{ fontSize: '24px' }}>👁️</span>
                      <span>Computer Vision Mesh</span>
                    </div>
                  )}
                </div>

                {/* Telemetry Numbers Bar */}
                <div style={{
                  background: 'rgba(11, 15, 25, 0.95)',
                  borderTop: '1px solid #1e293b',
                  padding: '4px 8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '10px',
                  fontFamily: 'monospace'
                }}>
                  <span style={{
                    color: blinkFlash ? '#10b981' : '#f8fafc',
                    fontWeight: 800,
                    background: blinkFlash ? 'rgba(16, 185, 129, 0.25)' : 'rgba(56, 189, 248, 0.15)',
                    padding: '1px 6px',
                    borderRadius: '4px'
                  }}>
                    BLINKS: {blinkCount}
                  </span>
                  <span style={{
                    color: currentEar !== null && currentEar < effectiveThreshold ? '#f43f5e' : '#38bdf8',
                    fontWeight: 700
                  }}>
                    EAR: {currentEar !== null ? currentEar.toFixed(2) : '--'}
                  </span>
                  <span style={{ color: '#94a3b8' }}>
                    THR: {effectiveThreshold.toFixed(2)}
                  </span>
                  <span style={{ color: getStatusColor(), fontWeight: 700 }}>
                    {absenceState.toUpperCase()}
                  </span>
                </div>

                {/* Bottom Controls: Simulation Triggers (Simulated Mode) or Live Reset Bar (Live Mode) */}
                {isSimulatedProvider ? (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: '4px',
                    padding: '4px 6px',
                    background: '#0b0f19',
                    borderTop: '1px solid #1e293b'
                  }}>
                    <button
                      onClick={() => (provider as any).triggerBlink?.()}
                      title="Simulate quick eye blink (Key 1)"
                      style={{
                        background: '#1e293b',
                        border: '1px solid #334155',
                        color: '#cbd5e1',
                        padding: '3px 2px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        fontWeight: 500
                      }}
                    >
                      Blink [1]
                    </button>
                    <button
                      onClick={() => (provider as any).triggerBriefLapse?.(3.5)}
                      title="Simulate 3.5s brief eye closure (Key 2 -> Marker)"
                      style={{
                        background: '#1e293b',
                        border: '1px solid #f59e0b',
                        color: '#f59e0b',
                        padding: '3px 2px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        fontWeight: 500
                      }}
                    >
                      3s Lapse [2]
                    </button>
                    <button
                      onClick={() => (provider as any).triggerProlongedAbsence?.(6.5)}
                      title="Simulate 6.5s prolonged closure (Key 3 -> Pause + Overlay)"
                      style={{
                        background: '#1e293b',
                        border: '1px solid #f43f5e',
                        color: '#f43f5e',
                        padding: '3px 2px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        fontWeight: 600
                      }}
                    >
                      6s Pause [3]
                    </button>
                    <button
                      onClick={() => (provider as any).triggerHeadDrop?.(5.0)}
                      title="Simulate head drop pitch below -20° (Key 4)"
                      style={{
                        background: '#1e293b',
                        border: '1px solid #6366f1',
                        color: '#818cf8',
                        padding: '3px 2px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer',
                        fontWeight: 500
                      }}
                    >
                      Head Drop [4]
                    </button>
                  </div>
                ) : (
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '4px 8px',
                    background: '#0b0f19',
                    borderTop: '1px solid #1e293b',
                    fontSize: '10px',
                    color: '#94a3b8'
                  }}>
                    <span>On-device 478-pt eye mesh active</span>
                    <button
                      onClick={() => setBlinkCount(0)}
                      style={{
                        background: '#1e293b',
                        border: '1px solid #334155',
                        color: '#cbd5e1',
                        padding: '2px 7px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        cursor: 'pointer'
                      }}
                    >
                      Reset Blinks
                    </button>
                  </div>
                )}
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
