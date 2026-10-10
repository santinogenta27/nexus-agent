# NexusAgent — Deep Research & Intelligence Agent

Give it a company name and/or a public URL plus a goal. NexusAgent forms three deductive hypotheses (product, pricing, friction), researches the company's live public web pages, computes verifiable metrics, writes an intelligence report and validates every claim before returning it.

```
Supervisor ──► Retrieval ──► Sandbox ──► Synthesizer ──► Critic
                                              ▲              │
                                              └── revise ≤ 3 ─┘
```

Built with **Gemini** (`@google/genai`) orchestrated through **Genkit**, an Express backend and a React 19 + Tailwind v4 frontend.

## Quick start

```bash
npm install
cp .env.example .env      # optional: set GEMINI_API_KEY (Google AI Studio Free Tier works)
npm run dev               # http://localhost:3000
```

Without a key, web research still runs live; the LLM nodes (Supervisor, Synthesizer, Critic judge) use the deterministic engine and the UI labels them `fallback`.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Express + Vite middleware on port 3000 (`tsx server.ts`) |
| `npm run genkit:dev` | Same server under the Genkit Developer UI |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | Unit and integration tests (`node:test` via tsx, local HTTP servers only) |
| `npm run build` | Production frontend build into `dist/` |
| `npm start` | `node server.ts` (Node ≥ 22.18). Set `NODE_ENV=production` to serve `dist/` |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Server-side only; never sent to the browser. Requests use `User-Agent: aistudio-build` |
| `GEMINI_MODEL` | `gemini-3.8-flash` | |
| `PORT` | `3000` | |

## API

- `GET /api/health` — status, Gemini configuration, Genkit tools/flow, rate-limit usage, research limits.
- `POST /api/agent/run` — body `{ goal, company?, url?, domain, depth }` (company or url required; `depth` = max critic cycles, 1–3). Returns `{ plan, traces, report, critic, telemetry, warnings }`. Send `Accept: application/x-ndjson` to stream node events.

## How each node works

- **Supervisor** — three testable hypotheses adapted to the goal and domain, each with evidence needed and a refutation criterion. Optionally suggests the official domain (verified before use).
- **Retrieval** (`server/research/`) — the user URL is the primary source; with only a name, candidate domains are tried and accepted only if the page names the company. Up to 6 pages (home, pricing, product, docs, customers) are fetched with concurrency 3 and extracted into verbatim evidence (value proposition, features, audience, prices, fees, custom pricing, friction signals, docs).
- **Sandbox** (`server/analysis/sandbox.ts`) — Zod-validates extracted data, then computes observed counts and calculated price levels in `node:vm`. Missing data yields `insufficient_data`, never an estimate.
- **Synthesizer** — report with profile, products/pricing, hypothesis verdicts, confirmed findings vs. inferences vs. open questions, prioritised risks/opportunities and recommendations (impact, effort, timeframe, KPI, hypothesis).
- **Critic** (`server/analysis/critic.ts`) — checks that claims cite retrieved evidence, snippets match fetched pages verbatim, calculations match an independent re-implementation, no figure is invented, verdicts are evidence-backed, and churn stays provisional and non-causal; plus an LLM judge for goal fit and contradictions. Failing reports go back to the Synthesizer (≤ 3 cycles); anything still failing is removed or replaced with evidence-only text and listed under limitations.

Research status is **Live** (all sources retrieved), **Partial** (some failed/empty or no pricing page) or **Fallback** (nothing retrieved — the report then contains no web findings).

## Fetch safety (`server/net/safeFetch.ts`)

- http/https only, ports 80/443, no URL credentials, internal names (`localhost`, `*.internal`, `*.local`, single-label hosts) rejected.
- DNS results are validated and the socket connects to the validated address (no DNS-rebinding window). Private, loopback, link-local/metadata, CGNAT, multicast, reserved and IPv4-mapped/NAT64 ranges are blocked.
- Every redirect hop is re-validated (max 3). 8 s per page, 22 s research budget, 3 MB per response (after decompression), HTML only.
- HTML is parsed with `node-html-parser`; scripts, styles and embeds are discarded, never executed.

## Limits

- Run budget 45 s; LLM calls are sized to fit (Supervisor 12 s, Synthesizer 18 s, judge 10 s); 500/503 retried twice (2 s, 4 s) if time remains; local 15 RPM / 1,500 RPD guard.
- Cost uses reference list prices ($0.30 / $2.50 per 1M input/output tokens); Free Tier usage is billed $0.

## Known limitations

- Client-rendered pages (little HTML text) are reported as `empty`; their content is not available without a browser.
- robots.txt is not consulted.
- Same-site detection uses the last two host labels, so multi-part TLDs (e.g. `.co.uk`) may limit page discovery.
- Price extraction is pattern-based; plan names are a heuristic and billing periods may be `unknown` (e.g. per-transaction pricing).
- `node:vm` is not a security boundary; it is used only for code generated from validated numbers, never model-written code.

## Project layout

```
server.ts                      Express, Vite middleware, Genkit tools + flow, orchestrator
server/net/safeFetch.ts        SSRF-safe HTTP client
server/research/               HTML extraction, evidence classification, site resolution & page discovery
server/analysis/               Sandbox metrics and Critic validation
server/agent/deductive.ts      Hypotheses, evidence coverage, deterministic report
src/types/agent.ts             Zod schemas and shared types
src/components/                Navbar, Agent DAG + research report, System Architecture page
tests/                         Fetch safety, extraction, research, sandbox and critic tests
```
