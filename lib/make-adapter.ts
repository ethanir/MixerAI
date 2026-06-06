import { isElementVisible, sleep, waitFor, waitForStableText } from "./adapter-utils"
import {
  getBackendCaptureSince,
  getCaptureStreamState
} from "./backend-capture-client"

/**
 * Read the current text of a chat composer, ACROSS input flavors.
 *
 * Different services use different composer elements:
 *   - <textarea> / <input>  -> text lives in `.value`
 *   - contenteditable div / ProseMirror / rich-textarea -> text in textContent
 *
 * Reading only textContent (the previous behavior) returned "" for textarea
 * composers (ChatGPT), which silently disabled send-verification
 * for those services. Always route through this helper when checking whether
 * a composer still holds the prompt.
 */
function readComposerText(el: Element | null): string {
  if (!el) return ""
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value ?? ""
  }
  // Some composers nest the editable element; check for a value-bearing child.
  const inner = el.querySelector?.("textarea, input") as
    | HTMLTextAreaElement
    | HTMLInputElement
    | null
  if (inner && typeof inner.value === "string" && inner.value.length > 0) {
    return inner.value
  }
  return el.textContent ?? ""
}

/**
 * Resolve after `ms` milliseconds OR as soon as the given AbortSignal fires —
 * whichever comes first.
 *
 * This is the missing piece for surviving Chrome's background-tab throttling.
 * setTimeout in a backgrounded tab can be throttled to once-per-minute, which
 * means our polling loop's `await sleep(500)` effectively becomes
 * `await sleep(60_000)`. We use this helper together with a MutationObserver
 * (see the sendPrompt polling loop below): when the DOM changes, the observer
 * aborts the current sleep, the loop wakes up, re-checks completion state,
 * and either exits or starts a fresh sleep. MutationObserver callbacks are
 * scheduled as microtasks on DOM mutations and are NOT subject to the same
 * background-tab throttling as setTimeout — so they fire promptly even in a
 * backgrounded tab.
 *
 * Net effect: completion detection in a backgrounded AI tab drops from "up
 * to 60+ seconds late" to "within a few milliseconds of the actual DOM
 * change."
 */
function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export interface AdapterConfig {
  /** Service name used in error messages. */
  service: string
  /** Find the chat input element. Polled until it appears. */
  findInput: () => HTMLElement | null
  /** Type the prompt into the input (handles React quirks per element type). */
  typePrompt: (input: HTMLElement, text: string) => void
  /** Find the send button if it's currently clickable. */
  findSendButton: () => HTMLButtonElement | HTMLElement | null
  /** Count current assistant message elements. Used to detect a new response. */
  countMessages: () => number
  /**
   * Find an element that indicates streaming is in progress (typically the
   * stop-generating button). OPTIONAL — used as a short-circuit if available.
   * The primary "done" signal is text stability, so this only helps detect
   * completion a few seconds faster.
   */
  findStreamIndicator: () => Element | null
  /**
   * Extract the text of the latest assistant message. Called repeatedly
   * during streaming for stability detection — must be FAST and must reflect
   * incremental growth as tokens arrive. Avoid heavy DOM cloning or dedup
   * passes here: any logic that could SHRINK the text mid-stream (e.g. body
   * deduplication catching a duplicated artifact widget) will make text
   * appear "stable" while the model is still actively writing, triggering
   * a premature "done" declaration.
   *
   * For services with COLLAPSED phases (e.g. Claude's thinking section is
   * hidden in the DOM during streaming), prefer textContent over innerText
   * here — textContent sees hidden descendant text and grows with thinking
   * tokens, whereas innerText would only catch sparse header updates.
   */
  getLatestMessageText: () => string
  /**
   * OPTIONAL: a separate, thorough text extractor used ONLY for the FINAL
   * capture (after streaming completes). Use this for any cleanup that is
   * unsafe to run during streaming — DOM cloning, math-source resolution,
   * full-body dedup, artifact widget stripping, etc.
   *
   * If absent, getLatestMessageText is used for the final capture too.
   */
  getFinalMessageText?: () => string
  /**
   * OPTIONAL: return true once the latest message has its post-completion
   * action buttons attached (Retry / Regenerate / Like / Dislike / Share
   * etc.). These buttons are added to the DOM ONLY after the AI is fully
   * done generating — they're a strong structural signal that won't
   * false-positive during streaming, thinking phases, or tool use.
   *
   * This is the most reliable completion signal and runs in parallel with
   * waitForStableText and the indicator-absent branch. The race ends as
   * soon as any branch fires.
   */
  isMessageFinalized?: () => boolean
  /**
   * Opt into the MAIN-world network capture as an additional exit path
   * for the polling loop. When the chat endpoint's stream closes (an
   * event the browser delivers regardless of tab visibility or rAF
   * suspension), the loop can exit using the network-captured text
   * even if the DOM hasn't committed yet — which is the case in
   * backgrounded tabs where Chrome's intensive throttling has stalled
   * React's rendering pipeline.
   *
   * Enable for any adapter that hangs in backgrounded tabs. We enable
   * for ALL three (chatgpt, claude, gemini) because we've
   * confirmed even Claude hangs on its FOURTH request when the tab
   * has been backgrounded for several minutes — throttling is
   * universal, not site-specific.
   *
   * The DOM-based exit paths remain primary; the capture is a fallback
   * for when those paths can't see DOM updates because the DOM isn't
   * actually being updated.
   */
  backendCapture?: boolean
}

/**
 * Build a sendPrompt function from a service's selector config.
 * Each step is generous with timing because these UIs are React-heavy,
 * the user may have long prompts, and responses can take minutes.
 */
export function makeAdapter(config: AdapterConfig) {
  const s = config.service

  return async function sendPrompt(
    prompt: string,
    onProgress?: (textLen: number) => void
  ): Promise<string> {
    // 1. PREVIOUS-TURN IDLE GATE (must run BEFORE we locate/type the input).
    //     When a service is reused for back-to-back pipeline stages (e.g.
    //     Claude proposes, then Claude synthesizes), the prior turn's UI
    //     can still be locked when this stage begins: the stop button is
    //     showing and the send button is disabled. Typing + clicking send
    //     into that locked composer no-ops — the prompt gets pasted but
    //     never submitted, and the stage then stalls (the polling loop's
    //     newMessageRendered gate correctly refuses to finalize on the
    //     previous answer, so it polls until the 30-min cap). Wait for the
    //     stream indicator to clear first. A fresh tab with no prior turn
    //     passes through instantly. In a backgrounded tab React can take
    //     ~20s to commit the stop->send swap, so allow a generous window,
    //     then proceed anyway — step 5b re-verifies that the send actually
    //     fired, so this can never deadlock. We locate the input AFTER this
    //     gate so the reference can't go stale if the composer re-mounts
    //     while the previous turn is wrapping up.
    const PREV_TURN_IDLE_TIMEOUT_MS = 45_000
    try {
      await waitFor(
        () => !isElementVisible(config.findStreamIndicator()),
        PREV_TURN_IDLE_TIMEOUT_MS,
        `${s}: waiting for previous turn to finish before sending`
      )
    } catch {
      console.log(
        `[MixerAI/${s}] previous-turn stream indicator still present after ` +
          `${PREV_TURN_IDLE_TIMEOUT_MS / 1000}s — proceeding anyway; send is re-verified in step 5b`
      )
    }

    // 2. Locate the chat input (fresh, after the idle gate)
    const input = await waitFor(
      config.findInput,
      15_000,
      `${s}: finding chat input`
    )

    // 3. Snapshot how many assistant messages exist so we can tell when a new one arrives
    const initialCount = config.countMessages()

    // 4. Type the prompt
    config.typePrompt(input, prompt)

    // 4b. Let React reconcile + the send button enable. For small prompts,
    //    500ms is plenty. For large bulk-pasted prompts (100KB+), React's
    //    reconciliation can take 1-2 seconds on slower machines; the send
    //    button stays disabled during that window. Scale linearly with
    //    prompt size, capped at 2.5s. The extra wait is invisible to the
    //    user (the side panel still shows "Running") but prevents the
    //    "send button click no-ops because the editor is still settling"
    //    failure mode observed on 100KB+ prompts.
    const reconcileMs = Math.min(2500, 500 + Math.floor(prompt.length / 200))
    await sleep(reconcileMs)

    // 5. Send: try the button first (8s patience), fall back to pressing Enter.
    //    This handles services with awkward / icon-only / locale-translated send buttons.
    //
    //    captureSince is anchored to the SEND moment (with 1s grace for clock
    //    skew between this ISOLATED-world script and the MAIN-world capture
    //    script). Anchoring later (at completionStart) would be wrong: in a
    //    hidden tab, step 6 (response-start wait) can sit for 60s before
    //    bailing. If the network stream completes during that wait, the
    //    captured doneAt would be older than a completionStart-based floor,
    //    and the client would correctly reject the legitimate capture as stale.
    let sentViaButton = false
    let captureSince = Date.now()
    try {
      const sendBtn = await waitFor(
        config.findSendButton,
        8_000,
        `${s}: finding send button`
      )
      captureSince = Date.now() - 1000
      ;(sendBtn as HTMLElement).click()
      sentViaButton = true
    } catch {
      captureSince = Date.now() - 1000
      input.focus()
      const keyOpts: KeyboardEventInit = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }
      input.dispatchEvent(new KeyboardEvent("keydown", keyOpts))
      input.dispatchEvent(new KeyboardEvent("keypress", keyOpts))
      input.dispatchEvent(new KeyboardEvent("keyup", keyOpts))
    }

    // 5b. VERIFY THE SEND ACTUALLY FIRED — and refuse to poll if it didn't.
    //     The click/Enter above can silently no-op if the composer was still
    //     locked from a previous turn (see step 1). We confirm the send by
    //     POSITIVE evidence, not by guessing:
    //       - the composer no longer contains this prompt (it cleared), OR
    //       - a new turn visibly started (assistant msg count grew, or the
    //         stream indicator appeared).
    //     Critical correctness points learned from review:
    //       * Read VALUE-AWARE: textarea/input keep text in .value, NOT
    //         textContent. The old textContent-only read silently disabled
    //         this check for ChatGPT (textarea service), so a
    //         no-op send there went completely unprotected.
    //       * Compare IDENTITY, not length: rich-text composers (Claude's
    //         ProseMirror) can leave a tiny "<p><br></p>" placeholder after a
    //         SUCCESSFUL send. A length floor could read that as "still
    //         populated" and double-submit. We check that a distinctive slice
    //         of the prompt is still present.
    //       * A null/again-mounting composer is NOT proof of anything — skip,
    //         don't false-confirm on it.
    //       * If, after retries, the send is still unconfirmed, THROW. Falling
    //         through into the polling loop would read the PREVIOUS turn's
    //         answer (the silent same-service-reuse failure). A thrown stage
    //         is recoverable by the orchestrator; a silently-wrong stage is not.
    const promptInk = prompt.replace(/\s+/g, "")
    const probe = promptInk.slice(0, Math.min(80, promptInk.length))
    let confirmedSend = false
    for (let attempt = 1; attempt <= 2; attempt++) {
      await sleep(900)
      const inputNow = config.findInput()
      if (!inputNow) {
        // Composer is remounting; a null read proves nothing. Try again.
        continue
      }
      const inputInk = readComposerText(inputNow).replace(/\s+/g, "")
      const composerCleared = probe.length === 0 || !inputInk.includes(probe)
      const newTurnStarted =
        config.countMessages() > initialCount ||
        isElementVisible(config.findStreamIndicator())
      if (composerCleared || newTurnStarted) {
        confirmedSend = true
        break
      }
      console.log(
        `[MixerAI/${s}] send not yet confirmed (composer still holds prompt, ` +
          `ink=${inputInk.length}); re-sending (attempt ${attempt})`
      )
      // Only re-anchor the capture floor here, where we have positive evidence
      // that nothing fired since the previous floor — so we can't reject a
      // legitimate in-flight capture from the first (slow-clearing) send.
      captureSince = Date.now() - 1000
      const reBtn = config.findSendButton()
      if (reBtn) {
        ;(reBtn as HTMLElement).click()
      } else {
        inputNow.focus()
        const reKeyOpts: KeyboardEventInit = {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        }
        inputNow.dispatchEvent(new KeyboardEvent("keydown", reKeyOpts))
        inputNow.dispatchEvent(new KeyboardEvent("keypress", reKeyOpts))
        inputNow.dispatchEvent(new KeyboardEvent("keyup", reKeyOpts))
      }
    }
    if (!confirmedSend) {
      throw new Error(
        `${s}: send not confirmed after retries — refusing to poll (would read a stale prior answer)`
      )
    }


    // 6. Detect that a response has started. In hidden tabs the DOM-based
    //    start signals may never fire because React commits are stalled.
    //    For backend-capture adapters, race those DOM signals against a
    //    network-capture start signal with a SHORTER timeout (8s vs 60s)
    //    so we don't sit here for a full minute before checking the
    //    network. If nothing fires in 8s, fall into the polling loop
    //    which keeps checking both DOM and capture every 500ms.
    const initialText = config.getLatestMessageText() ?? ""
    const responseStartTimeoutMs = config.backendCapture ? 8_000 : 60_000
    try {
      const races: Promise<unknown>[] = [
        waitFor(
          () => config.countMessages() > initialCount,
          responseStartTimeoutMs,
          `${s}: response start (count)`
        ),
        waitFor(
          () =>
            (config.getLatestMessageText() ?? "").length >
            initialText.length + 5,
          responseStartTimeoutMs,
          `${s}: response start (text growth)`
        )
      ]
      if (config.backendCapture) {
        races.push(
          waitFor(
            () => {
              const ev = getBackendCaptureSince(captureSince)
              return !!(ev && ev.rawText && ev.rawText.trim().length >= 20)
            },
            responseStartTimeoutMs,
            `${s}: response start (backend capture)`,
            500
          )
        )
      }
      await Promise.race(races)
    } catch {
      // None fired in the short window — fall into the polling loop, which
      // keeps checking both DOM and backend-capture paths.
    }

    // 7. Wait for streaming to finish.
    //
    //    DESIGN: unified polling loop with the visible stream indicator as
    //    a HARD GATE that blocks completion. Earlier versions used
    //    Promise.race() over three independent signals (action buttons,
    //    text stability, indicator absent). That was architecturally
    //    wrong: in a race, ANY signal firing wins — even if another
    //    signal is screaming "still running." Claude's text-stability
    //    branch fired during thinking-section header-update pauses while
    //    the stop button was clearly visible, causing premature "Done."
    //
    //    Correct design: the visible stop button is the canonical
    //    "still generating" signal. While it's visible, we cannot be
    //    done — period. Completion requires the stop button to be
    //    absent for a sustained window (5s), PLUS one of:
    //
    //      - we have seen the stop button at some point during this
    //        run (so we know streaming actually started), OR
    //      - post-completion action buttons appeared on the message
    //        (Retry / Regenerate / Like / Dislike etc.), OR
    //      - text has been completely stable for 30s (last-resort
    //        fallback for when indicator selectors are broken)
    //
    //    All paths require non-empty text. The whole loop runs for up
    //    to 30 minutes so long-running responses (Claude reasoning for
    //    10+ minutes) never time out — Ethan: "no timers, just wait."
    const findVisibleStreamIndicator = () => {
      const el = config.findStreamIndicator()
      return isElementVisible(el) ? el : null
    }

    const NO_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes — effectively no timer
    const INDICATOR_ABSENT_CONFIRM_MS = 5000 // 5s sustained absence
    const TEXT_STABLE_FALLBACK_MS = 30000 // 30s no meaningful change
    const DOM_SETTLE_MS = 2500 // path0a: DOM must stop growing before we trust it
    const MEANINGFUL_GROWTH_CHARS = 5 // ignore micro-changes (KaTeX re-renders)
    const POLL_MS = 500
    const HEARTBEAT_MS = 10000 // log full state every 10s while polling

    const completionStart = Date.now()
    let sawStreamIndicator = false
    let lastText = config.getLatestMessageText()
    let lastMeaningfulChangeAt = Date.now()
    let indicatorAbsentSince: number | null = null
    let lastHeartbeatAt = 0
    let exitReason = "unknown"

    // Backend-capture tracking. captureSince was anchored in step 5
    // (above) to the SEND moment, not to here. That's important: in
    // hidden tabs, step 6 can sit for 60s before bailing, and the
    // network stream may complete during that wait — a floor based on
    // completionStart would reject the legitimate capture as stale.
    let capturedBackendText: string | null = null
    let capturedAt: number | null = null

    console.log(`[MixerAI/${s}] polling loop STARTED`)

    // Set up a MutationObserver that wakes the polling loop as soon as the
    // DOM changes meaningfully. Each iteration of the loop creates a fresh
    // AbortController and passes its signal to sleepUntilAborted; when the
    // observer fires, it aborts whatever sleep is currently in flight so the
    // loop runs its checks again immediately.
    //
    // Why this matters: setTimeout in a backgrounded tab gets throttled to
    // ~once per minute by Chrome. Without this observer, when the user
    // switches away from the AI tab while it's generating, our polling loop
    // can lag 60+ seconds behind the actual completion. MutationObserver
    // callbacks aren't throttled the same way and fire on DOM changes
    // regardless of tab focus.
    //
    // We throttle the wake signal to once per 100ms so a streaming response
    // (which can fire mutations every few ms) doesn't busy-spin the loop —
    // still 5x faster than the 500ms baseline poll, plenty responsive.
    //
    // The attribute filter targets the DOM signals our adapters actually
    // care about: aria-label changes (Stop → Send transition), disabled
    // toggles, class changes (status indicators), and data-state attrs
    // (used by some component libraries on action buttons).
    let wakeController = new AbortController()
    let lastWakeAt = 0
    const wakeObserver = new MutationObserver(() => {
      const now = Date.now()
      if (now - lastWakeAt < 100) return
      lastWakeAt = now
      wakeController.abort()
    })
    wakeObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "disabled", "class", "data-state"]
    })

    try {
      while (Date.now() - completionStart < NO_TIMEOUT_MS) {
      const indicator = findVisibleStreamIndicator()
      const currentText = config.getLatestMessageText() ?? ""
      const finalized = config.isMessageFinalized?.() ?? false

      // v1.6.8: live open-stream signal. For Claude this is >0 while the
      // answer stream is still in flight; for every other service (and if the
      // capture page hasn't loaded) it is 0, so the gates below are no-ops and
      // behavior is unchanged. We never declare "done" while a stream is open.
      const { openStreams: openClaudeStreams, lastOpenAt: lastStreamOpenAt } =
        config.backendCapture
          ? getCaptureStreamState()
          : { openStreams: 0, lastOpenAt: 0 }
      const aStreamIsOpen = openClaudeStreams > 0

      // Heartbeat: every 10s, dump full state so we can see what's happening
      const elapsed = Date.now() - completionStart
      if (elapsed - lastHeartbeatAt >= HEARTBEAT_MS) {
        lastHeartbeatAt = elapsed
        const textStableForLog = Date.now() - lastMeaningfulChangeAt
        const indicatorAbsentForLog =
          indicatorAbsentSince === null
            ? "never-absent"
            : `${Math.round((Date.now() - indicatorAbsentSince) / 1000)}s`
        const currentMsgCount = config.countMessages()
        console.log(
          `[MixerAI/${s}] heartbeat t=${Math.round(elapsed / 1000)}s ` +
            `textLen=${currentText.length} ` +
            `msgCount=${currentMsgCount}/${initialCount}+1 ` +
            `indicator=${!!indicator} ` +
            `sawIndicator=${sawStreamIndicator} ` +
            `indicatorAbsentFor=${indicatorAbsentForLog} ` +
            `finalized=${finalized} ` +
            `openStreams=${openClaudeStreams} ` +
            `textStableFor=${Math.round(textStableForLog / 1000)}s`
        )
        // Notify the orchestrator that we're alive — this resets the
        // hang-watchdog clock on the SW side. Without this, a slow
        // model (Gemini with extensive thinking) can sit at "running"
        // for >90s and trigger force-activation even though it's
        // making progress.
        try {
          onProgress?.(currentText.length)
        } catch {
          // Don't let a failing progress callback take down the loop
        }
      }

      // Track meaningful text changes — ignore micro-changes (KaTeX
      // re-renders, cursor blinks) that don't represent real progress.
      if (
        Math.abs(currentText.length - lastText.length) >= MEANINGFUL_GROWTH_CHARS
      ) {
        lastText = currentText
        lastMeaningfulChangeAt = Date.now()
      }

      // Track indicator absence even though we no longer immediately
      // hard-gate on it. path1/path2 still consume indicatorAbsentSince
      // below; the only thing that's changed is that backend-capture
      // gets a chance to fire first.
      if (!indicator) {
        if (indicatorAbsentSince === null) {
          indicatorAbsentSince = Date.now()
        }
      } else {
        sawStreamIndicator = true
        indicatorAbsentSince = null
      }
      const indicatorGoneFor =
        indicatorAbsentSince === null ? 0 : Date.now() - indicatorAbsentSince
      const textStableFor = Date.now() - lastMeaningfulChangeAt
      const hasText = currentText.trim().length > 0

      // Check the MAIN-world network capture FIRST — BEFORE the indicator
      // hard gate. In hidden tabs the stop button may still appear visible
      // because React hasn't committed its disappearance (rAF stalled at
      // 0Hz). Gating on the indicator here would block the only signal
      // that bypasses stale DOM.
      //
      // The capture fires when the chat endpoint's response stream closes
      // — an event the browser delivers regardless of tab visibility or
      // rAF throttling. This is the defense against the background-tab
      // hang where the DOM never commits because Chrome has suspended
      // the rendering pipeline.
      // UPGRADE-TO-LONGEST (not latch-on-first).
      // getBackendCaptureSince() already returns the LONGEST event since
      // captureSince, but a single early poll can fire before the real
      // answer lands — capturing a short interim event. The old code
      // latched that first event (`!capturedBackendText`) and never
      // re-queried, so a later, longer capture was ignored. We now
      // re-query every tick and upgrade whenever a strictly longer
      // capture appears, resetting capturedAt so the path0b quiescence
      // timer measures "time since the capture last grew" rather than
      // "time since the first capture". For ChatGPT/Claude,
      // which record a single substantial completion event, the upgrade
      // branch simply never fires and behavior is unchanged.
      if (config.backendCapture) {
        const ev = getBackendCaptureSince(captureSince)
        const evLen = ev?.rawText?.trim().length ?? 0
        const prevLen = capturedBackendText?.length ?? 0
        if (ev && ev.rawText && evLen >= 20 && evLen > prevLen) {
          capturedBackendText = ev.rawText.trim()
          capturedAt = ev.doneAt
          console.log(
            `[MixerAI/${s}] backend capture ${prevLen ? "upgraded" : "seen"}: ` +
              `doneAt=${ev.doneAt} capturedLen=${capturedBackendText.length} ` +
              `(prev=${prevLen}) domLen=${currentText.length} ` +
              `url=${ev.url.slice(0, 120)}`
          )
          // Reset the SW-side hang watchdog with REAL progress, not just
          // a heartbeat. The orchestrator's hangWatchdog only counts
          // textLen growth as real progress; reporting the captured
          // length here tells it "real work happened, don't force-activate."
          try {
            onProgress?.(capturedBackendText.length)
          } catch {}
        }
      }

      // Path 0a (preferred when capture is available): stream closed AND
      // DOM has substantive content that's COMPARABLE in size to what
      // was captured. The DOM has rendered markdown, citations, code
      // blocks etc that raw capture lacks — but only if it actually
      // rendered. If DOM is dramatically smaller than captured (e.g.
      // 32 chars vs 1967 chars captured), the renderer is stalled
      // mid-stream and the DOM read would lose 98% of the answer.
      // In that case, let path0b take over and use captured text.
      const capturedLen = capturedBackendText?.length ?? 0
      const domLen = currentText.trim().length
      const domIsComparable =
        capturedLen === 0 || domLen >= capturedLen * 0.5
      // The DOM must also have STOPPED GROWING. Without this, path0a can
      // fire mid-render in a throttled tab: the stream has closed and the
      // capture is present, but React is still committing tokens, so the
      // DOM holds only a PARTIAL answer. Observed in a real run: 14,133
      // chars were taken while the full answer was 18,965 — a silent ~26%
      // truncation. domIsComparable's 50% floor doesn't catch this (a
      // 74%-rendered answer passes it). Requiring brief text stability
      // lets the DOM finish rendering first. If the renderer is truly
      // stalled and never settles, path0b fires 5s after capture and uses
      // the COMPLETE captured text instead — so this never causes a hang.
      // (During Claude's thinking pauses the text is also "stable", but
      // capturedBackendText is still null then because the stream hasn't
      // closed, so path0a can't fire early regardless.)
      const domSettled = textStableFor >= DOM_SETTLE_MS
      // path0a must also confirm a NEW assistant message rendered THIS turn.
      // Without it, in a same-service back-to-back stage the previous answer
      // (still on screen) could satisfy every other condition and be returned
      // as this turn's result. path0b below does NOT need this — it's anchored
      // to captureSince and exists precisely for when the DOM never commits.
      const newMessageForPath0a = config.countMessages() > initialCount
      // v1.6.8: if a Claude stream opened AFTER we recorded the capture we're
      // currently holding, that capture was an interim/short stream and the
      // real answer is still coming — don't finalize on the stale one. When
      // the real stream closes, the upgrade-to-longest above refreshes
      // capturedAt and this clears.
      const captureSupersededByNewerStream =
        capturedAt != null && lastStreamOpenAt > capturedAt
      if (
        config.backendCapture &&
        capturedBackendText &&
        hasText &&
        domLen >= 20 &&
        domIsComparable &&
        domSettled &&
        newMessageForPath0a &&
        !aStreamIsOpen
      ) {
        // NOTE: we do NOT decide DOM-vs-capture here. domLen is a MID-LOOP
        // snapshot and can understate the DOM that will exist a moment later
        // (the thorough getFinalMessageText extractor in step 9 reads more
        // than getLatestMessageText). Comparing capturedLen to this snapshot
        // would wrongly prefer raw text on answers the DOM was about to
        // finish. The authoritative DOM-vs-capture reconciliation happens at
        // final extraction (step 9), where we read the FINAL DOM text and
        // compare it to the complete capture.
        exitReason = "path0a:backend-stream-done+dom-current"
        break
      }

      // Path 0b (capture fallback): stream closed but DOM is empty,
      // stale, or dramatically smaller than captured text. 5s grace
      // from when capture fired allows React a last chance to commit
      // if a frame slips through. If it hasn't, accept captured text
      // as the answer. User gets slightly less polished result (no
      // rendered markdown) but task completes correctly.
      if (
        config.backendCapture &&
        capturedBackendText &&
        capturedAt &&
        Date.now() - capturedAt >= 5_000 &&
        !aStreamIsOpen &&
        !captureSupersededByNewerStream
      ) {
        exitReason = "path0b:backend-stream-done+dom-stalled"
        break
      }

      // HARD GATE: visible stop button means we're NOT done.
      // This runs AFTER backend-capture checks so stale-DOM indicator
      // doesn't block path0a/0b. For foreground tabs (where capture
      // either isn't enabled or arrives in sync with DOM), behavior is
      // unchanged — the gate still prevents Claude false-Done while
      // still thinking.
      if (indicator) {
        wakeController = new AbortController()
        await sleepUntilAborted(POLL_MS, wakeController.signal)
        continue
      }

      // NEW MESSAGE GATE: DOM-based exit paths must wait for a new
      // assistant message bubble to appear. In hidden tabs where React
      // commits are stalled, step 6 can time out before the new bubble
      // renders, leaving the previous turn's bubble as `latestMessage`.
      // That bubble has all the path1 markers (finalized, indicator gone,
      // text stable) because it IS finalized — from last turn. Without
      // this gate, path1 fires within 12s and returns stale content.
      //
      // Capture paths (path0a/path0b) are already turn-safe because they
      // verify `doneAt > captureSince` which is anchored to send time.
      // Only the DOM-based paths need this check.
      const newMessageRendered = config.countMessages() > initialCount

      // Path 1 (best DOM signal): action buttons attached AND indicator gone 5s.
      if (
        newMessageRendered &&
        finalized &&
        indicatorGoneFor >= INDICATOR_ABSENT_CONFIRM_MS &&
        hasText
      ) {
        exitReason = "path1:finalized+indicator-gone"
        break
      }

      // Path 2 (normal DOM): indicator was seen, now sustained-absent.
      if (
        newMessageRendered &&
        sawStreamIndicator &&
        indicatorGoneFor >= INDICATOR_ABSENT_CONFIRM_MS &&
        hasText &&
        !aStreamIsOpen
      ) {
        exitReason = "path2:indicator-sustained-absent"
        break
      }

      // Path 3 (broken indicator selectors): no indicator ever seen,
      // text stable 30s. Catches cases where the adapter's stop-button
      // selector doesn't match the current UI version.
      if (
        newMessageRendered &&
        textStableFor >= TEXT_STABLE_FALLBACK_MS &&
        hasText &&
        !aStreamIsOpen
      ) {
        exitReason = "path3:text-stable-fallback"
        break
      }

      // ESCAPE HATCH — last-resort safety net. After 3 minutes of
      // polling AND 15 seconds of text stability AND non-empty text,
      // exit regardless of any other condition. Still gated on new
      // message rendered — we'd rather hit the 30-min cap than return
      // the previous turn's answer.
      const totalElapsedSinceStepStart = Date.now() - completionStart
      if (
        newMessageRendered &&
        totalElapsedSinceStepStart > 3 * 60 * 1000 &&
        textStableFor >= 15000 &&
        hasText &&
        !aStreamIsOpen
      ) {
        exitReason = "path4:escape-hatch-3min"
        break
      }

      wakeController = new AbortController()
      await sleepUntilAborted(POLL_MS, wakeController.signal)
    }
    } finally {
      // Always tear down the observer — whether the loop exited cleanly,
      // hit its 30-minute timeout, or threw. A leaked observer would keep
      // firing wake aborts on a stale controller after sendPrompt returns.
      wakeObserver.disconnect()
    }

    if (exitReason === "unknown") {
      exitReason = "no-timeout-expired-30min"
    }
    const finalLen = (config.getLatestMessageText() ?? "").trim().length
    console.log(
      `[MixerAI/${s}] polling loop EXITED reason=${exitReason} ` +
        `elapsed=${Math.round((Date.now() - completionStart) / 1000)}s ` +
        `finalTextLen=${finalLen}`
    )

    // 7b. Safety net: if our text capture at polling exit was empty, the
    //     selectors haven't caught up with the rendered answer yet — wait
    //     briefly for text to actually appear.
    //
    //     CRITICAL: we check `finalLen` (the length we JUST logged), NOT a
    //     fresh getLatestMessageText() call. Claude's UI re-mounts the
    //     message element for a fraction of a second right after streaming
    //     completes — when it attaches the action-button toolbar (Retry,
    //     Copy, Like, Dislike) and creates artifact widgets. During that
    //     brief re-mount, getLatestMessageText() can transiently return
    //     empty even though a 2000+ char answer was just captured.
    //
    //     Earlier this branch re-read the text and used NO_TIMEOUT_MS
    //     (30 MINUTES) as the wait cap. A transient empty would falsely
    //     trip the branch; waitForStableText required 4 growth events but
    //     text didn't grow anymore (already at final length), so it would
    //     never satisfy the stability condition and would hang the entire
    //     content script for 30 minutes. The side panel would sit at
    //     "Running..." for the full half hour while the content script was
    //     stuck. Diagnosed by Ethan & me from the v1.3.1 heartbeat logs.
    //
    //     The new gate (finalLen) plus a short 15s timeout means: if we
    //     captured nothing, give the page 15s to render something — but
    //     never block on a transient re-render after a successful capture.
    const exitedViaCapture = exitReason.startsWith("path0")
    const exitedViaPath0bStalled =
      exitReason === "path0b:backend-stream-done+dom-stalled"
    // path0a-capture fires when the stream closed and a new message rendered,
    // but the settled DOM was meaningfully SHORTER than the complete capture
    // (a truncated tail). Like path0b, it must return the captured text.
    const exitedPreferringCapture =
      exitedViaPath0bStalled ||
      exitReason === "path0a-capture:dom-short-of-capture"

    // 7b. Safety net: empty text at polling exit AND no captured text —
    //     wait briefly for the page to render something. If we have
    //     captured text, skip this entirely; we use the captured text
    //     below regardless of what DOM does. Without this gate, a
    //     successful path0b exit (DOM never committed) would still
    //     waste 15s waiting for DOM that's never going to update.
    if (finalLen === 0 && !capturedBackendText) {
      console.log(
        `[MixerAI/${s}] step 7b: empty text at polling exit — safety net (max 15s)`
      )
      try {
        await waitForStableText(
          config.getLatestMessageText,
          3_000,
          15_000,
          500,
          `${s}: extra wait for delayed response capture`
        )
      } catch {
        // Fall through — capture really has failed. Step 9 returns
        // empty and the orchestrator marks this step failed.
      }
    }

    // 8. Small settling buffer for DOM-based exits only. Network capture
    //    has no DOM-settling step; the captured text is already final
    //    (the stream closed before we exited), so this 600ms sleep is
    //    pure latency we don't need.
    if (!exitedViaCapture) {
      await sleep(600)
    }

    // 9. Read the final response.
    //
    //    path0b means DOM was stalled at exit. A non-empty DOM read here
    //    is likely a STALE previous assistant message (the new one never
    //    rendered), NOT this turn's answer. Prefer the captured text in
    //    that case — it's the actual response.
    //
    //    For all other exits, prefer DOM (it has rendered markdown,
    //    citations, formatting) but fall back to captured text if the
    //    DOM read is empty.
    const finalGetter =
      config.getFinalMessageText ?? config.getLatestMessageText
    let raw: string

    if (exitedPreferringCapture && capturedBackendText) {
      console.log(
        `[MixerAI/${s}] step 9: ${exitReason} — using captured text over potentially-partial/stale DOM (len=${capturedBackendText.length})`
      )
      raw = capturedBackendText
    } else {
      raw = finalGetter().trim()

      // Step 9 retry: if the final read came back empty but the polling
      // loop captured non-empty text, the read raced with a UI re-mount
      // window. Wait briefly and try again.
      if (raw.length === 0 && finalLen > 0) {
        console.log(
          `[MixerAI/${s}] step 9: empty final read despite non-empty polling capture — retrying`
        )
        await sleep(500)
        raw = finalGetter().trim()
        if (raw.length === 0) {
          // Last resort: try the streaming getter directly
          raw = config.getLatestMessageText().trim()
        }
        console.log(`[MixerAI/${s}] step 9: retry result length=${raw.length}`)
      }

      // Step 9b: still empty but backend capture has text — use it.
      // Without this, a path0a exit followed by an empty DOM read would
      // propagate an empty result back to the orchestrator.
      if (
        raw.length === 0 &&
        capturedBackendText &&
        capturedBackendText.length > 0
      ) {
        console.log(
          `[MixerAI/${s}] step 9b: DOM read empty but backend capture has text — using captured (len=${capturedBackendText.length})`
        )
        raw = capturedBackendText
      }

      // Step 9c: TRUNCATION GUARD (authoritative DOM-vs-capture reconciliation).
      // Now that we hold the FINAL, fully-extracted DOM text (not a mid-loop
      // snapshot), compare it to the complete network capture. Rendered DOM
      // legitimately runs a few % under raw capture (markdown punctuation
      // stripped, link URLs shown as anchor text), so a small shortfall is
      // normalization. But a LARGE shortfall means the DOM is a truncated
      // tail — the Log B failure where 14,133 chars shipped while the real
      // answer was 18,965. In that case, prefer the complete capture.
      //
      // This runs on the FINAL extract, so it cannot mis-fire on an answer
      // the DOM was merely a moment away from finishing (that answer has now
      // finished and reads at full length here).
      if (capturedBackendText && capturedBackendText.length > 0 && raw.length > 0) {
        const FINAL_TOLERANCE_RATIO = 0.08
        const FINAL_TOLERANCE_ABS = 120
        const capLen = capturedBackendText.length
        const allowedShortfall = Math.max(
          FINAL_TOLERANCE_ABS,
          Math.floor(capLen * FINAL_TOLERANCE_RATIO)
        )
        if (capLen - raw.length > allowedShortfall) {
          console.log(
            `[MixerAI/${s}] step 9c: final DOM (${raw.length}) is short of complete ` +
              `capture (${capLen}) by more than tolerance — using captured text to avoid truncation`
          )
          raw = capturedBackendText
        }
      }
    }

    return raw
      .replace(
        /^(Claude responded:|Claude said:|Assistant said:|ChatGPT said:|GPT responded:|DeepSeek said:|Gemini said:)\s*/i,
        ""
      )
      .trim()
  }
}
