import type {
  AdapterResponse,
  AIService,
  AuthState,
  ServiceStatus
} from "./types"

/** Find first element whose aria-label matches the given pattern. */
export function findByAriaLabel(pattern: RegExp): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>("[aria-label]")
  for (const el of elements) {
    if (pattern.test(el.getAttribute("aria-label") ?? "")) return el
  }
  return null
}

/**
 * Find a leaf-ish element whose own direct text (not descendants') matches.
 * Avoids matching the body element that contains "Sign in" somewhere deep.
 */
export function findByText(
  pattern: RegExp,
  tags: string[] = ["button", "a", "span", "div"]
): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(tags.join(","))
  for (const el of elements) {
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join("")
      .trim()
    if (directText && pattern.test(directText)) return el
  }
  return null
}

export function debounce<F extends (...args: any[]) => any>(
  fn: F,
  ms: number
): F {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), ms)
  }) as F
}

/** Send a status update to the service worker, with one retry if asleep. */
export function reportStatus(
  service: AIService,
  authState: AuthState,
  notes?: string
) {
  const status: ServiceStatus = {
    service,
    authState,
    detectedAt: Date.now(),
    url: location.href,
    notes
  }
  const send = () =>
    chrome.runtime
      .sendMessage({ type: "AUTH_STATE_UPDATE", payload: status })
      .catch(() => {})

  send()
  setTimeout(send, 500)
}

/**
 * Install monitoring + message handlers for an AI service content script.
 *
 * - Watches the DOM for sign-in/out transitions
 * - Responds to CHECK_AUTH polls from the background
 * - If `sendPrompt` is provided, also responds to SEND_PROMPT dispatches
 *
 * HMR-safe: when Plasmo hot-reloads this content script, the previous module
 * instance is torn down but its registered chrome.runtime.onMessage listener
 * remains alive. Without protection, multiple listeners would accumulate
 * across reloads and all claim async response — when an old (stale-closure)
 * listener fails to call sendResponse before its channel closes, Chrome
 * reports: "A listener indicated an asynchronous response by returning true,
 * but the message channel closed before a response was received."
 *
 * Fix: stash a single mutable handler on window and install the listener +
 * DOM observers exactly once per tab. HMR reloads just refresh the handler
 * pointer; the long-lived listener always dispatches to the current module's
 * sendPrompt / detect functions.
 */
interface MixerHandler {
  service: AIService
  detect: () => AuthState
  sendPrompt?: (
    prompt: string,
    onProgress?: (textLen: number) => void
  ) => Promise<string>
  lastReported: AuthState | null
}

interface CachedResult {
  /** Monotonically-increasing request ID assigned by the SW. */
  requestId: number
  /** The captured response text from the AI, or null if the run errored. */
  text: string | null
  /** Error message if text is null. */
  error: string | null
  /** Wall-clock time the result was cached, ms since epoch. */
  cachedAt: number
}

interface MixerGlobals {
  handler: MixerHandler
  listenerInstalled: boolean
  portListenerInstalled: boolean
  domObserverInstalled: boolean
  /**
   * Recent SEND_PROMPT results cached so the orchestrator can re-fetch them
   * if the original port delivery failed (port disconnect, SW eviction race,
   * postMessage on a half-closed channel, etc). Capped at the most recent
   * 8 results per tab and aged out after 5 minutes.
   */
  recentResults: CachedResult[]
}

declare global {
  interface Window {
    __mixerai?: MixerGlobals
  }
}

function installMessageListenerOnce() {
  if (!window.__mixerai || window.__mixerai.listenerInstalled) return
  window.__mixerai.listenerInstalled = true

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const h = window.__mixerai?.handler
    if (!h) return false

    if (msg?.type === "CHECK_AUTH") {
      sendResponse({
        service: h.service,
        authState: h.detect(),
        detectedAt: Date.now(),
        url: location.href
      } satisfies ServiceStatus)
      // Synchronous response complete — return false so Chrome doesn't keep
      // the channel open expecting more.
      return false
    }

    // SEND_PROMPT is handled via the long-lived port (see installPortListenerOnce
    // below) — one-shot message channels can close mid-flight on long waits.
    return false
  })
}

/**
 * Long-lived port listener for SEND_PROMPT dispatches. Ports stay open as
 * long as both ends are alive, avoiding the implicit channel timeout that
 * caused chrome.tabs.sendMessage to fail for multi-minute DeepThink waits.
 *
 * The handler reads `window.__mixerai.handler` dynamically so an HMR reload
 * (which swaps the handler reference) doesn't strand in-flight requests.
 */
function installPortListenerOnce() {
  if (!window.__mixerai || window.__mixerai.portListenerInstalled) return
  window.__mixerai.portListenerInstalled = true

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "mixerai-send-prompt") return

    let active = true
    port.onDisconnect.addListener(() => {
      active = false
      console.log(
        `[MixerAI/cs] port disconnected (active was true, now false)`
      )
    })

    port.onMessage.addListener(async (msg) => {
      const h = window.__mixerai?.handler
      if (msg?.type !== "SEND_PROMPT" || !h?.sendPrompt) return

      // requestId is assigned by the SW. If absent (legacy), use timestamp.
      const requestId: number =
        typeof msg.requestId === "number" ? msg.requestId : Date.now()
      console.log(
        `[MixerAI/cs] SEND_PROMPT received requestId=${requestId} promptLen=${msg.prompt?.length ?? 0}`
      )

      const cacheResult = (text: string | null, error: string | null) => {
        const g = window.__mixerai
        if (!g) return
        // Age out anything older than 5 minutes, then prune to 8 most recent
        const cutoff = Date.now() - 5 * 60 * 1000
        g.recentResults = g.recentResults
          .filter((r) => r.cachedAt > cutoff)
          .slice(-7)
        g.recentResults.push({
          requestId,
          text,
          error,
          cachedAt: Date.now()
        })
        console.log(
          `[MixerAI/cs] cached result requestId=${requestId} textLen=${text?.length ?? 0} error=${error ?? "null"} cacheSize=${g.recentResults.length}`
        )
      }

      try {
        const onProgress = (textLen: number) => {
          if (!active) return
          try {
            port.postMessage({
              type: "PROGRESS",
              requestId,
              textLen
            })
          } catch {
            // port may have died between our `active` check and this post;
            // not fatal — orchestrator's keep-warm covers this case
          }
        }
        const text = await h.sendPrompt(msg.prompt, onProgress)
        // Cache FIRST, then try to deliver. Cache is the source of truth —
        // if port.postMessage fails, the orchestrator can still recover via
        // chrome.tabs.sendMessage GET_CACHED_RESULT.
        cacheResult(text, null)
        if (!active) {
          console.log(
            `[MixerAI/cs] port already disconnected — RESULT not posted, but cached for recovery requestId=${requestId}`
          )
          return
        }
        try {
          port.postMessage({ type: "RESULT", ok: true, text, requestId })
          console.log(
            `[MixerAI/cs] posted RESULT.ok requestId=${requestId} textLen=${text.length}`
          )
        } catch (postErr) {
          console.log(
            `[MixerAI/cs] port.postMessage threw — result still cached for recovery: ${
              postErr instanceof Error ? postErr.message : String(postErr)
            }`
          )
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        cacheResult(null, errMsg)
        if (!active) {
          console.log(
            `[MixerAI/cs] port already disconnected — ERROR not posted, but cached for recovery requestId=${requestId}`
          )
          return
        }
        try {
          port.postMessage({
            type: "RESULT",
            ok: false,
            error: errMsg,
            requestId
          })
        } catch {
          // Cached above; orchestrator can recover
        }
      }
    })
  })

  // One-shot recovery handler: orchestrator calls chrome.tabs.sendMessage
  // with { type: "GET_CACHED_RESULT", requestId } if the port-based delivery
  // failed. We look up the cached result and return it synchronously.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "GET_CACHED_RESULT") return
    const g = window.__mixerai
    if (!g) {
      sendResponse({ found: false, reason: "no-mixerai-global" })
      return
    }
    const requestId: number = msg.requestId
    const hit = g.recentResults.find((r) => r.requestId === requestId)
    if (!hit) {
      console.log(
        `[MixerAI/cs] GET_CACHED_RESULT requestId=${requestId} → MISS (cache has ${g.recentResults.length} entries)`
      )
      sendResponse({ found: false, reason: "not-in-cache" })
      return
    }
    console.log(
      `[MixerAI/cs] GET_CACHED_RESULT requestId=${requestId} → HIT (textLen=${hit.text?.length ?? 0} error=${hit.error ?? "null"})`
    )
    sendResponse({
      found: true,
      text: hit.text,
      error: hit.error
    })
  })
}

function installDomObserverOnce() {
  if (!window.__mixerai || window.__mixerai.domObserverInstalled) return
  window.__mixerai.domObserverInstalled = true

  const checkAndMaybeReport = () => {
    const h = window.__mixerai?.handler
    if (!h) return
    const state = h.detect()
    if (state !== h.lastReported) {
      h.lastReported = state
      reportStatus(h.service, state)
    }
  }
  const debounced = debounce(checkAndMaybeReport, 400)

  setTimeout(debounced, 800)

  const origPush = history.pushState
  history.pushState = function (...args) {
    origPush.apply(this, args as any)
    debounced()
  }
  window.addEventListener("popstate", debounced)

  const observer = new MutationObserver(debounced)
  observer.observe(document.body, { childList: true, subtree: true })
}

export function installMonitor(
  service: AIService,
  detect: () => AuthState,
  sendPrompt?: (
    prompt: string,
    onProgress?: (textLen: number) => void
  ) => Promise<string>
) {
  const newHandler: MixerHandler = {
    service,
    detect,
    sendPrompt,
    // Preserve last-reported state across HMR reloads so we don't re-emit
    // the same authState immediately after every code change.
    lastReported: window.__mixerai?.handler?.lastReported ?? null
  }

  if (!window.__mixerai) {
    window.__mixerai = {
      handler: newHandler,
      listenerInstalled: false,
      portListenerInstalled: false,
      domObserverInstalled: false,
      recentResults: []
    }
  } else {
    // HMR reload — swap in the new handler. The single listener registered
    // earlier will use this fresh reference on every incoming message.
    window.__mixerai.handler = newHandler
    // Preserve recentResults across HMR (don't clobber an in-flight cache)
    if (!window.__mixerai.recentResults) {
      window.__mixerai.recentResults = []
    }
  }

  installMessageListenerOnce()
  installPortListenerOnce()
  installDomObserverOnce()
}
