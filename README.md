# Lecture Rewind

A desktop rewind engine for recorded lectures that tracks physical presence via local webcam signals and compiles absent intervals into a structured, chapter-snapped recovery queue.

## Design Principle

**Presence, never comprehension.** Lecture Rewind measures mechanical presence (whether a face is visible and whether eyes are open). It never measures comprehension, focus, or cognitive state, and it does not make emotional or wellness judgments.

## Core Capabilities

- **Absence Guard**: Pauses video playback when prolonged eye closure or physical absence is detected via corroborating geometric evidence.
- **Rewind Queue**: Transforms missed time into an ordered recovery playlist with pre-roll context and chapter boundary snapping.
- **Simulated Mode**: Complete application functionality, state machines, and playback testable with recorded signal traces—zero camera or API key required.
- **Local Privacy Firewall**: 100% on-device processing. Zero outbound application network requests, zero cloud sync, and one-click data erasure.

## Getting Started

### Prerequisites

- Node.js 20+ (LTS)
- npm 10+
- macOS, Linux, or Windows

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd lecture-rewind

# Install dependencies
npm install

# Verify type contracts
npm run typecheck

# Run automated tests
npm test
```

### Running the Application

```bash
# Start the application in development mode
npm run dev
```

### Simulated Mode (FR-17)

To run Lecture Rewind without a webcam or Presage API key:
1. Launch the application with `npm run dev`.
2. On the home or setup screen, toggle **Simulated Mode**.
3. Select any local lecture video or sample media.
4. The system will replay deterministic signal frames, driving the absence guard, markers, and queue builder without external dependencies.

## Privacy, Consent & Data Handling

1. **Camera Processing**: Video frames are analyzed in transient local memory via the Presage SmartSpectra SDK to compute eye aperture and head pose vectors. Frames are never written to disk, never buffered, and never transmitted.
2. **Local Storage**: Session documents are stored exclusively on your device in the standard user data directory (`<1 MB` per hour of playback).
3. **No Network Transmission**: The application makes zero application-level network requests. Outbound connections are monitored and blocked by an internal firewall.
4. **Data Deletion**: Complete one-click deletion wipes all session records, consent logs, and calibration settings permanently.
