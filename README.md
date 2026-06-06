<div align="center">

# 🧠 MixerAI

### Turn the AI subscriptions you already pay for into one smarter answer

<p>
  <img src="https://img.shields.io/badge/platform-Chrome%20MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/Plasmo-MV3%20framework-7042F5?style=flat-square" alt="Plasmo">
  <img src="https://img.shields.io/badge/FastAPI-planner-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI">
  <img src="https://img.shields.io/badge/Railway-deployed-0B0D0E?style=flat-square&logo=railway&logoColor=white" alt="Railway">
</p>
<p>
  <img src="https://img.shields.io/badge/architecture-Mixture--of--Agents-FF6F61?style=flat-square" alt="Mixture of Agents">
  <img src="https://img.shields.io/badge/API%20keys-none%20needed-2EA043?style=flat-square" alt="No API keys">
  <img src="https://img.shields.io/badge/inference%20cost-~%240%20marginal-2EA043?style=flat-square" alt="Near-zero cost">
  <img src="https://img.shields.io/badge/works%20in-background%20tabs-2EA043?style=flat-square" alt="Background-tab resilient">
</p>

<sub><b>One question. Several frontier models. One answer better than any of them alone.</b></sub>

</div>

---

## ✨ Overview

Most "use many AIs at once" tools fan your prompt out to several models and hand you **N separate answers to read and compare**. That's parallel access, not synthesis.

**MixerAI is different.** It runs a true **Mixture-of-Agents** pipeline: several models each draft an answer, one model **synthesizes** them into a single stronger response, another **audits** that response for errors and weak reasoning, and a final pass **revises** it. You get *one* answer — built from the strengths of all of them.

The twist that makes it practical: **it uses the AI subscriptions you already have.** Instead of paid APIs, MixerAI drives your logged-in ChatGPT, Claude, and Gemini tabs directly in the browser. If you already pay for them, orchestrating all three together costs **effectively nothing** per query — no API keys, no per-token billing.

## 🔬 How it works

```
                    ┌─────────────┐
   your prompt ───▶ │   Planner   │  decides the pipeline per task
                    │  (FastAPI)  │  (which models, which roles)
                    └──────┬──────┘
                           ▼
               ┌──────────┬──────────┐
               ▼          ▼          ▼
          ┌─────────┐┌─────────┐┌─────────┐
          │ ChatGPT ││ Claude  ││ Gemini  │   PROPOSERS
          └────┬────┘└────┬────┘└────┬────┘   (parallel drafts)
               └──────────┼──────────┘
                          ▼
                   ┌──────────────┐
                   │ SYNTHESIZER  │  merges drafts into one answer
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │   AUDITOR    │  critiques for errors & gaps
                   └──────┬───────┘
                          ▼
                   ┌──────────────┐
                   │   REVISER    │  produces the final answer
                   └──────┬───────┘
                          ▼
                    one better answer
```

## 🎯 Features

- 🧩 **Real Mixture-of-Agents pipeline** — propose → synthesize → audit → revise, not just side-by-side answers.
- 💸 **Uses your own subscriptions** — no API keys, no token bills. Near-zero marginal cost per query.
- 🧠 **Adaptive planning** — a backend planner reads the task and picks which models propose, synthesize, and audit, with a distinct *perspective* per proposer so drafts don't converge.
- 🌐 **Background-tab resilient** — captures streamed responses at the network layer, so runs survive Chrome's aggressive throttling of backgrounded tabs.
- 🎭 **Three frontier models, one panel** — ChatGPT, Claude, and Gemini orchestrated together from a single Chrome side panel.
- 🔭 **Live pipeline view** — watch each stage (proposing, synthesizing, auditing, revising) progress in real time.

## 🏗️ The hard part: surviving backgrounded tabs

The engineering challenge that defines MixerAI: **Chrome throttles background tabs.** When a tab isn't visible, its rendering pipeline stalls — so reading an AI's answer from the DOM is unreliable the moment the user looks away.

MixerAI solves this by capturing responses at the **network layer** instead. In each tab's `MAIN` world it wraps `XMLHttpRequest`, `fetch`, and `WebSocket`, capturing the raw streamed response **independent of whether the tab is rendering**. A polling loop then reconciles two sources of truth — the rendered DOM (polished, but throttled) and the network capture (complete, but raw) — and chooses the right one per situation, with multiple completion-detection fallbacks and a final truncation guard that prefers the complete capture if the DOM is missing a tail.

Each service streams differently, and each quirk was reverse-engineered and handled individually:

| Service | Transport | Notable quirk handled |
|:--------|:----------|:----------------------|
| **ChatGPT** | WebSocket conduit | finalizes only on explicit completion frames + a minimum-frame floor (reasoning models pause mid-turn) |
| **Claude** | SSE + DOM | reconciles rendered DOM against the raw stream; truncation guard on the tail |
| **Gemini** | `batchexecute` | filters dozens of tiny heartbeat payloads to find the one real ~160 KB answer chunk |

## 🛠️ Built With

- **TypeScript · React · [Plasmo](https://www.plasmo.com/)** — Chrome Manifest V3 extension + side-panel UI
- **MAIN-world network interception** — `XHR` / `fetch` / `WebSocket` capture, Trusted-Types-safe
- **Python · FastAPI** — the planning service that decides each pipeline
- **Claude Opus** — powers the planner's task analysis and role assignment
- **Railway** — planner deployment
- **Zero runtime dependencies in the capture core** — hand-rolled for resilience

## 🗂️ Architecture

A shared adapter factory drives every service through one well-tested send-and-capture loop; per-service content scripts supply only the selectors and extractors that differ.

| File | Responsibility |
|:-----|:---------------|
| `sidepanel.tsx` | React side-panel UI — task setup, role selection, live pipeline status |
| `background.ts` | MV3 service worker — orchestrates the run, manages tabs, talks to the planner |
| `lib/orchestrator.ts` | Executes the plan: proposers → synthesize → audit → revise, with hang-recovery |
| `lib/make-adapter.ts` | Shared send + polling loop; DOM/network reconciliation and all exit paths |
| `lib/config.ts` | Service URLs, planner endpoint, timeouts |
| `lib/backend-capture-client.ts` | Isolated-world reader for captured network responses |
| `lib/adapter-utils.ts` · `lib/auth-detector.ts` · `lib/types.ts` | Shared helpers, login detection, types |
| `contents/backend-capture-page.ts` | MAIN-world network interception + per-service extractors |
| `contents/{chatgpt,claude,gemini}.ts` | Per-service selectors & adapters |
| `planner/server.py` | FastAPI `/plan` endpoint — Opus decides models, roles, and per-proposer perspectives |

## 🚀 Running It

**Extension**
```bash
npm install
npm run build          # outputs build/chrome-mv3-prod
```
Then load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `build/chrome-mv3-prod`. Open the side panel on any supported AI site and you're set.

**Planner** (only needed if you're running the backend locally)
```bash
cd planner
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn server:app --reload --port 8000
```
By default the built extension points at the hosted planner on Railway, so most development needs no local backend.

## 🔒 Privacy

MixerAI runs on top of the user's own AI sessions; it does not store credentials and uses no API keys. The planner receives the task prompt to decide a pipeline. Captured responses are processed locally in the browser to assemble the final answer.

---

<div align="center">

**Built solo — design, architecture, and deployment.**

© 2026 Ethan Irimiciuc · All rights reserved.

</div>
