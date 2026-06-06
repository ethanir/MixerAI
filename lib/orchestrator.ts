import { PROMPT_TIMEOUT_MS, SERVICE_URLS } from "./config"
import type {
  AdapterResponse,
  AIService,
  ProposerResult,
  TaskPlan,
  TaskUpdate
} from "./types"

export type EmitUpdate = (update: TaskUpdate) => void

/**
 * Execute a planned MoA task.
 *
 * Three strategies, picked by the planner:
 *
 *   "simple"     → 1 proposer = aggregator. Send the prompt once, done.
 *
 *   "moa"        → Standard Mixture-of-Agents (Wang et al, ICLR 2025):
 *                  1. Run all proposers in parallel, independently.
 *                  2. Aggregator audits the drafts (identifies disagreements,
 *                     decides which is right, re-derives where needed) and
 *                     produces a unified final answer.
 *
 *   "moa_critic" → MoA + independent-critic pass, Pro+ only. After the aggregator
 *                  drafts, a DIFFERENT model audits the draft alone (without seeing
 *                  the proposer outputs — Chain-of-Verification independence
 *                  principle, Dhuliawala et al., Meta AI 2023, prevents the
 *                  drafter from copying its own hallucinations). The aggregator
 *                  then revises based on the audit and ships the final.
 */
export async function executeTask(
  prompt: string,
  plan: TaskPlan,
  emit: EmitUpdate
): Promise<string> {
  // Make sure all needed tabs exist before dispatching
  const allServices = [
    ...plan.proposers.map((p) => p.service),
    plan.aggregator.service
  ]
  if (plan.critic) allServices.push(plan.critic.service)
  await ensureTabsExist(Array.from(new Set(allServices)))

  // --- Step 1: Proposers in parallel ---
  // Each proposer gets an effort-maximizing prompt and works independently.
  // They are told their draft will be merged with others — but they are NOT
  // told to anticipate consensus. Diversity of perspective is the whole point
  // (MoA "collaborativeness" property: even lower-quality auxiliary drafts
  // measurably improve the aggregator's output).
  //
  // v1.6.0: each proposer also gets a distinct "perspective" (PRIMARY,
  // STRESS-TEST, DEPTH) that forces real divergence between drafts. The
  // perspective is selected by the proposer's index in the plan — order
  // matters here. See PROPOSER_PERSPECTIVES in this file for the design
  // notes and the research grounding.
  const proposerResults = await Promise.allSettled(
    plan.proposers.map(async (p, idx): Promise<ProposerResult> => {
      emit({ type: "PROPOSER_STARTED", service: p.service })
      const start = Date.now()
      try {
        const proposerPrompt = buildProposerPrompt(prompt, plan, idx)
        const text = await sendPromptToService(p.service, proposerPrompt)
        const durationMs = Date.now() - start

        if (!text || text.trim().length === 0) {
          const error = `${p.service}: response captured was empty. The page selectors may need updating.`
          emit({ type: "PROPOSER_FAILED", service: p.service, error })
          throw new Error(error)
        }

        emit({
          type: "PROPOSER_DONE",
          service: p.service,
          text,
          durationMs
        })
        return { service: p.service, text, durationMs }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        emit({ type: "PROPOSER_FAILED", service: p.service, error })
        throw err
      }
    })
  )

  const successful = proposerResults
    .filter(
      (r): r is PromiseFulfilledResult<ProposerResult> =>
        r.status === "fulfilled"
    )
    .map((r) => r.value)

  if (successful.length === 0) {
    const errors = proposerResults
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) =>
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      )
      .join("; ")
    throw new Error(`All proposers failed: ${errors}`)
  }

  // --- Fast-path: simple strategy ---
  if (plan.strategy === "simple") {
    const finalText = successful[0].text
    emit({
      type: "AGGREGATOR_DONE",
      text: finalText,
      durationMs: 0
    })
    emit({ type: "TASK_COMPLETE", finalText })
    return finalText
  }

  // --- Step 2: Aggregator drafts the synthesis ---
  emit({ type: "AGGREGATOR_STARTED", service: plan.aggregator.service })
  const aggregatorPrompt = buildAggregatorPrompt(
    prompt,
    successful,
    plan,
    /* willBeCritiqued */ plan.strategy === "moa_critic"
  )
  const aggStart = Date.now()
  const draftText = await sendPromptToService(
    plan.aggregator.service,
    aggregatorPrompt
  )
  emit({
    type: "AGGREGATOR_DONE",
    text: draftText,
    durationMs: Date.now() - aggStart
  })

  // --- Standard MoA: aggregator's draft IS the final ---
  if (plan.strategy === "moa" || !plan.critic) {
    emit({ type: "TASK_COMPLETE", finalText: draftText })
    return draftText
  }

  // --- Step 3: Critic audit (different model, independent of the proposers) ---
  emit({ type: "CRITIC_STARTED", service: plan.critic.service })
  const criticPrompt = buildCriticPrompt(prompt, draftText, plan)
  const critStart = Date.now()
  const critique = await sendPromptToService(plan.critic.service, criticPrompt)
  emit({
    type: "CRITIC_DONE",
    text: critique,
    durationMs: Date.now() - critStart
  })

  // --- Step 4: Aggregator revises based on the critique ---
  emit({ type: "REVISION_STARTED", service: plan.aggregator.service })
  const revisionPrompt = buildRevisionPrompt(prompt, draftText, critique, plan)
  const revStart = Date.now()
  const finalText = await sendPromptToService(
    plan.aggregator.service,
    revisionPrompt
  )
  emit({
    type: "REVISION_DONE",
    text: finalText,
    durationMs: Date.now() - revStart
  })

  emit({ type: "TASK_COMPLETE", finalText })
  return finalText
}

// ============================================================================
// Port-based prompt dispatch
// ============================================================================

/**
 * Send a prompt to a service's content script and await the full response.
 *
 * Uses a long-lived port (chrome.tabs.connect) rather than a one-shot
 * chrome.tabs.sendMessage. One-shot messages have an implicit channel
 * timeout — for long operations (DeepThink, extended thinking, Opus deep
 * reasoning) Chrome closes the channel before sendResponse fires, producing:
 *   "A listener indicated an asynchronous response by returning true,
 *    but the message channel closed before a response was received."
 * Ports keep the channel open until one side explicitly disconnects.
 */
// Monotonic request ID counter. Each sendPromptToService call gets a unique
// ID so the content script can cache results and the orchestrator can
// recover by ID if the port-based delivery fails.
let nextRequestId = 1

/**
 * Try to fetch a cached result from the content script via a one-shot
 * chrome.tabs.sendMessage. Used as the recovery path when the long-lived
 * port disconnects before delivering RESULT.
 *
 * This works even after the original port is dead because sendMessage
 * starts a fresh channel, and the content script's recentResults cache
 * survives port disconnects (it lives on window.__mixerai).
 */
async function tryFetchCachedResult(
  tabId: number,
  requestId: number,
  service: AIService
): Promise<{ ok: true; text: string } | { ok: false; error: string } | null> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: "GET_CACHED_RESULT",
      requestId
    })
    if (!resp || !resp.found) {
      console.log(
        `[MixerAI/orch] recovery: ${service} GET_CACHED_RESULT requestId=${requestId} → no cached result (${resp?.reason ?? "no-response"})`
      )
      return null
    }
    if (resp.error) {
      console.log(
        `[MixerAI/orch] recovery: ${service} GET_CACHED_RESULT requestId=${requestId} → cached ERROR`
      )
      return { ok: false, error: resp.error }
    }
    console.log(
      `[MixerAI/orch] recovery: ${service} GET_CACHED_RESULT requestId=${requestId} → cached OK textLen=${(resp.text ?? "").length}`
    )
    return { ok: true, text: resp.text ?? "" }
  } catch (e) {
    console.log(
      `[MixerAI/orch] recovery: ${service} GET_CACHED_RESULT requestId=${requestId} → threw ${e instanceof Error ? e.message : String(e)}`
    )
    return null
  }
}

async function sendPromptToService(
  service: AIService,
  prompt: string
): Promise<string> {
  const url = SERVICE_URLS[service]
  const tabs = await chrome.tabs.query({ url: `${url}/*` })
  if (tabs.length === 0) {
    throw new Error(`No tab open for ${service}`)
  }
  const tabId = tabs[0].id
  if (tabId === undefined) {
    throw new Error(`Could not get tab id for ${service}`)
  }

  const requestId = nextRequestId++
  const orchStart = Date.now()
  console.log(
    `[MixerAI/orch] -> sendPromptToService(${service}) tab=${tabId} requestId=${requestId}`
  )

  // Wake the tab once before sending — forces a render, resets Chrome's
  // "intensive throttling" 5-minute idle counter on this tab. We don't
  // activate (no flicker for the user); just inject a tiny script that
  // touches the page, which is enough to keep its JS context warm.
  await pokeTabAwake(tabId, service).catch(() => {})

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let lastProgressAt = Date.now() // diagnostic: any wire activity
    // Hang detection needs a stricter signal: monotonic textLen growth.
    // PROGRESS heartbeats fire on a fixed 10s cadence even when the
    // polling loop is stuck — if we reset on those, the watchdog never
    // trips. Reset only when textLen actually grows.
    let lastRealProgressAt = Date.now()
    let lastObservedTextLen = -1
    let hasForceWokenTab = false

    // Hard timeout handle — cleared on settle so the timer doesn't fire
    // spuriously 7+ minutes after a request that already completed
    // successfully. Previously the timeout lived in a separate
    // Promise.race branch with no cleanup; that branch fired for every
    // request long after settlement, producing confusing
    // "hard-timeout recovery succeeded" log noise. With the cleared
    // handle, the timeout only fires if the request actually hangs.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    // Keep-warm interval: every 25s, inject a no-op script into the AI
    // tab. Chrome's "intensive throttling" pauses background-tab JS
    // execution after 5 minutes of being hidden + idle. Injected scripts
    // count as activity and reset that idle timer. The SW itself runs
    // the setInterval, and SW timers are not subject to background-tab
    // throttling (the SW has its own lifecycle), so this stays reliable
    // even when every visible tab is backgrounded.
    //
    // Without this, Gemini (slowest model, longest in background) was
    // intermittently sitting at "running" for 5+ minutes after actually
    // completing — its polling loop's setTimeout was throttled to ~1/min
    // and the MutationObserver wakeup wasn't firing because the page's
    // DOM mutations were also being deferred by Chrome.
    const keepWarmHandle: ReturnType<typeof setInterval> = setInterval(
      () => {
        if (settled) return
        void pokeTabAwake(tabId, service).catch(() => {
          // ignore — tab may have been closed or navigated away; we'll
          // surface that as a port disconnect via the normal path
        })
      },
      25_000
    )

    // Hang watchdog: if the tab makes no progress for 90 seconds —
    // measured by the last port message received (RESULT or PROGRESS) —
    // we force-activate the tab once. Activation lifts ALL of Chrome's
    // background throttling instantly. User sees the AI tab flash to
    // foreground briefly; almost always the polling loop catches up
    // within a few hundred ms, posts RESULT, and we resolve.
    //
    // We only do this ONCE per request to avoid a thrash loop. If after
    // forced activation the tab still hangs, the PROMPT_TIMEOUT_MS hard
    // timeout below kicks in normally.
    // Hang watchdog — fires force-activate as a TRUE LAST RESORT only.
    //
    // Earlier versions (v1.4.2-v1.4.6) used a 90s threshold here. That
    // was too aggressive: a service taking 90+ seconds for a legitimately
    // long response would have its tab yanked to the foreground, stealing
    // focus from whatever the user was actually doing. Worse, it would
    // fire repeatedly across multiple long steps in one task (Claude
    // reasoning, Gemini Deep Research, ChatGPT thinking models).
    //
    // 4 minutes is a much more reasonable floor for "this is actually
    // hung, not just slow." The vast majority of completions arrive in
    // under 2 minutes; anything taking 4+ minutes is either genuinely
    // stuck OR a truly extended response where the user is happy to
    // wait. The check-button in the side panel (v1.4.7+) gives the user
    // a non-stealing way to peek at the tab if they're curious before
    // the 4-minute mark.
    //
    // Once per request — we don't want a thrash loop. If after one
    // forced activation the tab still hangs, the PROMPT_TIMEOUT_MS
    // hard timeout (~30 minutes, a last-resort cap only) takes over normally.
    const HANG_THRESHOLD_MS = 240_000 // 4 minutes
    const hangWatchdog: ReturnType<typeof setInterval> = setInterval(
      () => {
        if (settled || hasForceWokenTab) return
        // Use lastRealProgressAt (only updated on textLen growth or
        // RESULT), not lastProgressAt (updated on every heartbeat).
        // A loop that's alive but stuck at completion detection still
        // pumps PROGRESS messages every 10s — those shouldn't count
        // as "making progress" for hang-detection purposes.
        const sinceProgress = Date.now() - lastRealProgressAt
        if (sinceProgress >= HANG_THRESHOLD_MS) {
          hasForceWokenTab = true
          console.log(
            `[MixerAI/orch] ${service} no real progress for ${Math.round(sinceProgress / 1000)}s — force-activating tab to break throttle`
          )
          void chrome.tabs
            .update(tabId, { active: true })
            .catch((e) =>
              console.log(
                `[MixerAI/orch] force-activate failed for ${service}: ${e instanceof Error ? e.message : String(e)}`
              )
            )
        }
      },
      15_000
    )

    const stopTimers = () => {
      clearInterval(keepWarmHandle)
      clearInterval(hangWatchdog)
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    }

    const settleOk = (text: string) => {
      if (settled) return
      settled = true
      stopTimers()
      console.log(
        `[MixerAI/orch] <- ${service} RESULT.ok requestId=${requestId} textLen=${text.length} elapsed=${Math.round((Date.now() - orchStart) / 1000)}s${hasForceWokenTab ? " (after force-activate)" : ""}`
      )
      try {
        port?.disconnect()
      } catch {}
      resolve(text)
    }
    const settleErr = (err: Error) => {
      if (settled) return
      settled = true
      stopTimers()
      console.log(
        `[MixerAI/orch] <- ${service} ERROR requestId=${requestId} msg="${err.message}" elapsed=${Math.round((Date.now() - orchStart) / 1000)}s`
      )
      try {
        port?.disconnect()
      } catch {}
      reject(err)
    }

    // Recovery path: when the port disconnects before we got RESULT,
    // try a one-shot GET_CACHED_RESULT. The content script caches every
    // completed result on window.__mixerai.recentResults, surviving any
    // port-channel failure.
    //
    // There's also a separate failure mode this function handles via
    // setupPort()'s retry logic above: when a service's page URL changes
    // after a completed request (Claude /new → /chat/{uuid}, ChatGPT
    // similar), Plasmo unloads and reinjects the content script. There's
    // a ~50-300ms window where the new content script's
    // chrome.runtime.onConnect listener isn't installed yet. Any port
    // connection during that window disconnects immediately with no
    // listener to handle it. The cache is also useless during that
    // window since the new script's cache is empty.
    let hasRetriedPortConnection = false
    const tryRecover = async (disconnectErr: string) => {
      if (settled) return
      const elapsedMs = Date.now() - orchStart
      const isFastDisconnect = elapsedMs < 2_000

      // Fast-disconnect retry: if the port died within 2s of opening,
      // the content script almost certainly wasn't ready (URL-change
      // race after a prior request completed). Wait briefly for it to
      // come back up, then re-open the port. Only retry once per
      // request — if it fails again, fall through to cache lookup +
      // error.
      if (isFastDisconnect && !hasRetriedPortConnection) {
        hasRetriedPortConnection = true
        console.log(
          `[MixerAI/orch] ${service} fast port disconnect (${elapsedMs}ms) — likely URL-change race, retrying connection in 1500ms requestId=${requestId}`
        )
        await new Promise((r) => setTimeout(r, 1500))
        if (settled) return
        const reopened = setupPort()
        if (reopened) {
          console.log(
            `[MixerAI/orch] ${service} port reconnected after URL-change wait requestId=${requestId}`
          )
        }
        return
      }

      console.log(
        `[MixerAI/orch] ${service} port died without RESULT (${disconnectErr}) — attempting cache recovery requestId=${requestId}`
      )
      const cached = await tryFetchCachedResult(tabId, requestId, service)
      if (settled) return
      if (cached !== null) {
        if ("text" in cached) {
          settleOk(cached.text)
        } else {
          settleErr(new Error(`${service}: ${cached.error}`))
        }
        return
      }
      settleErr(new Error(`${service}: port disconnected (${disconnectErr})`))
    }

    // Helper: open the port, wire up listeners, post SEND_PROMPT.
    // Returns the port on success, null on failure (caller decides
    // whether to retry or settleErr). This is factored out so the
    // fast-disconnect retry path above can reuse the same setup.
    let port: chrome.runtime.Port | null = null
    const setupPort = (): chrome.runtime.Port | null => {
      try {
        port = chrome.tabs.connect(tabId, { name: "mixerai-send-prompt" })
      } catch (e) {
        settleErr(
          new Error(
            `${service}: could not connect to content script (${e instanceof Error ? e.message : String(e)})`
          )
        )
        return null
      }

      port.onMessage.addListener((msg: AdapterResponse & { type?: string; requestId?: number; textLen?: number }) => {
        // Any message from the content script counts as wire activity.
        // Refreshes lastProgressAt for diagnostic purposes only.
        lastProgressAt = Date.now()

        if (msg?.type === "PROGRESS") {
          // PROGRESS heartbeats fire on a fixed 10s cadence regardless
          // of whether the polling loop is actually making forward
          // progress on detecting completion. So we DON'T reset the
          // hang-detection clock on a bare heartbeat. We reset it
          // only when the reported textLen grew — meaningful forward
          // progress, not just "the loop is still ticking."
          const tl =
            typeof msg.textLen === "number" && Number.isFinite(msg.textLen)
              ? msg.textLen
              : -1
          if (tl > lastObservedTextLen) {
            lastObservedTextLen = tl
            lastRealProgressAt = Date.now()
          }
          return
        }
        // RESULT messages — also count as real progress.
        lastRealProgressAt = Date.now()
        if (msg?.type !== "RESULT") return
        // Reject mismatched IDs — defends against stale cached deliveries.
        if (typeof msg.requestId === "number" && msg.requestId !== requestId) {
          console.log(
            `[MixerAI/orch] ${service} ignoring stale RESULT (got requestId=${msg.requestId}, expected ${requestId})`
          )
          return
        }
        if (msg.ok) settleOk(msg.text ?? "")
        else settleErr(new Error(`${service}: ${msg.error ?? "unknown error"}`))
      })

      port.onDisconnect.addListener(() => {
        const lastErr = chrome.runtime.lastError?.message
        // Don't reject immediately — try to recover the result from the
        // content script's cache OR retry the connection if it died
        // suspiciously fast.
        void tryRecover(lastErr ?? "port disconnected before response")
      })

      try {
        port.postMessage({ type: "SEND_PROMPT", prompt, requestId })
      } catch (e) {
        settleErr(
          new Error(
            `${service}: failed to post prompt to content script (${
              e instanceof Error ? e.message : String(e)
            })`
          )
        )
        return null
      }
      return port
    }

    // Initial connection attempt.
    setupPort()

    // Hard timeout — surfaces a real, visible error in the side panel
    // rather than a silent hang. On fire: one last cache lookup in case
    // the content script completed but couldn't deliver. Cleared via
    // clearTimeout the moment settleOk or settleErr fires for any other
    // reason — so this only runs on a genuine hang.
    timeoutHandle = setTimeout(async () => {
      if (settled) return // belt-and-suspenders; clearTimeout already covers
      const cached = await tryFetchCachedResult(tabId, requestId, service)
      if (settled) return
      if (cached !== null && "text" in cached) {
        console.log(
          `[MixerAI/orch] ${service} hard-timeout recovery succeeded requestId=${requestId}`
        )
        settleOk(cached.text)
        return
      }
      settleErr(
        new Error(`${service}: timed out after ${PROMPT_TIMEOUT_MS}ms`)
      )
    }, PROMPT_TIMEOUT_MS)
  })
}

/** Make sure a tab exists for each service. Open missing ones in the background. */
async function ensureTabsExist(services: AIService[]) {
  for (const service of services) {
    const url = SERVICE_URLS[service]
    const existing = await chrome.tabs.query({ url: `${url}/*` })
    if (existing.length === 0) {
      const tab = await chrome.tabs.create({ url, active: false })
      await waitForContentScript(tab.id!)
    }
  }
}

/**
 * Inject a tiny script into a background tab to keep its JS context warm.
 *
 * Why this exists: Chrome aggressively throttles backgrounded tabs.
 * Specifically, "Intensive Throttling" (introduced in Chrome 87) pauses
 * setTimeout/setInterval to roughly 1 fire per minute on tabs that have
 * been hidden + idle for 5+ minutes. Our polling loop's `await sleep(500)`
 * effectively becomes `await sleep(60000)` under those conditions, and
 * the entire completion-detection loop misses its windows.
 *
 * The script we inject does three things:
 *
 *   1. Calls performance.now() — touches the timing API, registers as activity
 *   2. Calls requestAnimationFrame — schedules a paint, registers as visible work
 *   3. Reads document.title — touches the DOM, registers as live execution
 *
 * Each call to chrome.scripting.executeScript counts as "activity" from
 * Chrome's perspective and resets the 5-minute idle counter. Combined
 * with calling this every 25 seconds, the tab never accumulates 5
 * minutes of idle time and therefore never enters intensive throttling.
 *
 * Crucially: the SW that runs the setInterval is NOT subject to
 * background-tab throttling (it has its own MV3 lifecycle). The SW
 * stays alive via the existing alarms + setInterval keepalive from
 * v1.3.4. So this whole mechanism keeps working even when every tab
 * the user has open is in the background.
 */
async function pokeTabAwake(tabId: number, service: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // World "MAIN" runs in the page's own JS context. We don't need
      // any page-side data here — we just need to be SEEN running by
      // Chrome's scheduler. ISOLATED would work too but MAIN is closer
      // to "real page activity" from the scheduler's perspective.
      world: "MAIN",
      func: () => {
        // Three lightweight activity signals, each touching a
        // different Chrome subsystem so the scheduler can't class
        // this as a no-op the way it might class an empty function.
        performance.now()
        requestAnimationFrame(() => {})
        void document.title
      }
    })
  } catch (e) {
    // Silently swallow — tab may have been closed, navigated away, or
    // the page may be in a state where script injection is blocked.
    // The hang watchdog above is the safety net for any of those.
    console.log(
      `[MixerAI/orch] pokeTabAwake(${service}) failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/** Ping the tab's content script until it answers, or give up. */
async function waitForContentScript(tabId: number, timeoutMs = 15_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "CHECK_AUTH"
      })
      if (response) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

// ============================================================================
// Prompt builders
// ============================================================================
//
// Design philosophy
// -----------------
//
// Every prompt has THREE layers:
//
//   1. STAKES BACKBONE — shared across all prompts. Tells the model this is
//      high-stakes work, that it's competing with other AIs in parallel, and
//      that hedging / half-effort is failure. This is the "screaming at it"
//      layer the user specifically asked for. It's emphatic without being
//      parody — repeated commitments to rigor, not literal all-caps yelling.
//
//   2. TASK-AWARE VARIANT — concrete per-task-type checklist of what good
//      work looks like for THIS kind of question. A coding task gets a
//      tracing / edge-case / complexity checklist; a math task gets a
//      verification / induction / boundary checklist; a writing task gets
//      voice / specificity / no-corporate-hedging instructions. Without
//      this layer, every task gets a generic prompt — which is fine but
//      leaves measurable quality on the table.
//
//   3. HARD RULES — output format, no preamble, no AI self-reference, etc.
//      These haven't changed; they were already good.
//
// The variant key is picked from the planner's free-form task_type label
// via substring matching. The planner can return anything (algorithm,
// debugging, refactor, proof, creative, brainstorm…), so we map liberally
// to one of 8 buckets and fall through to "default" if nothing matches.

type TaskVariantKey =
  | "code"
  | "math"
  | "writing"
  | "research"
  | "explanation"
  | "comparison"
  | "brainstorm"
  | "default"

function taskVariantKey(taskType: string): TaskVariantKey {
  const t = (taskType || "").toLowerCase()
  if (/code|coding|debug|refactor|algorithm|programm|function|script/.test(t)) return "code"
  if (/math|proof|prove|theorem|equation/.test(t)) return "math"
  if (/writ|creative|story|essay|poem|article|blog|content|copy/.test(t)) return "writing"
  if (/research|current|news|recent|fact-check|factual|investigat|summari|search/.test(t)) return "research"
  if (/explan|tutorial|definition|teach|learn|how does|understand/.test(t)) return "explanation"
  if (/compar|recomm|evaluat|choos|pick|select|versus|vs|review|analy|breakdown|critique|critic|decision|decide/.test(t)) return "comparison"
  if (/brainstorm|idea|ideation|generat/.test(t)) return "brainstorm"
  return "default"
}

// ---------------------------------------------------------------------------
// Proposer task-aware checklists
// ---------------------------------------------------------------------------

const PROPOSER_VARIANTS: Record<TaskVariantKey, string> = {
  code: `THIS IS A CODING TASK. Non-negotiables:

1. Write WORKING code, not pseudocode (unless explicitly asked).
2. Before finalizing, TRACE your code on a small concrete input mentally. Catch off-by-one errors, null/empty handling, infinite loops.
3. Then trace ONE edge case: empty input, single element, max size, negative numbers, duplicates. Whichever applies.
4. State time and space complexity at the end.
5. State assumptions about the input or environment if any matter.
6. If the user asked for tests, write them. If not, include at least one example call showing the function in use.
7. Use idiomatic style for the language. Match modern conventions.
8. Comments where they add value, not where they restate code.

Wrong code reaches the user only if you ship it. Don't ship wrong code.`,

  math: `THIS IS A MATH OR PROOF TASK. Non-negotiables:

1. Prove every step. Skipped "obvious" transitions are where errors hide.
2. Verify your final answer with a CONCRETE numeric example (n=3, n=4, k=1, etc.). Show the verification.
3. Check index boundaries — off-by-one errors are the #1 cause of wrong proofs.
4. If you used induction, verify the base case explicitly. Don't say "base case trivial" — show it.
5. Define every variable before it appears in an equation. State assumptions before using them.
6. If you invoked a named theorem, name it.
7. The final claim must be UNAMBIGUOUS. A reader shouldn't have to guess what you proved.

A wrong proof that looks right is worse than a missing proof. Self-check before shipping.`,

  writing: `THIS IS A WRITING TASK. Non-negotiables:

1. Voice matters. Match the audience, register, and intent of the request.
2. Specific concrete details ALWAYS beat general ones. Real examples beat abstract claims.
3. Cut every word that isn't earning its place. Verbosity is laziness in disguise.
4. NO corporate hedging ("It's important to note that…"). NO filler openers ("In today's fast-paced world…"). NO empty transitions ("Furthermore," "Moreover,").
5. Read your draft back mentally before shipping. Fix anything that sounds like a robot wrote it.
6. Lead with the strongest line. End with weight, not whimper.
7. Match the requested length and format exactly. If they said 300 words, count.

Generic safe writing is the failure mode. Be specific and committed.`,

  research: `THIS IS A RESEARCH OR FACT-FINDING TASK. Non-negotiables:

1. USE WEB SEARCH. This is not optional. Your training data is stale on anything time-sensitive.
2. Cite the source for every non-obvious claim (number, date, name, quote).
3. Distinguish confirmed facts from reported claims from speculation. Use the language precisely.
4. If sources disagree, say so explicitly. Do NOT average them. Pick the most credible and say why.
5. Prefer recent sources (last 6 months) for time-sensitive topics.
6. If you cannot find a credible source for something, say so. Do not invent.
7. Hallucinated facts are unacceptable. Verification is the entire point of this task.

If you didn't search the web at least once, you didn't do this task.`,

  explanation: `THIS IS AN EXPLANATION OR TUTORIAL TASK. Non-negotiables:

1. Match the user's apparent expertise level. Don't condescend; don't lose them.
2. Start from a CONCRETE example. Theory follows. Not the other way around.
3. Define jargon the first time you use it. Then assume it's understood.
4. Include at least one worked example: "Here's how this plays out in practice."
5. Where relevant, name the common wrong intuition AND why it's wrong. Misconceptions are the most valuable thing to address.
6. End with the single most important takeaway in one line.
7. Length matches complexity, not enthusiasm. Don't pad.

A confused reader is a failed explanation, regardless of how technically correct you were.`,

  comparison: `THIS IS A COMPARISON OR RECOMMENDATION TASK. Non-negotiables:

1. Define the criteria you're comparing on FIRST. Don't list features randomly.
2. For each criterion, state which option wins and WHY in one line.
3. Identify the genuine tradeoffs — what each option SACRIFICES to be good at what it's good at.
4. If the user asked for a recommendation, COMMIT to one. Don't hedge with "depends on your needs" unless you enumerate which needs lead to which choice.
5. Identify the "wrong answer" — the option that would be a mistake for most users in this context.
6. Note anything the user didn't ask about that matters anyway (pricing, vendor lock-in, ecosystem, longevity).
7. End with a one-sentence verdict.

Wishy-washy comparisons are useless. Pick a side and defend it.`,

  brainstorm: `THIS IS A BRAINSTORM OR IDEATION TASK. Non-negotiables:

1. Quantity AND quality. If they asked for N ideas, give N DISTINCT ones — not M good ones and (N-M) fillers.
2. Range matters. Cover the safe / conventional ideas AND the weirder ones at the edges.
3. Each idea: name + one-line description + one-line "why it could work" (specific mechanism, not vague optimism).
4. Drop duplicates and obvious ones. Don't pad to hit a count.
5. The non-obvious ideas are where the value is. Surface them deliberately.
6. Avoid generic startup-speak. "AI-powered platform for X" is not an idea — it's a sentence template.

A list of safe ideas is worse than fewer bold ones.`,

  default: `THIS TASK DOESN'T FIT A STANDARD CATEGORY — coding, math, research, etc. That's fine. Many of the most important tasks are open-ended human ones: advice, decisions, planning, opinions, conversation, creative play, emotional topics, life questions, mixed-domain work.

For tasks like these, the failure modes are different. Watch out for:

1. IDENTIFY WHAT KIND OF HELP THE USER ACTUALLY WANTS. Read carefully:
   - Are they asking for a DECISION? Give one, with reasoning. Don't list pros and cons forever.
   - Are they asking to THINK THROUGH something? Lay out the considerations clearly, then suggest a direction.
   - Are they asking for EMPATHY or support? Lead with that. Don't jump to advice.
   - Are they asking for CREATIVE help? Be playful, be specific, bring real voice — not corporate-AI-helpful.
   - Are they asking for PRACTICAL steps? Give actual concrete steps, not abstract principles.
   - Are they asking your OPINION? Give it, explicitly.

2. MATCH THE REGISTER the user used. Casual question → casual answer. Heavy or vulnerable question → take it seriously, slow down, don't be flippant.

3. AVOID the failure modes that make AI answers feel hollow:
   - Bullet-point cascades when prose would serve better.
   - Restating the question before answering it ("Great question! You're asking…").
   - Generic principles when the user wanted specifics.
   - Over-cautious hedging when the user wanted a real opinion.
   - Refusing to commit when the user explicitly asked for your view.
   - "It depends" without saying ON WHAT it depends.

4. If the task is genuinely open-ended (e.g., "what should I do with my life"), don't pretend it has one right answer. Help the user think. Give your honest take when asked. Respect that they own the decision.

5. If the task involves MULTIPLE kinds of work (e.g., "research this then write a poem about it"), handle each part with the care it deserves. Don't shortchange one half.

The world is bigger than the tasks any checklist can cover. Use judgment. Be specific. Don't be generic.`
}

// ---------------------------------------------------------------------------
// Aggregator task-aware verification step
// ---------------------------------------------------------------------------

const AGGREGATOR_VARIANTS: Record<TaskVariantKey, string> = {
  code: `Since this is a coding task, ALSO do this before shipping:
- Mentally COMPILE the final code. Step through one input. Check for syntax errors, off-by-one bugs, null handling.
- Verify the stated complexity matches the actual code.
- If the drafts disagreed on approach, pick the one that handles edge cases better, not the one that's shortest.`,

  math: `Since this is a math/proof task, ALSO do this before shipping:
- VERIFY the final answer with a concrete numeric example (n=3, n=4, etc.).
- Check the base case explicitly if induction is used.
- Check every index boundary. Off-by-one is the most common error class here.
- If drafts disagreed on a numerical answer, recompute from scratch.`,

  writing: `Since this is a writing task, ALSO do this before shipping:
- Cut every word that isn't earning its place. Aggregated drafts tend to bloat.
- Read your final version mentally. Fix anything that sounds AI-generated.
- Pick ONE voice and hold it throughout. Different drafts will have used different registers; harmonize.`,

  research: `Since this is a research task, ALSO do this before shipping:
- Use web search to VERIFY any specific claim (date, number, name, quote) that any draft made.
- If drafts disagreed on a fact, look it up. Do not average.
- Cite sources for non-obvious claims in the final answer.`,

  explanation: `Since this is an explanation task, ALSO do this before shipping:
- Lead with a concrete example, not abstract theory.
- Make sure jargon is defined on first use.
- End with the one-line takeaway.`,

  comparison: `Since this is a comparison/recommendation task, ALSO do this before shipping:
- COMMIT to a verdict. Don't hedge.
- Make the tradeoffs explicit — what each option gives up.`,

  brainstorm: `Since this is a brainstorm, ALSO do this before shipping:
- De-duplicate ideas that drafts shared. Don't count the same idea twice with different words.
- If counts were requested (e.g. "10 ideas"), hit the count EXACTLY with distinct ideas.`,

  default: `Before shipping, regardless of task type:
- RE-READ the user's original task. Verify your final answer actually addresses what they asked, not what's adjacent to it.
- MATCH THE LANGUAGE the user wrote in. Don't translate to English unless asked.
- MATCH THE REGISTER. Casual → casual. Emotional → human, not corporate. Technical → precise.
- CUT every line that's generic or filler. Aggregated drafts bloat by default.
- COMMIT where commitment was asked for. Don't dodge the actual question with "it depends" unless you specify on what.
- If drafts disagreed on something subjective (opinion, advice, recommendation), don't average. Pick what seems right and OWN it.`
}

// ---------------------------------------------------------------------------
// Proposer perspectives (v1.6.0)
// ---------------------------------------------------------------------------
//
// Three distinct angles on the same task. NOT character roleplay (which the
// research literature shows degrades reasoning on coding/math — see Kim et al.
// "Persona is a Double-edged Sword" 2024, and "Expert Personas Improve LLM
// Alignment but Damage Accuracy" 2026: coding -0.65, math -0.10 with persona
// prefixes).
//
// Instead these are FOCUS DIRECTIVES — telling the model what to optimize for
// while solving the SAME task. All three proposers still produce a real, full
// answer to the user's question. They just emphasize different aspects, which
// gives the aggregator real disagreement to weigh (MoA "collaborativeness"
// property, Wang et al ICLR 2025: diverse drafts measurably improve synthesis,
// especially when the proposers are all top-tier — which we are).
//
// Order matters. If the planner chose only 2 proposers, we use indices 0 and
// 1 (PRIMARY + STRESS_TEST), skipping DEPTH. Index 0 alone is the simple-
// strategy fast path and gets no perspective appended (the user is in a
// hurry; don't slow it down).
const PROPOSER_PERSPECTIVES: string[] = [
  // Index 0 — PRIMARY
  `YOUR SPECIFIC ANGLE FOR THIS DRAFT: PRIMARY ANSWER.

Bring your strongest, most direct, most committed take. The clean canonical answer that a careful expert would produce on first careful pass. Trust your judgment after thinking properly. Don't second-guess yourself. Don't hedge.

Solve the task in full. Don't shorten because you think other AIs will fill gaps — assume the user might only see YOUR draft. Be complete.`,

  // Index 1 — STRESS-TEST
  `YOUR SPECIFIC ANGLE FOR THIS DRAFT: STRESS-TEST / ADVERSARIAL CARE.

Solve this task in full, but solve it like someone who has been BURNED by overlooked edge cases, hidden constraints, and unexamined assumptions. Your distinctive contribution is catching what the obvious answer misses.

Before finalizing, ask yourself: What edge case is being skipped? What constraint is unstated but matters? What assumption is being made without checking? What input would break the obvious solution? What number would make this wrong? What context would flip the recommendation?

Then write your full answer with that caution baked in. Don't write a meta-commentary about edge cases — INCORPORATE the caution into the answer itself. If the task has one true answer, give that answer but verify it under stress. If the task is open-ended, give the answer most resilient to obvious objections.`,

  // Index 2 — DEPTH
  `YOUR SPECIFIC ANGLE FOR THIS DRAFT: DEPTH / ALTERNATIVE FRAMING.

Solve this task in full, but solve it the way someone who spent HOURS on it would solve it — not the first thing that comes to mind. Your distinctive contribution is the angle that emerges only after deeper consideration.

Before finalizing, ask: Is there an alternative approach, framing, data structure, formulation, lens, or precedent that the obvious approach misses? Would an expert in an adjacent domain solve this differently? What would the answer look like if you optimized for a different success criterion than the obvious one?

If an alternative IS better, use it. If the obvious approach IS best, use it but explain briefly why it beats the alternative you considered. Either way, the final answer should reflect deliberation, not just first instinct.`
]

/**
 * Prompt sent to every proposer.
 *
 * Four-layer structure: stakes backbone → universal rules → task-aware variant
 * → proposer-specific perspective → user task.
 *
 * MoA grounding (Wang et al, ICLR 2025):
 *  - Proposers work INDEPENDENTLY. They don't see each other's outputs.
 *  - "Collaborativeness" means diverse drafts — even lower-quality ones —
 *    improve aggregator output. So we tell the proposer to commit to ITS
 *    strongest take, not anticipate consensus. Hedging dilutes diversity.
 *  - We mention the draft will be merged so the proposer doesn't waste
 *    effort writing meta-commentary.
 *
 * v1.6.0 addition: proposer-specific perspective (PRIMARY / STRESS-TEST /
 * DEPTH) layered on top. Forces real divergence between proposers, giving
 * the aggregator actual disagreements to weigh. NOT character roleplay —
 * see PROPOSER_PERSPECTIVES comment above for the research basis.
 */
export function buildProposerPrompt(
  userPrompt: string,
  plan: TaskPlan,
  proposerIndex: number = 0
): string {
  const variant = PROPOSER_VARIANTS[taskVariantKey(plan.task_type)]

  // Append the perspective only when running multi-proposer MoA. For the
  // simple/single-service fast-path we keep the prompt clean to avoid
  // adding load on a path the user explicitly opted into for speed.
  const isMultiProposer = plan.proposers.length > 1
  const perspective =
    isMultiProposer && proposerIndex < PROPOSER_PERSPECTIVES.length
      ? `\n${PROPOSER_PERSPECTIVES[proposerIndex]}\n`
      : ""

  return `THIS IS NOT A CASUAL QUESTION. Treat this as a high-stakes task.

WHY: Other AIs are drafting the same task right now, in parallel, independently from you. The final answer the user sees will be SYNTHESIZED from your draft and theirs. Your job is to bring YOUR strongest, most committed take — not to anticipate consensus, not to play it safe, not to hedge.

UNIVERSAL RULES — apply to every task, no matter what:

1. READ THE TASK TWICE before answering. Don't skim. The first read finds what's asked; the second finds what's IMPLIED but not stated (the constraints, context, the real question behind the question).

2. IDENTIFY THE USER'S ACTUAL GOAL — what would a successful answer DO for them, not just say? An answer that says correct words but misses the real goal has failed.

3. MATCH THE USER'S LANGUAGE. If the task is written in Spanish, answer in Spanish. French, French. Mandarin, Mandarin. Same script, same register. Don't translate to English unless the task is asking for a translation.

4. MATCH THE USER'S REGISTER. Casual question → casual answer. Technical user → precise answer. Emotional or heavy question → take it seriously; slow down.

5. SPEED IS IRRELEVANT. Correctness is everything. Half-effort fails. There is no partial credit. There is no "good enough."

6. USE WEB SEARCH whenever ANY part is uncertain or time-sensitive. Your training data is stale on anything recent — prices, news, releases, current officeholders, sports results, anything dated.

7. BE SPECIFIC. Generic answers are worse than no answer. Concrete examples beat abstract claims every time.

8. COMMIT TO POSITIONS. Hedging is laziness. If you genuinely cannot decide between options, say so explicitly with reasoning — don't bury indecision in soft language ("it depends on your needs" without saying ON WHAT it depends).

9. IF A STEP FEELS OBVIOUS, write it anyway. Obvious steps hide errors.

10. VERIFY BEFORE YOU SHIP. Read your own draft once. Find what's wrong, fix it.

11. IF SOMETHING IS IMPOSSIBLE, AMBIGUOUS, OR UNKNOWN, say so. Don't fake confidence. Don't hallucinate to look helpful. Naming a gap is more useful than filling it with fiction.

12. LENGTH MATCHES WHAT'S ACTUALLY NEEDED. Don't pad. Don't truncate. Match the apparent scope of the request.

${variant}
${perspective}
EXPECTED OUTPUT SHAPE: ${plan.output_format}

Now the task below. Read it carefully. Do not skim. Answer it FULLY.

---

${userPrompt}`
}

/**
 * Aggregator synthesis prompt.
 *
 * Design notes (grounded in MoA research):
 *  - The aggregator does NOT pick one proposer. The MoA paper specifically
 *    shows aggregators outperform LLM-rankers — they re-derive and re-compose.
 *  - We force an AUDIT first (internal Part 1) before writing the final
 *    answer (visible Part 2). Structured self-critique applied before output.
 *  - We explicitly tell it to handle disagreements by reasoning, not by
 *    averaging. Averaging dilutes correct answers when one draft is wrong.
 *  - We strip every signal of "this is a synthesis" from the output —
 *    the user sees a single clean answer, not meta-commentary.
 *  - When `willBeCritiqued` is true, the aggregator is told to commit to a
 *    sharp draft. Knowing a reviewer is coming should NOT lead to hedging.
 *  - Task-aware verification step added per task type.
 */
export function buildAggregatorPrompt(
  userPrompt: string,
  proposerResults: ProposerResult[],
  plan: TaskPlan,
  willBeCritiqued: boolean = false
): string {
  const variant = AGGREGATOR_VARIANTS[taskVariantKey(plan.task_type)]
  const variantBlock = variant
    ? `\n${variant}\n`
    : ""

  const responses = proposerResults
    .map(
      (r, i) =>
        `--- Draft ${i + 1} (from ${r.service}) ---\n${r.text.trim()}`
    )
    .join("\n\n")

  const criticNote = willBeCritiqued
    ? `

NOTE: A separate model (different from any of the drafters above) will review your output as a quality-check pass before it reaches the user. Write a sharp, committed draft — do NOT hedge to please the reviewer. The reviewer's job is to catch real errors, not to enforce blandness. Hedging now just creates more work for them and for you.`
    : ""

  return `THIS IS A SYNTHESIS TASK. You are the final author. The user will see only your output.

The user asked:

"""
${userPrompt}
"""

Task classification: ${plan.task_type} (${plan.difficulty} difficulty)
Required output format: ${plan.output_format}

${proposerResults.length} AI models independently attempted this task. Their drafts are below. Read them carefully — but you are NOT picking one. You are RE-DERIVING the best answer using them as evidence.

${responses}

---

PART 1 — INTERNAL AUDIT (think silently; this is NOT the output the user sees):

Do this reasoning silently, in your head — not in writing the user will see. You may use a brief scratchpad if your interface supports hidden thinking, but the audit must NOT appear in the visible response.

  a) For each draft, identify the strongest unique contribution it makes — a fact, a step, a perspective, a piece of reasoning the others missed.

  b) List EVERY point where the drafts DISAGREE — on a fact, a number, a logical step, a recommendation, a tradeoff. For each disagreement, work out which side is correct using first-principles reasoning.

     DO NOT AVERAGE DISAGREEMENTS.
     DO NOT SPLIT THE DIFFERENCE.
     DO NOT WRITE "some say X, others say Y."
     Pick the right answer and commit. If you're genuinely unsure, that's a signal you need to think harder, not present both sides.

  c) Identify any claim that ALL drafts make but might still be wrong. The collaborativeness property of MoA means models can all be confidently wrong together. Question shared claims.

  d) Identify anything the user actually needs that NONE of the drafts addressed. Plan to add it.

  e) Note any draft that is clearly weaker overall — discount it. Mixing perspectives helps; a confidently-wrong draft pulling synthesis off course does NOT help.
${variantBlock}
PART 2 — WRITE THE FINAL ANSWER (this IS what the user sees, and the ONLY thing you should output):

Re-derive the answer from scratch using your audit. Use the drafts as evidence and inspiration — NOT as base text to remix. The result must read as a single coherent answer by one author.

HARD RULES (all must be followed):

1. Format exactly as: ${plan.output_format}

2. Address the user directly. Do NOT narrate the synthesis. No "After analyzing…", "Combining the drafts…", "Here's the synthesis…".

3. Never refer to "the drafts", "the models", "Draft 1", "ChatGPT", "Claude", "Gemini", or any AI by name. The user sees ONE answer from ONE author.

4. Where drafts disagreed, commit to the correct side. Do not hedge or present multiple options unless the user explicitly asked for options.

5. NO preamble. NO "Here's the answer:". NO "Great question!". NO meta-commentary at the start or end. Start directly with the answer.

6. NO process or status text. Do NOT write status lines like "Architecting solution..." / "Analyzing the task..." / "Drafting now..." / "Thinking about X..." / "Synthesizing..." — these belong to scratchpad, never to the user-visible output. If your interface tends to produce such status text, suppress it.

7. Match the user's apparent expertise and tone. Casual user → casual answer. Technical user → precise answer.

8. Before sending, re-read the user's original task and verify your answer actually answers what they asked. If it drifts, fix it.${criticNote}

Begin the final answer now. The next characters you write should be the first characters of the answer the user will see — no preamble, no status, no headers like "Final Answer:".`
}

// ---------------------------------------------------------------------------
// Critic task-specific failure-mode hunting (v1.6.0)
// ---------------------------------------------------------------------------
//
// The generic 7-category audit checklist (factual / logical / math-code /
// missing / calibration / format / what-is-right) is task-agnostic. That's
// fine but loses precision. Each task type has its own characteristic
// failure modes that a specialist reviewer would catch faster than a
// generalist. These appendices tell the critic exactly what kinds of
// mistakes are most worth hunting for in THIS specific task type.
//
// Design constraint: never replace the universal 7-category audit. ALWAYS
// add task-specific hunting on top. The categories are still useful — we
// just give the critic specialist domain knowledge as well.
const CRITIC_VARIANTS: Record<TaskVariantKey, string> = {
  code: `BECAUSE THIS IS A CODING TASK, also hunt these specific failure modes:

- TRACE the code on the edge case the draft skipped: empty input, single element, max size, duplicates, negatives, zero, off-by-one boundary. If the draft didn't trace ANY edge case, that itself is a flag.
- COUNT the operations yourself and verify the stated complexity (O(n), O(n log n), etc.). Drafters often state O(n) for code that's actually O(n²).
- Check every loop bound for off-by-one. Verify range endpoints, array indices, and termination conditions.
- Check for null/undefined/empty handling on every input.
- If the draft claims "optimal," verify the lower bound. If it claims "idiomatic," verify against modern language conventions.
- Check that example calls actually work as stated. If the draft provided test output, recompute it.
- Verify no use of variables before assignment, no unintended mutation of inputs.`,

  math: `BECAUSE THIS IS A MATH OR PROOF TASK, also hunt these specific failure modes:

- RECOMPUTE every key equality, inequality, or simplification yourself with concrete numbers. Drafts often skip "obvious" algebra that hides errors.
- VERIFY the base case explicitly if induction is used. "Trivial" base cases are where errors hide.
- Check whether the inductive hypothesis is actually USED correctly in the inductive step. Sometimes drafts state the IH but don't actually depend on it.
- Watch quantifier scope. "For all x, exists y" vs "exists y, for all x" is a real error class.
- Check every "WLOG" — is it actually without loss of generality, or is the drafter ducking a case?
- Verify the final claim matches what was asked. Drafts sometimes prove a related but different statement.
- If a named theorem is cited, check that its hypotheses actually hold here.`,

  research: `BECAUSE THIS IS A RESEARCH OR FACT-FINDING TASK, also hunt these specific failure modes:

- If the draft made any verifiable claim (date, name, number, quote, location, event), USE WEB SEARCH to verify it. Don't pass uncited facts.
- Distinguish "X said Y" from "Y is true." The draft may have correctly cited a source that itself was wrong.
- Spot every undated claim. Recent events need recency. "Recently announced" with no date is a flag.
- If the draft listed sources, check that they actually exist and say what's attributed to them.
- Watch for outdated info: officeholders, prices, versions, CEOs, model names, regulations. These change.
- If multiple drafts disagreed on a fact, the draft picked one. Check it picked the right one.`,

  writing: `BECAUSE THIS IS A WRITING TASK, also hunt these specific failure modes:

- Mark every cliche ("in today's fast-paced world," "the importance of cannot be overstated," "it's a delicate balance").
- Mark every empty transition ("furthermore," "moreover," "in conclusion") that adds no information.
- Mark every line that sounds like AI wrote it — corporate-helpful, balanced-to-the-point-of-saying-nothing, hedging on what should be confident.
- Verify the requested length and format are matched (word count, section count, format).
- Find anything generic where specific was possible — placeholder language standing in for real content.
- Check voice consistency — does it hold one register throughout, or drift?
- Check the opening and the closing — strong writing earns its first line and ends with weight.`,

  explanation: `BECAUSE THIS IS AN EXPLANATION OR TUTORIAL TASK, also hunt these specific failure modes:

- Find every jargon term used before it's defined. The reader will get lost there.
- Check if there's at least one CONCRETE worked example. Pure theory without grounding is the most common failure mode for explanations.
- Check if the explanation matches the user's apparent expertise — read clues in the original task. Don't condescend; don't lose them.
- Check whether common WRONG intuitions are addressed. The most valuable explanations name what people usually get wrong.
- Verify the takeaway is explicit at the end. If the user has to extract the point themselves, the explanation failed.
- Look for "and that's it" passages where the draft handwaved over the actually-hard part.`,

  comparison: `BECAUSE THIS IS A COMPARISON OR RECOMMENDATION TASK, also hunt these specific failure modes:

- IDENTIFY any criterion the draft secretly avoided. If A is being recommended over B, what's B genuinely better at? If the draft never says, that's a flag.
- Find the missing "wrong answer for which user." Real recommendations name who SHOULDN'T pick the recommended option.
- Spot every tradeoff that was hidden or glossed over with weasel phrasing.
- Check whether the verdict actually follows from the analysis given. Sometimes the body says "A wins on these 3 criteria" but the verdict picks B.
- If the user asked for a recommendation, did the draft commit? "It depends on your needs" without specifying ON WHAT it depends is a failure.
- Check that important non-asked-about factors (pricing, vendor lock-in, ecosystem, longevity) were considered if they apply.`,

  brainstorm: `BECAUSE THIS IS A BRAINSTORM OR IDEATION TASK, also hunt these specific failure modes:

- Find duplicates phrased differently. Two ideas that have the same mechanism are one idea, not two.
- Find ideas that are sentence templates rather than real ideas ("AI-powered platform for X" with no actual mechanism).
- Check the requested count. If they asked for 10, are there 10 DISTINCT ones?
- Check the range — do the ideas span safe-conventional to weird-edge, or do they cluster in the safe zone?
- Find ideas that pad the count without earning their slot.
- Each idea should have a SPECIFIC mechanism for why it could work, not vague optimism ("could be huge!").`,

  default: `BECAUSE THIS TASK IS OPEN-ENDED, also hunt these specific failure modes:

- Did the draft IDENTIFY what kind of help the user wanted (decision, thinking-through, empathy, opinion, practical steps)? Or did it default to a generic information-dump?
- Did the draft MATCH THE REGISTER the user used? A casual question got a formal essay back is a failure. An emotional/vulnerable question got a bullet-point listicle back is a failure.
- Did the draft COMMIT when asked? "It depends" without saying on what is dodging.
- Did the draft answer the ACTUAL question or a nearby easier one? Re-read the user's task. Does the answer address it head-on?
- Look for over-cautious hedging when the user asked for a real opinion.
- Look for AI-flavor failure modes: restating the question before answering, bullet-point cascades when prose would serve, generic principles when specifics were wanted.`
}

/**
 * Critic prompt — independent adversarial audit, Pro+ only.
 *
 * Grounded in Chain-of-Verification (Dhuliawala et al., Meta AI 2023):
 *  - The critic is a DIFFERENT model than the aggregator. Same-model
 *    self-critique tends to confirm the same hallucinations.
 *  - The critic sees ONLY the original task + the aggregator's draft. It
 *    does NOT see the proposer outputs. CoVe independence principle — if
 *    the verifier shares the drafter's generation context, it copies the
 *    same mistakes instead of catching them.
 *  - The critic does NOT rewrite. Produces a structured audit. The
 *    aggregator decides which audit points to act on.
 *
 * Framing change in v1.2.0: this prompt is now adversarial, not polite.
 * Politeness was leaving real errors in production. The critic's job is to
 * stop wrong answers from reaching the user — not to make the drafter
 * feel good.
 *
 * v1.6.0: task-specialized failure-mode hunting added on top of the
 * universal 7-category audit. A specialist catches more real errors than a
 * generalist. See CRITIC_VARIANTS for the per-task-type hunting lists.
 */
export function buildCriticPrompt(
  userPrompt: string,
  draftText: string,
  plan: TaskPlan
): string {
  const variant = CRITIC_VARIANTS[taskVariantKey(plan.task_type)]
  const focusBlock = plan.critic_focus && plan.critic_focus.trim()
    ? `

ADDITIONAL TASK-SPECIFIC FOCUS (from the planner, hunt these explicitly): ${plan.critic_focus.trim()}`
    : ""
  return `YOU ARE A RED-TEAM REVIEWER. Not a friend. Not a coach. Not a polite editor.

Your job: FIND THE ERROR before it reaches the user. Another AI drafted the answer below. Errors in that draft will be shipped to the user unless you catch them now.

This is NOT a politeness exercise. Diplomatic critique that misses real errors is failure. Be specific. Be blunt. Quote the exact line that's wrong and say why.

The user's original task:

"""
${userPrompt}
"""

Task classification: ${plan.task_type} (${plan.difficulty} difficulty)
Required output format: ${plan.output_format}

The draft to audit:

"""
${draftText.trim()}
"""

---

AUDIT THE DRAFT FROM SCRATCH. Do not assume any part of it is correct. Specifically attack:

  1. FACTUAL ERRORS — Any claim, name, date, number, definition, formula, or attribution that might be wrong. For each one you flag, briefly say WHY you doubt it.

  2. LOGICAL GAPS — Steps that are skipped, weakly justified, or that don't follow. Walk through the reasoning. Where does it break?

  3. MATHEMATICAL / CODE ERRORS — For math: recompute the key steps yourself. For code: trace the logic on a small input mentally. For both: check edge cases the draft skipped.

  4. MISSING CONTENT — What does the user clearly need that the draft did not address? Read the original task again. What did the draft skip?

  5. CALIBRATION — Is the draft over-confident on shaky ground? Under-confident on solid ground? Hedging unnecessarily? Inventing certainty?

  6. FORMAT MISMATCH — Required format was: "${plan.output_format}". Does the draft match? If not, where does it deviate?

  7. WHAT IS RIGHT — List 1–3 things the draft genuinely got right. The reviser needs to know what NOT to touch. This is the only "polite" part of your output.

${variant}${focusBlock}

OUTPUT RULES:

- Output the audit as a structured list, one section per category above. Skip categories where you found nothing.
- For each issue: QUOTE the exact line or claim, then say what's wrong. Vague critiques ("could be clearer", "might be improved") are worse than useless.
- If the draft is genuinely solid and you find no real issues, say so in one line. Do NOT invent problems to look thorough — fake problems waste the reviser's time.
- Do NOT rewrite the answer. Do NOT produce a corrected version. Your job is the audit only.

Errors you miss become errors the user sees. Find them.`
}

/**
 * Revision prompt — aggregator revises its draft using the critic's audit.
 *
 * Design notes:
 *  - The aggregator is told the critic may be wrong on some points. Same
 *    independence principle as CoVe in reverse: the reviser shouldn't
 *    blindly accept every audit point. Cross-model critics occasionally
 *    over-fire on style preferences they happen to dislike.
 *  - The reviser makes the FINAL call on which audit points to act on.
 *  - Output rules carry over from the original aggregator prompt.
 */
export function buildRevisionPrompt(
  userPrompt: string,
  draftText: string,
  critique: string,
  plan: TaskPlan
): string {
  return `You wrote a draft. An independent reviewer audited it. Now you revise.

The audit may be excellent or may be partially wrong. Your job is to USE IT — accept real issues, reject over-fires, ship the best final answer.

The user's original task:

"""
${userPrompt}
"""

Required output format: ${plan.output_format}

Your draft:

"""
${draftText.trim()}
"""

The reviewer's audit:

"""
${critique.trim()}
"""

---

YOUR JOB:

1. Read the audit carefully. For each point the reviewer raised, decide whether it is:
     VALID         — real issue, must fix.
     PARTIALLY VALID — kernel of truth, address but not exactly as suggested.
     INVALID       — reviewer is wrong on this point, ignore.

2. The reviewer did NOT see the upstream proposer drafts you used. They may flag things as "missing" that you deliberately excluded for good reason. Trust your judgment — but do not be defensive. Real errors must be fixed regardless of who pointed them out.

3. If the audit said "this is solid, no real issues," your revision should be minor or zero. Don't change things just to look like you revised.

4. Produce the FINAL revised answer. This is what the user sees.

HARD RULES (all must be followed):

1. Format the answer exactly as: ${plan.output_format}

2. Address the user directly. No "After reviewing the feedback…", "Based on the critique…", "I've revised…", or ANY meta-commentary about the revision process.

3. Never refer to "the reviewer", "the critic", "the draft", "the audit", "the models", or any AI by name. The user sees one clean final answer.

4. NO preamble. NO "Here's the revised version:". Start directly with the answer.

5. NO process or status text. Do NOT write status lines like "Reviewing the audit..." / "Revising the answer..." / "Considering the feedback..." — these belong to scratchpad, never to the user-visible output.

6. Match the user's apparent expertise and tone.

7. Before sending, re-read the user's original task and verify your answer actually answers what they asked.

Begin the final revised answer now. The next characters you write should be the first characters of the answer the user will see — no preamble, no status, no headers.`
}
