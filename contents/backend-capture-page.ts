import type { PlasmoCSConfig } from "plasmo"

/**
 * Backend-stream completion capture for ChatGPT, Claude, Gemini.
 *
 * THE PROBLEM
 * -----------
 * When the user keeps an AI tab in the background, Chrome aggressively
 * throttles the page: `requestAnimationFrame` runs at 0 Hz, React's
 * rendering pipeline stops committing, DOM mutations stop firing. Our
 * existing polling loop in `lib/make-adapter.ts` watches the DOM for
 * "done" signals (stop-button disappearance, action-button appearance,
 * text stability). Every one of those signals depends on the DOM
 * actually being up-to-date — which it isn't, in a backgrounded tab.
 * Result: completion is detected only when the user clicks the tab.
 *
 * THE FIX
 * -------
 * The network layer doesn't care about visibility or rAF. SSE streams,
 * fetch responses, and XHR completion fire normally even when the tab
 * is fully hidden and throttled. So: we wrap `fetch`, `EventSource`,
 * and `XMLHttpRequest` in the page's MAIN world, watch for the chat
 * streaming endpoints, and when a stream closes we know the model is
 * done generating regardless of what the DOM is doing.
 *
 * WHY THIS RUNS IN MAIN WORLD
 * ---------------------------
 * Plasmo content scripts default to the ISOLATED world. From there we
 * can't replace `window.fetch` etc — our overrides wouldn't be seen by
 * the page's own code. MAIN world runs in the page's JS context so our
 * monkey-patches are seen by everything the page calls. The tradeoff is
 * that MAIN-world scripts can't directly talk to chrome.runtime — but
 * we don't need to. We stash captured data on a hidden DOM node that
 * the ISOLATED-world content script reads via the helper in
 * lib/backend-capture-client.ts.
 *
 * SAFETY NOTES
 * ------------
 * - We `tee()` the streaming response so the page consumes its copy
 *   exactly as it would have. Our reader drains the second copy in
 *   parallel. No interference with the app's normal operation.
 * - URL patterns are liberal; the cost of matching a non-streaming
 *   request is one extra tee + drain, which is benign.
 * - Extraction is best-effort. If we can't parse a stream's body, we
 *   still fire the wake — the adapter's existing DOM-based exit paths
 *   take over from there.
 * - Diagnostic logging is generous in this first version. Once we
 *   verify extractors work on real responses we can quiet things down.
 */

export const config: PlasmoCSConfig = {
  matches: [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*"
  ],
  run_at: "document_start",
  world: "MAIN",
  all_frames: false
}

interface BackendStreamEvent {
  doneAt: number
  rawText: string
  url: string
  service: string
}

declare global {
  interface Window {
    __mixeraiBackendCapture?: {
      events: BackendStreamEvent[]
      installed: true
    }
  }
}

;(() => {
  const w = window as any
  if (w.__mixeraiBackendCapture?.installed) return

  const state: { events: BackendStreamEvent[]; installed: true } = {
    events: [],
    installed: true
  }
  w.__mixeraiBackendCapture = state

  // --- Open-stream tracking (Claude only) -------------------------------
  // v1.6.8: the polling loop in make-adapter must never declare a turn
  // "done" while Claude's answer stream is still in flight. The capture only
  // records on stream CLOSE, so without an explicit "a stream is open right
  // now" signal the loop's DOM-stability fallbacks (path2/3/4) could finalize
  // on a partial answer during a long thinking pause in a backgrounded tab,
  // and path0b could finalize on a short interim stream before the real
  // answer streams. We expose the live in-flight count and the timestamp of
  // the most recent stream open via documentElement attributes (the DOM is
  // the only MAIN->ISOLATED bridge). Scoped to Claude so ChatGPT (WebSocket)
  // and Gemini (XHR) are provably unaffected — their streams never touch the
  // fetch path that increments this counter.
  let openClaudeStreams = 0
  let lastClaudeStreamOpenAt = 0

  // Per-host URL patterns. Liberal because OpenAI / Google / Anthropic
  // rotate path segments. Matching too widely is harmless
  // (one extra tee on a non-streaming request). Matching too narrowly
  // misses streams; we'd see that in the diagnostic logs and update.
  interface ServiceConfig {
    hostMatch: RegExp
    streamPatterns: RegExp[]
    service: string
  }
  const SERVICES: ServiceConfig[] = [
    {
      service: "chatgpt",
      hostMatch: /^(?:https?:\/\/)?(?:www\.)?(chatgpt\.com|chat\.openai\.com)/i,
      streamPatterns: [
        /\/backend-api\/conversation/i,
        /\/backend-anon\/conversation/i,
        /\/backend-api\/f\/conversation/i,
        /\/backend-api\/[^?]*\/responses/i,
        // Catches the resume_sse_endpoint leg if OpenAI takes that path
        // instead of WebSocket, and any future conduit-related URLs.
        /\/backend-api\/.*(?:conduit|stream|sse|subscribe|topic)/i
      ]
    },
    {
      service: "claude",
      hostMatch: /^(?:https?:\/\/)?(?:www\.)?claude\.ai/i,
      streamPatterns: [
        /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/i,
        /\/api\/append_message/i,
        /\/completion/i // generous fallback
      ]
    },
    {
      service: "gemini",
      hostMatch: /^(?:https?:\/\/)?(?:www\.)?gemini\.google\.com/i,
      streamPatterns: [
        /StreamGenerate/i,
        /GenerateContent/i,
        /BardChatUi/i,
        /BardFrontendService/i,
        /assistant\.lamda/i,
        /batchexecute/i
      ]
    }
  ]

  const currentHost = window.location.origin
  const myService =
    SERVICES.find((s) => s.hostMatch.test(currentHost))?.service ?? "unknown"

  const matchesStreamUrl = (url: string): string | null => {
    if (!url) return null
    for (const svc of SERVICES) {
      if (!svc.hostMatch.test(url) && !svc.hostMatch.test(currentHost)) continue
      for (const pat of svc.streamPatterns) {
        if (pat.test(url)) return svc.service
      }
    }
    return null
  }

  const MAX_EVENTS = 16
  const MAX_AGE_MS = 10 * 60 * 1000
  // Minimum extracted-text length required for a capture to overwrite the
  // stored event. Noisy post-completion XHRs that extract to "" must NOT
  // clobber the real answer. Threshold is also used by the ISOLATED-world
  // client when filtering candidates.
  const MIN_CAPTURE_TEXT_CHARS = 20

  const record = (service: string, url: string, rawText: string): boolean => {
    const text = rawText.replace(/\r\n/g, "\n").trim()
    // Refuse to overwrite a useful capture with an empty/tiny one.
    if (text.length < MIN_CAPTURE_TEXT_CHARS) return false

    const now = Date.now()
    state.events.push({ doneAt: now, rawText: text, url, service })
    while (state.events.length > MAX_EVENTS) state.events.shift()
    while (
      state.events.length > 0 &&
      state.events[0].doneAt < now - MAX_AGE_MS
    ) {
      state.events.shift()
    }

    // Stamp DOM-readable markers. ISOLATED-world content scripts can't
    // read MAIN-world JS variables (security boundary) but CAN read DOM
    // nodes.
    //
    // CRITICAL — Trusted Types CSP: Gemini ships a strict Trusted Types
    // policy that blocks `script.textContent = "..."`. We use <meta>
    // with a `content` attribute, which is inert and unrestricted.
    try {
      const root = document.documentElement
      if (!root) return true
      root.setAttribute("data-mixerai-backend-done-at", String(now))
      let store = document.getElementById(
        "mixerai-backend-store"
      ) as HTMLMetaElement | null
      if (!store) {
        store = document.createElement("meta") as HTMLMetaElement
        store.id = "mixerai-backend-store"
        store.setAttribute("name", "mixerai-backend-store")
        ;(document.documentElement || document.head || document.body).appendChild(
          store
        )
      }
      // Expose the full events[] array. The ISOLATED-world client picks
      // the best event using THIS request's captureSince as the floor,
      // so picking here would risk leaking across consecutive requests.
      // The single-event fields point at the latest event for backward-
      // compat with any in-flight client code.
      const latest = state.events[state.events.length - 1]
      store.setAttribute(
        "content",
        JSON.stringify({
          doneAt: latest.doneAt,
          url: latest.url,
          rawText: latest.rawText,
          service: latest.service,
          events: state.events
        })
      )
    } catch (e) {
      console.log("[mixerai/capture] failed to stamp DOM:", e)
    }
    return true
  }

  // Stamp the live open-stream state onto documentElement so the
  // ISOLATED-world client can read it (the DOM is the cross-world bridge).
  // Cheap attribute writes, safe under Trusted Types (data-* attributes are
  // unrestricted).
  const stampStreamState = () => {
    try {
      const root = document.documentElement
      if (!root) return
      root.setAttribute("data-mixerai-open-streams", String(openClaudeStreams))
      root.setAttribute(
        "data-mixerai-last-open-at",
        String(lastClaudeStreamOpenAt)
      )
    } catch {}
  }

  // Fire a DOM mutation to wake any MutationObservers attached to body.
  // We use a tiny hidden span append+remove on the next frame — visible
  // to MutationObserver's childList:true,subtree:true observation.
  //
  // We set styles via individual properties rather than .cssText, and
  // use data-* attributes only, so Trusted Types policies on the host
  // page (e.g. Gemini's) don't block any of this. Span elements and
  // data attributes are universally allowed.
  const fireWake = () => {
    try {
      if (!document.body) return
      const wake = document.createElement("span")
      wake.setAttribute("data-mixerai-stream-done", String(Date.now()))
      wake.setAttribute("aria-hidden", "true")
      wake.style.position = "absolute"
      wake.style.width = "0"
      wake.style.height = "0"
      wake.style.overflow = "hidden"
      wake.style.visibility = "hidden"
      document.body.appendChild(wake)
      setTimeout(() => {
        try {
          wake.remove()
        } catch {}
      }, 100)
    } catch {}
  }

  // ----------------------------------------------------------------
  // EXTRACTORS
  //
  // Per-service body parsers. These are deliberately defensive: when in
  // doubt return the empty string and let the adapter's DOM-read paths
  // handle it. We never throw — extractor failures shouldn't break the
  // tee'd stream consumption.
  //
  // For first deployment these are also instrumented: on every extract
  // we log the input length and output length to the console so we can
  // see in the page's DevTools whether parsing succeeded.
  // ----------------------------------------------------------------

  function extractChatGPT(raw: string): string {
    // Normalize envelopes to a stream of SSE-shaped lines, then run a single
    // tolerant parsing pass that knows both the legacy snapshot shape
    // (message.content.parts) and the modern JSON-Patch v/p/o shape.
    //
    // ChatGPT's transport in 2026 is multi-layered. The /backend-api/f/
    // conversation endpoint returns a tiny "stream_handoff" pointing at a
    // separate conduit (WebSocket or resume SSE). The conduit frames come
    // in several wrapper shapes:
    //
    //   - Calpico WS array of envelopes:
    //       [{"type":"message", "topic_id":"...", "payload":{"type":"conversation-turn-stream",
    //         "payload":{"type":"stream-item", ...patch op fields...}}}]
    //   - {type:"http.response.body", body:"<base64>", more_body:true, ...}
    //   - {type:"message", data:"data: {...}\n"}
    //   - bare JSON-Patch: {v:"token", p:"/message/content/parts/0", o:"append"}
    //   - snapshot shape: {v:{message:{author:{role:"assistant"}, content:{parts:["..."]}}}}
    //
    // Step 1 unwraps envelopes into SSE-shaped lines. Step 2 parses those
    // with knowledge of both delta and snapshot shapes.
    const normalized: string[] = []

    // Recursively unwrap nested calpico envelopes to reach the actual SSE
    // content. The WS frames live as top-level arrays of:
    //
    //   {type:"message", topic_id, payload: {
    //     type:"conversation-turn-stream", payload: {
    //       type:"stream-item",
    //       conversation_id, turn_id,
    //       encoded_item: "event: delta\ndata: {...}\n\n",   ← THIS IS THE GOLD
    //       stream_item_id, parent_stream_item_id, server_timestamp_ms
    //     }
    //   }}
    //
    // The `encoded_item` string is real SSE syntax (with literal "\n"
    // newlines after JSON-decoding the outer wrapper). Once unwrapped it
    // contains `event: delta` followed by `data: {"v":..., "p":..., "o":...}`
    // — the standard JSON-Patch shape this extractor already handles.
    //
    // peelAndPushCalpico walks the envelope and, on reaching a stream-item
    // with a string encoded_item, pushes those SSE lines into `normalized`
    // for the second-pass parser to handle. If we encounter a fully-shaped
    // patch op or message snapshot before reaching encoded_item (some
    // legacy frame variants), we push it as a serialized data: line.
    const peelAndPushCalpico = (obj: unknown, depth = 0): void => {
      if (!obj || typeof obj !== "object" || depth > 8) return
      const cur: any = obj

      // Found the gold: a stream-item with an encoded_item SSE string.
      if (typeof cur.encoded_item === "string" && cur.encoded_item.length > 0) {
        for (const inner of cur.encoded_item.split(/\r?\n/)) {
          const t = inner.trim()
          if (t) normalized.push(t)
        }
        return
      }

      // Already a patch op or snapshot — push as data: line.
      if (
        "v" in cur ||
        "p" in cur ||
        cur?.message?.author ||
        cur?.author
      ) {
        try {
          normalized.push("data: " + JSON.stringify(cur))
        } catch {
          /* skip */
        }
        return
      }

      // Walk continuation fields.
      if (cur.payload && typeof cur.payload === "object") {
        peelAndPushCalpico(cur.payload, depth + 1)
        return
      }
      if (cur.delta && typeof cur.delta === "object") {
        peelAndPushCalpico(cur.delta, depth + 1)
        return
      }
      if (cur.content && typeof cur.content === "object") {
        peelAndPushCalpico(cur.content, depth + 1)
        return
      }
      if (cur.item && typeof cur.item === "object") {
        peelAndPushCalpico(cur.item, depth + 1)
        return
      }
      // No recognizable continuation — silently drop (reply frames, conversation-created notifications, etc).
    }

    for (const rawLine of raw.split(/\r?\n/)) {
      const s = rawLine.trim()
      if (!s) continue
      if (s.startsWith("data:") || s.startsWith("event:")) {
        normalized.push(s)
        continue
      }
      if (!s.startsWith("{") && !s.startsWith("[")) continue
      try {
        const parsed = JSON.parse(s)

        // Calpico WS frames arrive as top-level arrays. Iterate each entry
        // and recursively walk its envelope, pushing the inner SSE content
        // (encoded_item) directly into the normalized buffer.
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            peelAndPushCalpico(entry)

            // Calpico recovery frames carry a `catchups` array of replayed
            // messages from before the subscription started. Each catchup
            // entry has the same envelope shape as a regular message frame.
            const reply = (entry as any)?.reply
            if (reply && Array.isArray(reply.catchups)) {
              for (const catchup of reply.catchups) {
                peelAndPushCalpico(catchup)
              }
            }
          }
          continue
        }

        const obj: any = parsed

        // Calpico single-frame variant (not in an array).
        if (
          obj?.type === "message" &&
          obj?.payload &&
          typeof obj.payload === "object"
        ) {
          peelAndPushCalpico(obj.payload)
          continue
        }

        // Envelope: {type, body, ...} where body is base64 or pre-decoded SSE
        if (typeof obj?.body === "string") {
          let body: string = obj.body
          if (!body.startsWith("data:") && !body.startsWith("{")) {
            try {
              const decoded = atob(body.replace(/\s+/g, ""))
              // Confirm it looks like printable text (not random binary)
              if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(decoded.slice(0, 32))) {
                body = decoded
              }
            } catch {
              // not base64; leave as-is
            }
          }
          for (const inner of body.split(/\r?\n/)) {
            const t = inner.trim()
            if (t) normalized.push(t)
          }
          continue
        }
        // Envelope: {type, data} with pre-decoded SSE text
        if (typeof obj?.data === "string" && obj.data.length > 0) {
          for (const inner of obj.data.split(/\r?\n/)) {
            const t = inner.trim()
            if (t) normalized.push(t)
          }
          continue
        }
        // Bare frame — synthesize a data: line so the parser below picks it up
        normalized.push("data: " + s)
      } catch {
        normalized.push(s)
      }
    }

    // STRICT path filter — assistant content lives under message.content.parts.
    // Without this filter, any frame with a string `v` field can be appended
    // as answer text, which would falsely capture topic IDs, metadata,
    // status strings, etc.
    const CONTENT_PATH_RE = /\/(content|parts|message)\b|^$|^\/message\b/
    const isContentPath = (p: unknown): boolean =>
      typeof p === "string" && (p === "" || CONTENT_PATH_RE.test(p))

    let bestFromMessage = ""
    let accumulatedDelta = ""
    // Track the most recent content-targeting path. OpenAI's calpico
    // protocol sends the FIRST patch as {p, o, v} but subsequent patches
    // targeting the same path arrive as bare {v: "next token"} with no
    // p or o — they're implicit continuations. Without tracking this,
    // we drop 95%+ of streaming content.
    let lastContentPath: string | null = null

    for (const line of normalized) {
      let s = line.trim()
      if (!s) continue
      if (s.startsWith("data:")) s = s.slice(5).trim()
      if (!s || s === "[DONE]") continue
      if (!s.startsWith("{") && !s.startsWith("[")) continue

      try {
        const obj = JSON.parse(s)

        // Legacy delta shapes
        const delta =
          obj?.delta ??
          obj?.text_delta ??
          obj?.response?.output_text?.delta ??
          obj?.choices?.[0]?.delta?.content
        if (typeof delta === "string") accumulatedDelta += delta

        // Snapshot — only when v is OBJECT-shaped (not a string token).
        // This disambiguates {v: "tok", p: "..."} from {v: {message: {...}}}.
        const snapshotCandidates: unknown[] = [obj?.message]
        if (obj?.v && typeof obj.v === "object" && !Array.isArray(obj.v)) {
          snapshotCandidates.push((obj.v as any).message)
        }
        if (Array.isArray(obj?.v)) {
          snapshotCandidates.push((obj.v[0] as any)?.message)
        }
        for (const msgRaw of snapshotCandidates) {
          const msg = msgRaw as any
          if (!msg || msg.author?.role !== "assistant") continue
          const parts = msg.content?.parts
          if (Array.isArray(parts)) {
            const joined = parts
              .filter((p: unknown) => typeof p === "string")
              .join("")
            if (joined.length > bestFromMessage.length) bestFromMessage = joined
          } else if (typeof msg.content?.text === "string") {
            if (msg.content.text.length > bestFromMessage.length) {
              bestFromMessage = msg.content.text
            }
          }
        }

        // JSON-Patch single op. Three cases:
        //   (A) {v: "tok", p: "/message/content/parts/0", o: "append"}  — first delta
        //   (B) {v: "tok"} — implicit continuation, inherit lastContentPath
        //   (C) {v: <object>, p: "..."} — snapshot, handled above
        //
        // CASE A: explicit path. Validate it's a content path, remember it.
        if (
          typeof obj?.v === "string" &&
          typeof obj?.p === "string" &&
          isContentPath(obj.p) &&
          (obj?.o === "append" || obj?.o === "add" || obj?.o === undefined)
        ) {
          accumulatedDelta += obj.v
          lastContentPath = obj.p
        }
        // CASE B: bare {v: "tok"} with no p/o — implicit continuation of
        // the most recent content patch. This is how 95%+ of streaming
        // tokens arrive in OpenAI's calpico protocol.
        else if (
          typeof obj?.v === "string" &&
          obj?.p === undefined &&
          obj?.o === undefined &&
          lastContentPath !== null
        ) {
          accumulatedDelta += obj.v
        }

        // JSON-Patch batched ops: {v: [{p,o,v}, ...]}
        if (Array.isArray(obj?.v)) {
          for (const subRaw of obj.v) {
            const sub = subRaw as any
            if (!sub || typeof sub !== "object") continue
            if (typeof sub.v !== "string") continue
            if (typeof sub.p === "string" && isContentPath(sub.p)) {
              // Explicit path in this sub-op.
              if (
                sub.o === "append" ||
                sub.o === "add" ||
                sub.o === undefined
              ) {
                accumulatedDelta += sub.v
                lastContentPath = sub.p
              }
            } else if (sub.p === undefined && lastContentPath !== null) {
              // Implicit continuation in batched form.
              accumulatedDelta += sub.v
            }
          }
        }
      } catch {
        // not JSON — skip, never throw
      }
    }

    return (
      bestFromMessage.length >= accumulatedDelta.length
        ? bestFromMessage
        : accumulatedDelta
    ).trim()
  }

  function extractClaude(raw: string): string {
    // Claude streams SSE with event lines like:
    //   event: completion
    //   data: {"type":"completion","completion":"...token..."}
    // Final message arrives as content_block_delta events accumulating
    // text. We accumulate any string field named "completion" or
    // "text" found in data events.
    let acc = ""
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim()
      if (!s.startsWith("data:")) continue
      const body = s.slice(5).trim()
      if (!body || body === "[DONE]") continue
      if (!body.startsWith("{")) continue
      try {
        const obj = JSON.parse(body)
        const c = obj?.completion ?? obj?.delta?.text ?? obj?.text
        if (typeof c === "string") acc += c
      } catch {}
    }
    return acc.trim()
  }

  function extractGemini(raw: string): string {
    // Google's batchexecute responses are )]}'-prefixed line-delimited
    // JSON arrays containing deeply nested escaped JSON strings. We
    // deep-walk and pick the longest plausible assistant text string,
    // filtering obvious-non-text noise.
    //
    // v1.6.1: filter out Gemini 3 Pro / Deep Think THINKING TRACES.
    // When Gemini reasons before answering, the stream contains BOTH
    // the thinking trace AND the final answer as separate strings. The
    // thinking trace is often longer than the answer for moderate
    // problems, so the naive "longest" heuristic picks the wrong one.
    //
    // Thinking traces have a very specific signature:
    //  - Open with first-person progressive: "I'm now...", "I've just...",
    //    "I am considering...", "I'm focusing on..."
    //  - Contain bolded section headers like "Refining the X",
    //    "Verifying the Y", "Validating the Z", "Formalizing the Q"
    //  - Are written as a planning monologue, not an answer
    //
    // Real Gemini answers are declarative, use formal section headers
    // ("State Definition", "Complexity Analysis"), include code blocks
    // and math notation, and do not narrate the model's own process.
    const cleaned = raw.replace(/^\)\]\}'\s*/, "")
    const found: string[] = []
    const walk = (v: unknown, depth: number) => {
      if (depth > 10 || v == null) return
      if (typeof v === "string") {
        const t = v.trim()
        if (t.startsWith("[") || t.startsWith("{")) {
          try {
            walk(JSON.parse(t), depth + 1)
            return
          } catch {}
        }
        if (v.length > 20) found.push(v)
        return
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1)
        return
      }
      if (typeof v === "object") {
        for (const x of Object.values(v as Record<string, unknown>)) {
          walk(x, depth + 1)
        }
      }
    }
    for (const line of cleaned.split(/\r?\n/)) {
      const s = line.trim()
      if (!s || (!s.startsWith("[") && !s.startsWith("{"))) continue
      try {
        walk(JSON.parse(s), 0)
      } catch {}
    }

    // v1.6.1 thinking-trace detector. Returns true if the string is most
    // likely Gemini's internal reasoning monologue rather than a real
    // user-facing answer. Conservative — requires MULTIPLE signals to
    // fire, so real answers that happen to use first-person prose
    // (e.g. a user asked "write me a personal essay") aren't filtered.
    const isThinkingTrace = (s: string): boolean => {
      // Section-header style markers Gemini uses for its planning steps.
      // These are tightly-spaced bold headers like "**Refining the X**",
      // "**Verifying the Y**". A single occurrence is suggestive; two or
      // more is conclusive.
      const sectionHeaderRe =
        /\*?\*?(?:Refining|Verifying|Validating|Formalizing|Analyzing|Considering|Defining|Calculating|Building|Crafting|Examining|Exploring|Reviewing|Reconsidering|Investigating|Pondering|Outlining|Mapping out|Drafting|Constructing|Developing|Generating|Planning|Working on|Working through|Working out|Reflecting on|Thinking about|Zeroing in|Honing|Determining)\s+(?:the|on|a|an|my|this|that|our)\s+\w+/gi
      const sectionMatches = s.match(sectionHeaderRe)
      const sectionHits = sectionMatches ? sectionMatches.length : 0

      // First-person progressive openers. Real answers don't usually
      // start sentences with "I'm now..." / "I've just..." / "I am
      // currently...". Count these as planning-narration signals.
      const planningRe =
        /(?:^|\n|\.\s+)(?:I'm\s+(?:now|currently|focusing|considering|building|developing|going to|trying to|thinking|zeroing|refining|verifying|validating|formalizing)|I've\s+(?:just|now|formalized|run|got|developed|been|reviewed|noticed|considered)|I\s+am\s+(?:now|currently|considering|thinking|going to|trying to|focusing|building|developing))/gi
      const planningMatches = s.match(planningRe)
      const planningHits = planningMatches ? planningMatches.length : 0

      // A real answer for a coding/math task contains code blocks,
      // equation notation, or formal definition language. If the
      // string has ANY of these, never treat it as a thinking trace,
      // even if it happens to mention "I'm considering" once.
      const realAnswerRe =
        /```|def\s+\w+\s*\(|function\s+\w+\s*\(|class\s+\w+|\$\$|\\\(|\\\[|\\begin\{|→\s*\w|::=|≤|≥|⇒|⇐|∀|∃|∈|⊆|theorem|lemma|proof:|return\s+\w+|algorithm:|pseudocode/i
      if (realAnswerRe.test(s)) return false

      // Decision threshold: two or more section-header hits, OR three
      // or more planning-opener hits, OR one of each. This keeps the
      // filter conservative — a single "I'm thinking about X" in an
      // otherwise normal answer won't trigger it.
      return sectionHits >= 2 || planningHits >= 3 || (sectionHits >= 1 && planningHits >= 1)
    }

    let best = ""
    for (const candidate of found) {
      // Filter known noise patterns: URLs, internal service names,
      // request IDs, batchexecute metadata.
      if (/(BardFrontendService|batchexecute|backend-api|request-id|generate-id)/i.test(candidate)) {
        continue
      }
      if (/^https?:\/\//i.test(candidate.trim())) continue
      // Filter base64-looking strings
      if (/^[A-Za-z0-9+/=]+$/.test(candidate) && candidate.length > 50) continue
      // v1.6.1: filter Gemini thinking traces (Deep Think / 3 Pro reasoning)
      if (isThinkingTrace(candidate)) continue
      if (candidate.length > best.length) best = candidate
    }
    return best.trim()
  }

  function extractFor(service: string, raw: string): string {
    let out = ""
    try {
      if (service === "chatgpt") out = extractChatGPT(raw)
      else if (service === "claude") out = extractClaude(raw)
      else if (service === "gemini") out = extractGemini(raw)
      else {
        // Try all extractors and take the longest result.
        const candidates = [
          extractChatGPT(raw),
          extractClaude(raw),
          extractGemini(raw)
        ]
        out = candidates.reduce((a, b) => (b.length > a.length ? b : a), "")
      }
    } catch (e) {
      console.log(`[mixerai/capture] extractor for ${service} threw:`, e)
    }
    return out
  }

  // ----------------------------------------------------------------
  // CHATGPT CONDUIT TOPIC TRACKING
  //
  // OpenAI's 2026 transport: prompt goes to /backend-api/f/conversation
  // which returns a tiny "stream_handoff" message advertising a topic id
  // (conversation-turn-{uuid}) deliverable via WebSocket or resume-SSE.
  // The actual assistant text is delivered over that secondary channel.
  //
  // This block tracks active turns by topic id. The handoff parser
  // extracts topic ids from the fetch body. The WebSocket wrapper routes
  // each frame to the matching turn. Finalization fires ONLY when a frame
  // matches the explicit completion regex — no idle/close fallback. The
  // reasoning: reasoning models pause for 30+ seconds mid-turn, and
  // conduit WebSockets are session-long (one socket multiplexes many
  // turns), so idle or close would emit partial/wrong answers.
  // ----------------------------------------------------------------
  const CHATGPT_TOPIC_RE = /conversation-turn-[0-9a-f-]+/gi
  // Multiple plausible completion-marker patterns. If real frames use a
  // different marker, the diagnostic logs (WS frame[N]) will reveal it
  // and the regex can be tightened in a one-line follow-up.
  // Completion marker for ChatGPT's calpico WS. Earlier versions matched
  // "end_turn":true broadly — but that appears in EVERY system message
  // header (which ChatGPT emits 4-6 of before assistant streaming starts),
  // causing completion to fire ~2 seconds in with only setup frames
  // captured. The fix: match patterns that only appear at REAL turn-end.
  // - "message_stream_complete" is the explicit OpenAI completion event
  // - "is_completion":true is on the final turn-state object
  // - conversation_done is OpenAI's session-close event
  // - "status":"completed" with an "assistant" author nearby (we check
  //   author in the frame matching code, not in the regex)
  const CHATGPT_COMPLETION_RE = /message_stream_complete|"is_completion"\s*:\s*true|conversation_done|\[DONE\]/
  // Secondary check: "end_turn":true is meaningful ONLY when the same
  // frame contains an assistant author marker. System/user/tool messages
  // also carry end_turn but those aren't the turn we care about. Window
  // is large (10000 chars) because some frames carry multiple stream-items
  // packed together and the assistant role marker can be far from the
  // end_turn marker textually.
  const CHATGPT_ASSISTANT_END_RE = /"role":\s*"assistant"[\s\S]{0,10000}?"end_turn":\s*true|"end_turn":\s*true[\s\S]{0,10000}?"role":\s*"assistant"/
  const CHATGPT_TURN_TTL_MS = 10 * 60 * 1000

  interface ChatGPTTurn {
    topicId: string
    startedAt: number
    lastFrameAt: number
    rawFrames: string[]
    done: boolean
    // True once a frame containing "role":"assistant" has been seen on
    // this turn. Used to filter out false completion-marker matches in
    // the very first system/user setup frames (which carry end_turn:true).
    assistantSeen: boolean
  }

  const chatgptTurns = new Map<string, ChatGPTTurn>()
  let lastChatGPTTopicId: string | null = null

  // Hard floor on number of frames required to finalize. The first ~6-8
  // frames are always system/user setup. Real assistant streaming
  // produces dozens of frames. Refuse to finalize on fewer than this.
  const CHATGPT_MIN_FRAMES_TO_FINALIZE = 10

  function pruneChatGPTTurns() {
    const cutoff = Date.now() - CHATGPT_TURN_TTL_MS
    for (const [id, turn] of chatgptTurns) {
      if (turn.lastFrameAt < cutoff) chatgptTurns.delete(id)
    }
  }

  function getOrCreateChatGPTTurn(topicId: string): ChatGPTTurn {
    let t = chatgptTurns.get(topicId)
    if (!t) {
      t = {
        topicId,
        startedAt: Date.now(),
        lastFrameAt: Date.now(),
        rawFrames: [],
        done: false,
        assistantSeen: false
      }
      chatgptTurns.set(topicId, t)
    }
    t.lastFrameAt = Date.now()
    lastChatGPTTopicId = topicId
    return t
  }

  function rememberChatGPTHandoff(raw: string, url: string) {
    const matches = raw.match(CHATGPT_TOPIC_RE)
    if (!matches || matches.length === 0) return
    const topics = new Set(matches)
    for (const id of topics) getOrCreateChatGPTTurn(id)
    console.log(
      `[mixerai/capture] chatgpt: remembered topic(s) ${[...topics].join(", ")} url=${url.slice(0, 120)}`
    )
  }

  function finalizeChatGPTTurn(turn: ChatGPTTurn, reason: string) {
    if (turn.done || turn.rawFrames.length === 0) return
    const raw = turn.rawFrames.join("\n")
    const text = extractChatGPT(raw)
    console.log(
      `[mixerai/capture] chatgpt: WS ${reason} topic=${turn.topicId} frames=${turn.rawFrames.length} rawLen=${raw.length} extractedLen=${text.length}`
    )
    // Diagnostic: when extraction yields nothing, dump three sample frames
    // at full length so the actual content path can be identified from logs.
    // This is the only way to learn the real envelope shape without devtools
    // breakpoints on the page.
    if (text.length === 0 && turn.rawFrames.length > 0) {
      const samples = [
        turn.rawFrames[0],
        turn.rawFrames[Math.floor(turn.rawFrames.length / 2)],
        turn.rawFrames[turn.rawFrames.length - 1]
      ]
      for (let i = 0; i < samples.length; i++) {
        console.log(
          `[mixerai/capture] chatgpt: WS extraction-failed sample[${i}] len=${samples[i].length} full=`,
          samples[i]
        )
      }
    }
    if (text.length >= MIN_CAPTURE_TEXT_CHARS) {
      turn.done = true
      if (record("chatgpt", `ws:${turn.topicId}`, text)) {
        fireWake()
        setTimeout(fireWake, 250)
      }
    }
  }

  function handleChatGPTWebSocketFrame(frame: string) {
    pruneChatGPTTurns()
    const topicMatches = frame.match(CHATGPT_TOPIC_RE)
    const targets: ChatGPTTurn[] = []
    if (topicMatches && topicMatches.length > 0) {
      const seen = new Set(topicMatches)
      for (const id of seen) targets.push(getOrCreateChatGPTTurn(id))
    } else if (lastChatGPTTopicId) {
      const t = chatgptTurns.get(lastChatGPTTopicId)
      if (t && !t.done) targets.push(t)
    }
    if (targets.length === 0) return

    // Track whether THIS frame mentions an assistant author role. We only
    // allow completion to fire after at least one assistant frame has
    // been seen — this prevents system/user header frames (which carry
    // their own "end_turn":true markers) from triggering false completion.
    const frameHasAssistant = /"role":\s*"assistant"/.test(frame)

    for (const turn of targets) {
      if (turn.done) continue
      const wasAssistantSeen = turn.assistantSeen
      turn.rawFrames.push(frame)
      turn.lastFrameAt = Date.now()
      if (frameHasAssistant) turn.assistantSeen = true

      // Diagnostic: log first time assistant content appears in stream,
      // and at frame-count milestones, so we can see what's happening
      // without dumping every frame.
      if (!wasAssistantSeen && turn.assistantSeen) {
        console.log(
          `[mixerai/capture] chatgpt: assistantSeen=TRUE frame#${turn.rawFrames.length} topic=${turn.topicId}`
        )
      }
      if (
        turn.rawFrames.length === 10 ||
        turn.rawFrames.length === 20 ||
        turn.rawFrames.length === 40 ||
        turn.rawFrames.length === 80
      ) {
        console.log(
          `[mixerai/capture] chatgpt: progress frames=${turn.rawFrames.length} assistantSeen=${turn.assistantSeen}`
        )
      }

      // 8MB per-turn cap; drop oldest frames if exceeded.
      let total = 0
      for (const f of turn.rawFrames) total += f.length
      while (turn.rawFrames.length > 1 && total > 8_000_000) {
        total -= turn.rawFrames[0].length
        turn.rawFrames.shift()
      }

      // Completion check. Two ways to declare done:
      //   1. A strict OpenAI marker (message_stream_complete, [DONE],
      //      conversation_done, "is_completion":true) in any frame.
      //   2. An "end_turn":true frame AFTER assistant content has begun
      //      arriving (assistantSeen=true and frames>=10). System/user
      //      setup frames also have end_turn:true but happen BEFORE
      //      assistant streaming, so the assistantSeen gate filters them.
      const frameHasEndTurn = /"end_turn":\s*true/.test(frame)
      const isDone =
        CHATGPT_COMPLETION_RE.test(frame) ||
        (turn.assistantSeen &&
          frameHasEndTurn &&
          turn.rawFrames.length >= CHATGPT_MIN_FRAMES_TO_FINALIZE)

      if (isDone) {
        // Small tail delay to catch trailing frames in the same microtask
        // burst (offset confirmations, server-close acks). This is the
        // same model that worked in v1.5.4 — no complicated idle timers
        // or sticky flags; if a real completion marker hit, we finalize
        // after a brief wait.
        setTimeout(() => finalizeChatGPTTurn(turn, "completion-marker"), 250)
      }
    }
  }

  // ----------------------------------------------------------------
  // FETCH WRAPPER
  // ----------------------------------------------------------------
  const origFetch = window.fetch
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request)?.url ?? ""
    const matched = matchesStreamUrl(url)
    const promise = origFetch.call(this, input as any, init)
    if (!matched) return promise
    return promise.then((response) => {
      if (!response || !response.body) {
        console.log(
          `[mixerai/capture] ${matched}: fetch matched but no body, url=${url.slice(0, 100)}`
        )
        return response
      }
      let observed: ReadableStream<Uint8Array>
      let returned: ReadableStream<Uint8Array>
      try {
        const [a, b] = response.body.tee()
        observed = a
        returned = b
      } catch (e) {
        console.log(
          `[mixerai/capture] ${matched}: tee() failed, falling through:`,
          e
        )
        return response
      }
      ;(async () => {
        const reader = observed.getReader()
        const dec = new TextDecoder()
        let raw = ""
        const CAP = 5_000_000
        const startedAt = Date.now()
        // v1.6.8: mark a Claude answer stream as in-flight while we read it.
        // Balanced by the decrement in the `finally` below, which runs even
        // if the reader throws — so the counter can't leak and hang the loop.
        // Scoped to Claude so other services' finalize paths are untouched.
        const tracksOpen = matched === "claude"
        if (tracksOpen) {
          openClaudeStreams++
          lastClaudeStreamOpenAt = Date.now()
          stampStreamState()
        }
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            raw += dec.decode(value, { stream: true })
            if (raw.length > CAP) raw = raw.slice(-CAP)
          }
          raw += dec.decode()
        } catch (e) {
          console.log(
            `[mixerai/capture] ${matched}: reader threw mid-stream:`,
            e
          )
        } finally {
          try {
            reader.releaseLock()
          } catch {}
          if (tracksOpen) {
            openClaudeStreams = Math.max(0, openClaudeStreams - 1)
            stampStreamState()
          }
        }
        const elapsed = Date.now() - startedAt
        // ChatGPT handoffs declare topic ids that the WebSocket wrapper
        // routes frames to. Remember them before extraction so the WS
        // path is primed even if the handoff body itself extracts to "".
        if (matched === "chatgpt") {
          rememberChatGPTHandoff(raw, url)
        }
        const text = extractFor(matched, raw)
        console.log(
          `[mixerai/capture] ${matched}: stream closed elapsed=${elapsed}ms rawLen=${raw.length} extractedLen=${text.length}`
        )
        if (record(matched, url, text)) {
          fireWake()
          // Second wake at +250ms — covers cases where the action toolbar
          // (Claude's Retry/Copy buttons, ChatGPT's Regenerate) attaches
          // in a microtask after the stream closes.
          setTimeout(fireWake, 250)
        }
      })()
      return new Response(returned, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    })
  } as typeof window.fetch

  // ----------------------------------------------------------------
  // EVENTSOURCE WRAPPER (rare in 2026 for these apps, kept for safety)
  // ----------------------------------------------------------------
  if (window.EventSource) {
    const OrigES = window.EventSource
    const Wrapped = function (url: string | URL, init?: EventSourceInit) {
      const es = new OrigES(url, init)
      const u = String(url)
      const matched = matchesStreamUrl(u)
      if (matched) {
        let buf = ""
        es.addEventListener("message", (ev: MessageEvent) => {
          buf += `data: ${String(ev.data)}\n`
          if (String(ev.data).includes("[DONE]")) {
            const text = extractFor(matched, buf)
            console.log(
              `[mixerai/capture] ${matched}: EventSource [DONE] rawLen=${buf.length} extractedLen=${text.length}`
            )
            if (record(matched, u, text)) fireWake()
          }
        })
      }
      return es
    } as unknown as typeof EventSource
    Wrapped.prototype = OrigES.prototype
    window.EventSource = Wrapped
  }

  // ----------------------------------------------------------------
  // WEBSOCKET WRAPPER
  //
  // Working assumption: ChatGPT delivers assistant tokens over a
  // long-lived WebSocket addressed by turn_topic_id (per the handoff
  // message from /backend-api/f/conversation).
  //
  // The wrapper logs the first 8 frames of each WebSocket opened on
  // chatgpt.com so the envelope format can be verified in DevTools.
  // Routing of frames to turns is by topic id from the handoff —
  // see CHATGPT CONDUIT TOPIC TRACKING section above.
  //
  // Only chatgpt.com is wrapped. Other AI domains don't use WebSocket
  // streaming today; wrapping them globally would add noise without
  // benefit and risk regressions on non-streaming WS uses (presence,
  // typing indicators, file uploads).
  //
  // TIMING CAVEAT: this MAIN-world script runs at document_start. For
  // tabs the orchestrator opens via chrome.tabs.create(), the wrapper
  // installs before the page's own JS — fine. For tabs the user opened
  // manually before installing the extension, an already-open session
  // WebSocket won't be wrapped; a reload puts the wrapper ahead of any
  // new WS. This is a real corner case but doesn't affect the normal
  // product flow where ensureTabsExist() opens AI tabs as needed.
  // ----------------------------------------------------------------
  if (typeof WebSocket !== "undefined") {
    const OrigWS = window.WebSocket

    const WrappedWS = function (url: string | URL, protocols?: string | string[]) {
      const urlStr = String(url)
      const ws =
        protocols !== undefined
          ? new OrigWS(urlStr, protocols)
          : new OrigWS(urlStr)

      // Only instrument ChatGPT.
      if (myService !== "chatgpt") return ws

      console.log(
        `[mixerai/capture] chatgpt: WS opened url=${urlStr.slice(0, 160)}`
      )

      let frameLogCount = 0
      const FRAME_LOG_MAX = 40
      const FRAME_LOG_CHARS = 600

      const onText = (frame: string) => {
        if (frameLogCount < FRAME_LOG_MAX) {
          frameLogCount++
          console.log(
            `[mixerai/capture] chatgpt: WS frame[${frameLogCount}] ${frame.slice(0, FRAME_LOG_CHARS)}`
          )
          // Also dump the keys inside the deepest payload so we can see the
          // actual content field names even when the frame text is truncated.
          try {
            const parsed = JSON.parse(frame)
            const first = Array.isArray(parsed) ? parsed[0] : parsed
            const inner =
              first?.payload?.payload ??
              first?.payload ??
              first
            const keys =
              inner && typeof inner === "object" ? Object.keys(inner) : []
            const peek: Record<string, string> = {}
            for (const k of keys) {
              const val = (inner as any)[k]
              if (typeof val === "string")
                peek[k] = val.length > 80 ? val.slice(0, 80) + "..." : val
              else if (typeof val === "number" || typeof val === "boolean")
                peek[k] = String(val)
              else if (val === null) peek[k] = "null"
              else if (Array.isArray(val))
                peek[k] = `Array(${val.length})`
              else if (typeof val === "object")
                peek[k] = `Object{${Object.keys(val).slice(0, 5).join(",")}}`
            }
            console.log(
              `[mixerai/capture] chatgpt: WS frame[${frameLogCount}] inner-keys=`,
              peek
            )
          } catch {
            // not JSON or parse failed — already logged the raw above
          }
        }
        handleChatGPTWebSocketFrame(frame)
      }

      ws.addEventListener("message", (ev: MessageEvent) => {
        const d = ev.data
        if (typeof d === "string") {
          onText(d)
        } else if (d instanceof ArrayBuffer) {
          try {
            onText(new TextDecoder().decode(d))
          } catch {}
        } else if (typeof Blob !== "undefined" && d instanceof Blob) {
          d.text().then(onText).catch(() => {})
        }
      })

      return ws
    } as unknown as typeof WebSocket

    // Preserve prototype, statics, and name so `instanceof WebSocket`
    // and `WebSocket.OPEN` continue to work for the page.
    WrappedWS.prototype = OrigWS.prototype
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) {
      try {
        Object.defineProperty(WrappedWS, k, {
          value: (OrigWS as any)[k],
          writable: false,
          configurable: false
        })
      } catch {}
    }
    try {
      Object.defineProperty(WrappedWS, "name", { value: "WebSocket" })
    } catch {}
    window.WebSocket = WrappedWS
  }

  // ----------------------------------------------------------------
  // XHR WRAPPER (used by some Google batchexecute paths)
  // ----------------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    pass?: string | null
  ) {
    ;(this as any).__mixeraiUrl = String(url)
    return origOpen.call(
      this,
      method,
      url,
      async ?? true,
      user ?? null,
      pass ?? null
    )
  }
  XMLHttpRequest.prototype.send = function (body?: any) {
    const xhr = this
    xhr.addEventListener("loadend", () => {
      const url = String((xhr as any).__mixeraiUrl ?? "")
      const matched = matchesStreamUrl(url)
      if (!matched) return
      try {
        const raw = String(xhr.responseText ?? "")
        const text = extractFor(matched, raw)
        console.log(
          `[mixerai/capture] ${matched}: XHR loadend rawLen=${raw.length} extractedLen=${text.length}`
        )
        // GEMINI HEARTBEAT GUARD.
        // Gemini delivers its answer via /batchexecute, but during a
        // single turn it ALSO fires many tiny batchexecute "heartbeat"
        // XHRs (status pings, metadata, partial drafts). Several of
        // those extract to short non-answer strings (observed 26-75
        // chars) and would otherwise be recorded as a completion event,
        // letting the orchestrator's capture-fallback latch a premature
        // "done" and ship 63 chars before the real answer arrives.
        //
        // The real answer is structurally huge: it embeds the assistant
        // turn inside deeply-escaped nested JSON, so its raw payload is
        // 100KB+ (observed 161,464 bytes -> 3,235 extracted), whereas
        // every heartbeat is under ~3.3KB raw. Require a substantial raw
        // payload OR a substantial extraction before a Gemini XHR counts
        // as a completion. This is a clean ~50x discriminator and only
        // affects Gemini — ChatGPT (WebSocket) and Claude
        // (fetch stream) never reach this XHR path.
        if (matched === "gemini" && raw.length < 5000 && text.length < 250) {
          return
        }
        if (record(matched, url, text)) fireWake()
      } catch (e) {
        console.log(`[mixerai/capture] ${matched}: XHR handler threw:`, e)
      }
    })
    return origSend.call(this, body)
  }

  console.log(
    `[mixerai/capture] installed for service=${myService} ` +
      `host=${currentHost} ` +
      `document.hidden=${document.hidden} ` +
      `visibilityState=${document.visibilityState}`
  )
})()
