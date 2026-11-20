---
title: Lecture Rewind — A Consent-First Rewind Engine for Video Lectures Using Presage Biometrics
published: true
tags: presagechallenge, devchallenge, ai, privacy
cover_image: https://raw.githubusercontent.com/aiwithrajan/lecture-rewind/main/assets/cover.png
canonical_url: https://github.com/aiwithrajan/lecture-rewind
---

*This is a submission for the [Presage Challenge](https://dev.to/challenges/presage).*

---

## 💡 What I Built

**Lecture Rewind** is an open-source, consent-first lecture recovery engine designed for students and self-directed learners. 

- 🌐 **Live Web Demo**: [https://presage-bice.vercel.app](https://presage-bice.vercel.app)
- 💻 **GitHub Repository**: [https://github.com/aiwithrajan/lecture-rewind](https://github.com/aiwithrajan/lecture-rewind) 

When studying complex video lectures (whether a 2-hour university course, code architecture briefing, or technical symposium), learners inevitably experience brief physical lapses — looking down at notes, walking away to grab water, or closing their eyes during long explanations. 

Instead of forcing users to rewind blindly or guess what they missed, **Lecture Rewind passively watches the lecture with you**. Using on-device biometric signals powered by the **Presage SmartSpectra SDK** and a 478-point facial mesh, it flags intervals where the viewer was physically absent or experienced prolonged eye closure. 

Upon concluding a study session, the app compiles these moments into an **interactive, chapter-snapped Rewind Queue**. In one click, students can replay only what they missed — pre-rolled by 10 seconds for narrative continuity — saving hours of study time.

> 🧭 **Core Design Axiom: Presence, never comprehension.**  
> Lecture Rewind strictly observes mechanical physical presence (facial pose and eye aperture). It makes **zero** diagnosis or treatment claims, **zero** emotional or cognitive inferences, and adheres strictly to consensual, local-first monitoring.

---

## 🎥 Demo Video

**Watch the full 2-minute walkthrough with synchronized on-device tracking & AI narration:**

{% youtube DL14YK4us90 %}

[![Lecture Rewind Demo Video](https://img.youtube.com/vi/DL14YK4us90/maxresdefault.jpg)](https://www.youtube.com/watch?v=DL14YK4us90)

> 📹 **YouTube Link**: [https://youtu.be/DL14YK4us90](https://youtu.be/DL14YK4us90)  
> The walkthrough highlights:
> 1. Guided 20-second biometric calibration & sensor reliability verdict.
> 2. Real-time eye aspect ratio (EAR) and blink tracking HUD with absence detection.
> 3. Full-Session Review Screen with interactive timelines and compiled rewind queues.
> 4. In-session sequential replay of missed segments.

---

## 🛠️ How SmartSpectra SDK Is Integrated

Lecture Rewind integrates the **SmartSpectra SDK** (`@smartspectra/node-sdk` / on-device vision pipeline) to extract non-invasive physiological and facial metrics directly from the local webcam stream:

1. **Eye Aperture & Prolonged Closure Analysis**:
   - The engine computes the **Eye Aspect Ratio (EAR)**:
     $$\text{EAR} = \frac{\|p_2 - p_6\| + \|p_3 - p_5\|}{2 \|p_1 - p_4\|}$$
   - When EAR falls below the calibrated threshold ($< 0.22$) for $> 6.0$ seconds (or when facial presence is lost for $> 4.0$ seconds), the session marks a mechanical absence.
2. **Intentional Gesture Bookmarking (Rule F)**:
   - Differentiates involuntary blinks ($< 350\text{ ms}$) from rapid intentional double-blinks ($2$ blinks within $800\text{ ms}$) to drop an instant bookmark without taking your hands off the keyboard.
3. **rPPG Pulse Context Line (FR-15)**:
   - Presage SmartSpectra pulse rate signals are sampled and aggregated into a 12-second rolling average on the review timeline, providing purely informational context alongside missed intervals.
4. **Resilient Simulated Mode (FR-17, AC-6)**:
   - Includes a deterministic hardware-independent simulation layer that replays calibrated session traces so judges and developers can evaluate 100% of the platform without needing a physical camera.

---

## 🛡️ Consent and Data Handling

Privacy and consent are the foundational pillars of Lecture Rewind.

- **Explicit Informed Consent**: Before any camera stream is activated, users are presented with a clear consent screen detailing exactly which signals are captured. Consent is never assumed or hidden.
- **Strictly Local Processing**: All computer vision inference and SmartSpectra SDK signals run **100% on-device**. 
- **Zero Raw Video Storage**: No webcam frames or video recordings are ever written to disk, stored in memory buffers beyond the immediate frame, or transmitted across a network.
- **Outbound Network Firewall (AC-8)**: Electron's session request interceptor blocks all external network traffic. The in-app Network Guard displays a real-time counter verifying **0 outbound requests**.
- **1-Click Irreversible Data Wipe (AC-7)**: A dedicated *Privacy & Firewall* panel enables users to permanently purge session metadata, timestamps, and calibration profiles with one click.
- **Section 12 PRD Compliance**: The system vocabulary is strictly mechanical ("prolonged eye closure", "physical absence", "intervals where viewer was not present"). Prohibited subjective and medical terms ("sleep", "drowsiness", "fatigue", "stress", "focus", "attention") are never used.

---

## 🚀 Setup & Testing Instructions for Judges

Judges can run the entire test suite and experience the complete live application in under 2 minutes:

### Prerequisites
- Node.js 18+ and npm installed.

### Quickstart
```bash
# Clone the public repository
git clone https://github.com/aiwithrajan/lecture-rewind.git
cd lecture-rewind

# Install dependencies (includes Electron and React 18)
npm install

# Run automated unit test suite (76/76 unit tests pass in ~1.5s)
npm test

# Verify TypeScript type integrity (0 errors)
npm run typecheck

# Start the desktop application
npm run dev
```

### Testing Without a Webcam (Simulated Mode)
1. On the Home Screen, toggle **"Simulated Mode"** in the top header.
2. Click **"▶ Start with relay-demo.mp4"** or select any local `.mp4` file.
3. Observe the automated 20-second calibration and guided self-test.
4. Experience real-time absence detection, auto-pause overlays, and the compiled rewind queue on the Review Screen.

---

## 💻 Public Code Repository

- **GitHub Repository**: [https://github.com/aiwithrajan/lecture-rewind](https://github.com/aiwithrajan/lecture-rewind)
- **License**: MIT
- **Live Demo & Test Suite**: 76 unit tests passing across all core modules.

---

*Thank you to the Presage Technologies team and DEV for hosting the challenge!*
