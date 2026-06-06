/**
 * Backend-capture client (ISOLATED world).
 *
 * The MAIN-world page script `contents/backend-capture-page.ts` writes
 * captured stream completion events into a hidden <meta> tag's content
 * attribute as JSON. Content scripts in the ISOLATED world (where Plasmo's
 * default content scripts live, including our adapters) cannot read
 * MAIN-world JS variables directly — Chrome enforces a strict world
 * boundary. But both worlds share the same DOM, so we use the DOM as
 * the bridge.
 *
 * What the MAIN-world script writes:
 *   - `<html data-mixerai-backend-done-at="…">` — Unix-ms timestamp of
 *     the latest event. Cheap to check; we read this first to decide
 *     whether anything new has happened since the floor.
 *   - `<meta id="mixerai-backend-store" name="mixerai-backend-store"
 *           content="{json}">` — payload containing the latest event
 *     fields AND an `events[]` array of recent events.
 *
 * We use a <meta> rather than a <script> tag because Gemini's Trusted
 * Types CSP blocks `textContent` assignment on <script> elements.
 * <meta> content is inert and unrestricted.
 *
 * What this helper does:
 *   - `getBackendCaptureSince(floorMs)`: returns the best captured event
 *     with `doneAt >= floorMs`, or null. The polling loop in
 *     `lib/make-adapter.ts` calls this on every iteration when
 *     `backendCapture` is enabled.
 *
 * SELECTION LOGIC: when `events[]` is present, filter to events with
 * `doneAt >= floorMs` AND `rawText.length >= 20`, then pick the LONGEST.
 * Length wins because mid-stream partial events are necessarily shorter
 * than the final extraction; for Gemini specifically this surfaces the
 * big batchexecute answer instead of a small follow-up XHR. The floorMs
 * gate prevents cross-request leakage — each request's polling loop
 * passes its own `captureSince` and only sees events from this turn.
 *
 * Defensive throughout: any parse error, missing node, or malformed
 * payload returns null. The adapter's DOM-based completion paths
 * continue to function whether or not the capture is available.
 */

export interface BackendCaptureEvent {
  doneAt: number
  url: string
  rawText: string
  service: string
}

function isEvent(v: unknown): v is BackendCaptureEvent {
  if (!v || typeof v !== "object") return false
  const p = v as Record<string, unknown>
  return (
    typeof p.doneAt === "number" &&
    Number.isFinite(p.doneAt) &&
    typeof p.url === "string" &&
    typeof p.rawText === "string" &&
    typeof p.service === "string"
  )
}

/**
 * Read the best backend-stream completion observed since `floorMs`.
 * "Best" means: among events with doneAt >= floorMs and text length >= 20,
 * the LONGEST event. Ties broken by most-recent. Returns null if nothing
 * qualifies.
 */
export function getBackendCaptureSince(
  floorMs: number
): BackendCaptureEvent | null {
  try {
    const root = document.documentElement
    const tsAttr = root?.getAttribute("data-mixerai-backend-done-at")
    if (!tsAttr) return null
    const latestDoneAt = Number(tsAttr)
    if (!Number.isFinite(latestDoneAt) || latestDoneAt < floorMs) return null

    const store = document.getElementById("mixerai-backend-store")
    if (!store) return null
    // <meta> uses `content` attribute. Fall back to textContent for any
    // in-flight page that still has the old <script>-based store node.
    const raw = store.getAttribute("content") ?? store.textContent
    if (!raw) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== "object") return null
    const p = parsed as Record<string, unknown>

    // PREFERRED PATH: events[] array. Filter by this request's floorMs
    // (prevents cross-request leakage) and minimum text length (rejects
    // tiny partial captures), then take the longest. Length wins because
    // partial mid-stream events are shorter than the final extraction;
    // for Gemini this picks the big 260KB batchexecute over small
    // follow-up XHRs.
    if (Array.isArray(p.events)) {
      const candidates = p.events
        .filter(isEvent)
        .filter(
          (ev) => ev.doneAt >= floorMs && ev.rawText.trim().length >= 20
        )
      if (candidates.length > 0) {
        candidates.sort((a, b) => {
          const lenDiff = b.rawText.length - a.rawText.length
          return lenDiff !== 0 ? lenDiff : b.doneAt - a.doneAt
        })
        return candidates[0]
      }
    }

    // BACKWARD-COMPAT: single-event shape (no events[] present). Used
    // when an older MAIN-world script is still running in a tab that
    // existed before this build.
    if (
      isEvent(parsed) &&
      parsed.doneAt >= floorMs &&
      parsed.rawText.trim().length >= 20
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Read the live open-stream state stamped by the MAIN-world capture page.
 * Returns the number of Claude answer streams currently in flight and the
 * Unix-ms timestamp of the most recent stream open.
 *
 * The polling loop uses this to (a) refuse to finalize a turn while a Claude
 * stream is still streaming, and (b) reject a capture that a newer stream has
 * already superseded (the short-interim-stream case).
 *
 * Defensive by design: if the attributes are absent — the capture page hasn't
 * loaded, or this is a non-Claude tab where they're never written — it returns
 * {openStreams: 0, lastOpenAt: 0}, which makes every caller behave EXACTLY as
 * it did before this signal existed.
 */
export function getCaptureStreamState(): {
  openStreams: number
  lastOpenAt: number
} {
  try {
    const root = document.documentElement
    const openAttr = root?.getAttribute("data-mixerai-open-streams")
    const lastAttr = root?.getAttribute("data-mixerai-last-open-at")
    const open = openAttr ? Number(openAttr) : 0
    const last = lastAttr ? Number(lastAttr) : 0
    return {
      openStreams: Number.isFinite(open) && open > 0 ? open : 0,
      lastOpenAt: Number.isFinite(last) && last > 0 ? last : 0
    }
  } catch {
    return { openStreams: 0, lastOpenAt: 0 }
  }
}
