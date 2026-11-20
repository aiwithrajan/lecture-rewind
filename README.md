# Lecture Rewind

A consent-first lecture recovery engine built with **Electron, React 18, and TypeScript** that tracks physical presence via local webcam signals and compiles missed intervals into a structured, chapter-snapped recovery queue.

- 🌐 **Live Web Demo**: [https://presage-bice.vercel.app](https://presage-bice.vercel.app)
- 💻 **Public GitHub**: [https://github.com/aiwithrajan/lecture-rewind](https://github.com/aiwithrajan/lecture-rewind)

> **Design Axiom: Presence, never comprehension.**  
> Lecture Rewind strictly measures mechanical physical presence (whether a face is in frame and eyes are open). It never makes medical claims, emotional inferences, or focus/comprehension judgments.

---

## ⚡ 60-Second Hackathon Judge Quickstart

You can test 100% of the application's capabilities **without a webcam, API key, or external dependencies** using the built-in **Simulated Mode (FR-17, AC-6)**.

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suite (76/76 unit tests pass in ~1.5s)
npm test

# 3. Verify strict TypeScript types (0 errors)
npm run typecheck

# 4. Launch the application
npm run dev
```

### In-App Demo Walkthrough
1. **Home Screen**: Toggle **"Simulated Mode"** in the top-right corner.
2. **Start Video**: Paste any YouTube lecture URL (e.g. `https://www.youtube.com/watch?v=kQtQnC6Zp_s`) or click **"Select Local Video File"**.
3. **Consent & Guided Self-Test**: Click **"Start Guided Calibration"** (runs a 5s quick or 20s full signal self-test with live reliability scoring).
4. **Playback & Absence Guard**:
   - The video plays with real-time presence tracking.
   - When prolonged eye closure or physical absence occurs, playback **auto-pauses** with an overlay: *"Resume (-30s)"* or *"Take 2-min Break"*.
   - Involuntary vs intentional double-blinks trigger rapid bookmarks (**Rule F**).
   - Press hotkeys: `Space` (Pause/Resume -30s), `T` (Take a break), `B` (Bookmark), `N` (Notes mode toggle).
5. **Review & Recovery Screen**:
   - **Compiled Rewind Queue**: Click **"Play Clip ▶"** or **"Play All Missed Clips"** to rewatch only the missed sections (with 10s pre-roll context). The player automatically stops when the interval ends.
   - **Interactive Timeline**: Click any detected pause, brief marker, or bookmark to jump straight to that moment.
   - **rPPG Pulse Context (FR-15)**: Displays heart rate variation context along the timeline (informational only; never triggers decisions).
   - **AI Session Review Agent**: Switch between **Gemini 2.5 Flash**, **Local Ollama** (`lecture-rewind-gemma:latest`), or **Instant Deterministic Engine (0.0s)** in English or Hinglish with clickable `▶ MM:SS` jump chips!
   - **Privacy & Firewall**: View the zero-outbound-network counter (AC-8) and trigger a 1-click irreversible data deletion (AC-7).

---

## 🎯 PRD Acceptance Criteria (AC-1 to AC-9) Matrix

| # | Acceptance Criterion | Verification Mechanism | Status |
| :---: | :--- | :--- | :---: |
| **AC-1** | Pause on 5/5 staged absences; 0 pauses during 10 min normal viewing | Deterministic test replaying `staged-session-trace.json` (`tests/detection-engine.spec.ts`) | **PASS** |
| **AC-2** | $\ge 4/5$ staged brief lapses ($3\text{s}-5\text{s}$) produce a marker without pausing | Evaluates Evidence Rule D closure markers (`tests/detection-engine.spec.ts`) | **PASS** |
| **AC-3** | $\le 1$ false marker per 10 min normal viewing | Continuous EAR trace assertion with blink duration bounds (`tests/detection-engine.spec.ts`) | **PASS** |
| **AC-4** | Rewind queue total within 10s of staged absence ground-truth sum | Validates pre-roll (+10s), interval merging, and 15s grid snapping (`tests/queue-builder.spec.ts`) | **PASS** |
| **AC-5** | Low-confidence stretches visually distinct and excluded from queue | Quality ribbon confidence tagging; excluded from recovery queue (`tests/queue-builder.spec.ts`) | **PASS** |
| **AC-6** | Full application operates in Simulated Mode without camera or keys | Complete offline synthetic trace generator (`SimulatedTraceProvider.ts`) | **PASS** |
| **AC-7** | 1-Click wipe leaves no session, consent, or settings files on disk | Disk storage verification after `deleteAllData()` (`tests/storage.spec.ts`) | **PASS** |
| **AC-8** | Zero application-level network requests (strict local privacy) | Electron webRequest interceptor and real-time request counter (`tests/storage.spec.ts`) | **PASS** |
| **AC-9** | Self-test calibration reports reliability verdict; refuses overstatement | High-variance / degraded eye aperture calibration boundary tests (`tests/detection-engine.spec.ts`) | **PASS** |

---

## 🛠️ Complete Functional Requirements (FR-1 to FR-18)

- **FR-1**: Euclidean Eye Aspect Ratio (EAR) & 3D head pose extraction (MediaPipe FaceMesh WASM + SmartSpectra SDK fallback).
- **FR-2**: Guided self-test calibration (neutral hold + prompted closure + latency estimation).
- **FR-3**: Corroborating evidence evaluator (Rules A, B, C, D, E, F).
- **FR-4**: 6-state corroborate state machine (`Watching`, `Suspect`, `Absent`, `Waiting`, `Returned`, `Degraded`).
- **FR-5**: Automatic playback pause with customizable sensitivity ($5.0\text{s}-10.0\text{s}$, default $6.0\text{s}$) and 30s resume rewind.
- **FR-6**: In-playback brief closure markers ($3\text{s}-5\text{s}$ closures that do not halt playback).
- **FR-7**: Rewind queue compilation with $+10\text{s}$ pre-roll context.
- **FR-8**: Sidecar chapter snapping (`.vtt`, `.chapters.vtt`, `.json`, `.chapters.json`, or 15s grid).
- **FR-9**: Adjacent interval merging for pauses separated by $\le 30\text{s}$.
- **FR-10**: Quality ribbon displaying green high-confidence vs muted low-confidence buckets.
- **FR-11**: "Take a Break" overlay with 2-minute countdown timer and pause state hold.
- **FR-12**: Session history median absence calculation ($\ge 3$ sessions) with 1-click scheduled break injection.
- **FR-13**: Gesture double-blink bookmarks ($180\text{ms}-800\text{ms}$ with 3.5s refractory cooldown).
- **FR-14**: Review screen with Recovery Clip Player, Sequential Replay, Presence Breakdown ring, and Mark Reviewed checklist.
- **FR-15**: Informational rPPG pulse context curve (SVG visualization along the timeline).
- **FR-16**: One-click irreversible data deletion (AC-7).
- **FR-17**: Hardware-independent Simulated Mode (AC-6).
- **FR-18**: Outbound network firewall & optional opt-in telemetry toggle (AC-8).

---

## 🤖 3-Tier Hybrid AI Session Review Agent

Processes session JSON to answer queries, explain missed intervals, and provide timestamped rewatch recommendations:
1. **Tier 1 (Cloud)**: Google Gemini 2.5 Flash (`thinkingBudget: 0` for sub-second responses).
2. **Tier 2 (Local Open-Source)**: Local Ollama LLM (`lecture-rewind-gemma:latest` or custom fine-tune) with zero cloud dependency.
3. **Tier 3 (Offline Deterministic)**: Instant 0.0s rule-based analyzer with zero latency and zero GPU/cloud requirement.
- Supports **English** and **Hinglish** languages.
- Interactive `▶ MM:SS` chips that seek the video and open the recovery clip player in 1 click.
- Extracts real spoken caption excerpts from YouTube timed text XML for rich topic context.

---

## 🔒 Privacy & PRD Section 12 Compliance

- **No Video Storage**: Raw video frames are processed in transient RAM and never written to disk.
- **Local Storage**: Session JSON records are stored locally in the OS application data folder (`<1 MB` per hour).
- **Section 12 Non-Negotiable Vocabulary Compliance**: Zero use of prohibited terms (*"sleep"*, *"drowsiness"*, *"fatigue"*, *"stress"*, *"focus"*, *"attention"*). Tested and audited via static analysis.

---

## ⌨️ Keyboard Shortcuts Reference

| Shortcut | Action |
| :---: | :--- |
| `Space` | Toggle Play/Pause or Resume 30s earlier from absence overlay |
| `T` | Trigger Take a Break (2-minute countdown timer) |
| `B` | Add manual bookmark at current video position |
| `N` | Toggle Notes Mode (adjusts pitch threshold for downward desk viewing) |
| `Escape` | Dismiss active overlay or pause alert |
| `1` – `4` | Switch video playback speed ($1\times, 1.25\times, 1.5\times, 2\times$) |

---

## 🧪 Testing & Verification

```bash
# Run all 76 unit tests
npm test

# Run TypeScript typecheck
npm run typecheck

# Build production bundle
npm run build
```

Built for the **Presage Technologies Hackathon** adhering strictly to the **Lecture Rewind PRD v1.0**.
