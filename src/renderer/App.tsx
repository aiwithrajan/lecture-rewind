import React, { useState } from 'react';
import { CalibrationResult, SessionDocument, VideoSource } from '@shared/types';
import { HomeScreen } from './screens/HomeScreen';
import { ConsentAndSelfTestScreen } from './screens/ConsentAndSelfTestScreen';
import { PlayerScreen } from './screens/PlayerScreen';
import { ReviewAndPrivacyScreen } from './screens/ReviewAndPrivacyScreen';
import { SignalProvider } from './providers/SignalProvider';
import { SimulatedTraceProvider } from './providers/SimulatedTraceProvider';
import { SelfTestCalibrator } from './engine/SelfTestCalibrator';

type ActiveScreen = 'home' | 'consent-selftest' | 'player' | 'review';

export const App: React.FC = () => {
  const [screen, setScreen] = useState<ActiveScreen>('home');
  const [simulatedMode, setSimulatedMode] = useState<boolean>(false); // Live webcam detection active by default; FR-17 toggleable on HomeScreen

  // Active session context
  const [activeSource, setActiveSource] = useState<VideoSource | null>(null);
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [provider, setProvider] = useState<SignalProvider | null>(null);
  const [reviewedSession, setReviewedSession] = useState<SessionDocument | null>(null);
  const [reviewTab, setReviewTab] = useState<'review' | 'privacy'>('review');

  // Home -> Start Session
  const handleStartSession = (source: VideoSource, isSimulated: boolean) => {
    setActiveSource(source);
    setSimulatedMode(isSimulated);
    setScreen('consent-selftest');
  };

  // Home -> Directly open review from past sessions
  const handleOpenReview = (session: SessionDocument) => {
    setReviewedSession(session);
    setReviewTab('review');
    setScreen('review');
  };

  // Home -> Open Privacy & Firewall panel
  const handleOpenPrivacy = () => {
    // Create an empty dummy session doc for privacy viewer if none exists
    const dummySession: SessionDocument = {
      version: 1,
      id: 'settings-privacy',
      source: { type: 'local', pathOrUrl: '', duration: 0, name: 'Privacy Settings' },
      startedAt: new Date().toISOString(),
      calibration: SelfTestCalibrator.getDefaultCalibration(),
      events: [],
      quality: [],
      queue: [],
      pulse: []
    };
    setReviewedSession(dummySession);
    setReviewTab('privacy');
    setScreen('review');
  };

  // Consent & SelfTest -> Start Playback
  const handleCalibrationComplete = (calib: CalibrationResult, signalProvider: SignalProvider) => {
    setCalibration(calib);
    setProvider(signalProvider);
    setScreen('player');
  };

  // Player -> Session Finished -> Review
  const handleFinishSession = (sessionDoc: SessionDocument) => {
    setReviewedSession(sessionDoc);
    setReviewTab('review');
    setScreen('review');
  };

  // Cancel / Back to Home
  const handleBackToHome = () => {
    if (provider) {
      provider.stop().catch(() => {});
    }
    setScreen('home');
  };

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#0b0f19' }}>
      {screen === 'home' && (
        <HomeScreen
          onStartSession={handleStartSession}
          onOpenReview={handleOpenReview}
          onOpenPrivacy={handleOpenPrivacy}
          simulatedMode={simulatedMode}
          onToggleSimulatedMode={setSimulatedMode}
        />
      )}

      {screen === 'consent-selftest' && activeSource && (
        <ConsentAndSelfTestScreen
          source={activeSource}
          simulatedMode={simulatedMode}
          onCalibrationComplete={handleCalibrationComplete}
          onCancel={handleBackToHome}
        />
      )}

      {screen === 'player' && activeSource && calibration && (
        <PlayerScreen
          source={activeSource}
          calibration={calibration}
          provider={provider || new SimulatedTraceProvider()}
          onFinishSession={handleFinishSession}
          onExit={handleBackToHome}
        />
      )}

      {screen === 'review' && reviewedSession && (
        <ReviewAndPrivacyScreen
          session={reviewedSession}
          onBackToHome={handleBackToHome}
          initialTab={reviewTab}
        />
      )}
    </div>
  );
};

export default App;
