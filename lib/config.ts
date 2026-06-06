import type { AIService } from "./types"

/**
 * Backend planner endpoint.
 *
 * In production builds, the URL is baked in at build time from the
 * PLASMO_PUBLIC_PLANNER_URL environment variable. Set it in `.env` at the
 * repo root before running `npm run build`. Example:
 *
 *   PLASMO_PUBLIC_PLANNER_URL=https://mixerai-planner.up.railway.app/plan
 *
 * If the env var is not set, falls back to localhost — which is the
 * correct default for local development (where the planner runs via
 * `uvicorn server:app --port 8000`).
 *
 * NOTE: Plasmo only exposes env vars prefixed with PLASMO_PUBLIC_ to the
 * client bundle. Anything else stays server-only and won't reach the
 * extension code.
 */
export const PLANNER_URL =
  process.env.PLASMO_PUBLIC_PLANNER_URL || "http://localhost:8000/plan"

export const SERVICE_URLS: Record<AIService, string> = {
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
  gemini: "https://gemini.google.com",
  deepseek: "https://chat.deepseek.com"
}

/**
 * How long we'll wait for any single proposer/aggregator response.
 *
 * This is a LAST-RESORT cap, not a normal timeout. It exists only so that a
 * genuinely dead tab (crashed, logged out, Cloudflare-walled, or discarded by
 * Chrome) eventually surfaces a visible error instead of hanging the whole
 * pipeline forever. It must NEVER kill a response that is still actively
 * working — that job belongs to the hang watchdog in orchestrator.ts, which
 * fires only on NO PROGRESS, leaving genuinely long-but-streaming responses
 * untouched no matter how long they take.
 *
 * Set to 30 minutes to match the content-script polling loop's own ceiling
 * (NO_TIMEOUT_MS in make-adapter.ts). Previously this was 9 minutes — STRICTER
 * than the loop's 30 — so a legitimately long response (e.g. 10+ min of Claude
 * extended thinking) that the loop was happily waiting on would be killed here
 * first. Aligning the two means: actively-working responses run as long as they
 * need; only a true hang ever trips the cap.
 */
export const PROMPT_TIMEOUT_MS = 30 * 60 * 1000 + 30_000 // 30.5 min — just past the loop's 30-min ceiling so the loop delivers its result first
