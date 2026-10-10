# ⚡ NexusAgent — Autonomous Multi-Agent Deep Research System

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-3.1_Flash_Lite-orange.svg)](https://ai.google.dev/)
[![Tests](https://img.shields.io/badge/Tests-130%2F130_Passing-brightgreen.svg)]()
[![Architecture](https://img.shields.io/badge/Architecture-DAG_Multi--Agent-purple.svg)]()
[![Security](https://img.shields.io/badge/Security-SSRF_Safe-red.svg)]()
[![License](https://img.shields.io/badge/License-MIT-green.svg)]()

> **Enterprise-grade competitive intelligence & market research engine.**  
> Give it a company name and/or a public URL plus a goal. NexusAgent investigates the company's live public web pages, tests deductive hypotheses, computes deterministic metrics, and validates every claim with verbatim citations before returning an executive report.

🌐 **Live Demo (Production):** [https://nexus-agent-rub3.onrender.com](https://nexus-agent-rub3.onrender.com)  
💻 **GitHub Repository:** [https://github.com/santinogenta27/nexus-agent](https://github.com/santinogenta27/nexus-agent)

---

## 🏗️ Multi-Agent Architecture (DAG)
[ User Input / Company URL ]
│
▼
┌─────────────────┐
│ 🧠 SUPERVISOR │ Formulates 3 testable deductive hypotheses (product, pricing, friction)
└────────┬────────┘
│
▼
┌─────────────────┐
│ 🌐 RETRIEVAL │ Discovers & fetches official pages with strict SSRF controls
└────────┬────────┘
│
▼
┌─────────────────┐
│ 🧮 SANDBOX │ Deterministic pricing normalization & recurring metrics (node:vm)
└────────┬────────┘
│
▼
┌─────────────────┐
│ 📑 SYNTHESIZER │ Compiles structured intelligence report with verbatim citations
└────────┬────────┘
│
▼ (Up to 2-3 revision cycles)
┌─────────────────┐
│ ⚖️ CRITIC (JUDGE)│ Validates C1–C9 rules: citations, math, & factual consistency
└─────────────────┘
│
▼
[ Final Verified Intelligence Report ]
code
Code
Built with **Gemini (`@google/genai`)** orchestrated through **Genkit**, an **Express** backend in TypeScript, and a modern **React 19 + Tailwind v4** frontend.

---

## 📊 Live Case Study: Notion (`notion.so`)

Tested live in production using `gemini-3.1-flash-lite`:

| Metric | Measured Value |
| :--- | :--- |
| **Pipeline Latency** | ~19s live (cold start P95: 39s) |
| **Token Usage** | 9,094 in / 3,490 out |
| **Query Cost** | **$0.0115 USD** (list-price eq.) |
| **Sources Retrieved** | 6/6 official pages (Home, Pricing, Product, Docs, Customers, AI) |
| **Verbatim Citations** | **62 snippets verified verbatim against fetched pages** |
| **Automated Tests** | **130 / 130 passing** |

### Key Competitive Findings Uncovered:
1. **AI Cost Unpredictability (Friction):** Identified Notion's credit-based model for AI agents ($10 per 1,000 monthly credits) as a major unpredictability risk for scaling teams.
2. **Deterministic Tiers:** Cleanly mapped recurring tiers ($0 Free, $10 Plus, $20 Business/seat/mo) while safely excluding domain add-ons ($8–$10/domain) from baseline calculations.
3. **Intellectual Honesty:** Marked adoption friction as `Partially Supported` due to lack of public churn metrics—proving strict adherence to verifiable facts over LLM assumptions.

---

## 🛡️ Production Engineering & Security Guardrails

### 1. SSRF-Safe Web Fetcher (`server/net/safeFetch.ts`)
- **Protocol & Ports:** HTTP/HTTPS only, ports 80/443. Credentials in URLs are rejected.
- **DNS & IP Validation:** Resolves DNS before connection; blocks private, loopback, link-local/cloud metadata (`169.254.169.254`), CGNAT, and IPv4-mapped/NAT64 ranges. No DNS-rebinding window.
- **Redirect Discipline:** Every redirect hop is re-validated (max 3). Limits: 8s per page, 22s research budget, 3MB per response.
- **Parsing Security:** HTML parsed with `node-html-parser`. Scripts, stylesheets, and iframes are discarded—never executed.

### 2. Isolated Computational Sandbox (`server/analysis/sandbox.ts`)
- All pricing metrics (M1–M11) and distributions (lowest, highest, median, spread) are computed deterministically in `node:vm`.
- Missing or incompatible units yield `insufficient_data` instead of model hallucinations.

### 3. Critic & Verification Stage (`server/analysis/critic.ts`)
Evaluates 8 deterministic rules plus an LLM judge:
- **C1–C3:** Validates that claims cite retrieved evidence verbatim from original HTML.
- **C4–C6:** Recomputes metrics independently; verifies zero invented figures.
- **C7–C9:** Enforces recommendation-to-hypothesis alignment and goal fit.

---

## ⚡ Quick Start (Local Setup)

```bash
git clone https://github.com/santinogenta27/nexus-agent.git
cd nexus-agent
npm install
cp .env.example .env      # Set GEMINI_API_KEY
npm run dev               # Full-stack server at http://localhost:3000
Note: Without an API key, the system runs with the deterministic engine in fallback mode.
Scripts
Script	Purpose
npm run dev	Express + Vite middleware on port 3000 (tsx server.ts)
npm run genkit:dev	Launch under the Genkit Developer UI
npm run lint	TypeScript type-checking (tsc --noEmit)
npm test	Run the 130 unit and integration tests
npm run build	Production frontend build into dist/
npm start	Production Node server (node server.ts)
⚙️ Environment Variables
Variable	Default	Description
GEMINI_API_KEY	—	Google Gemini API key (server-side only, never sent to browser)
GEMINI_MODEL	gemini-3.1-flash-lite	Production model (gemini-3.1-flash-lite or gemini-3.8-flash)
PORT	3000	Server listening port
NODE_ENV	development	Set to production when serving compiled frontend
📁 Project Layout
code
Text
server.ts                      # Express, Vite middleware, Genkit orchestrator
server/net/safeFetch.ts        # SSRF-safe HTTP client with IP validation
server/research/               # HTML extraction, evidence classification & page discovery
server/analysis/               # Sandbox metrics (node:vm) and Critic validation
server/agent/deductive.ts      # Deductive hypotheses and deterministic engine
src/types/agent.ts             # Zod schemas and shared domain contracts
src/components/                # React 19 UI: DAG visualizer, reports, telemetry
tests/                         # 130 automated unit, sandbox, and integration tests
