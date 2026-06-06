/**
 * Poll `check` until it returns a truthy value or the timeout expires.
 * Returns the truthy value. The optional `label` is used in the timeout
 * error message so failures are diagnosable from the UI.
 */
export function waitFor<T>(
  check: () => T | null | undefined | false,
  timeoutMs = 30_000,
  label?: string,
  pollMs = 100
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      try {
        const result = check()
        if (result) return resolve(result as T)
        if (Date.now() - start > timeoutMs) {
          const detail = label ? ` (${label})` : ""
          return reject(
            new Error(`Timed out after ${timeoutMs}ms${detail}`)
          )
        }
        setTimeout(tick, pollMs)
      } catch (e) {
        reject(e)
      }
    }
    tick()
  })
}

/**
 * Poll `check` until it returns a falsy value (i.e. the element disappears).
 * Useful for "wait until stop button is gone" = "streaming finished".
 */
export function waitForAbsent(
  check: () => unknown,
  timeoutMs = 240_000,
  label?: string,
  pollMs = 250
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      try {
        if (!check()) return resolve()
        if (Date.now() - start > timeoutMs) {
          const detail = label ? ` (${label})` : ""
          return reject(
            new Error(`Still present after ${timeoutMs}ms${detail}`)
          )
        }
        setTimeout(tick, pollMs)
      } catch (e) {
        reject(e)
      }
    }
    tick()
  })
}

/**
 * Poll `check` and resolve only after it has returned falsy CONTINUOUSLY
 * for `confirmMs`. Stricter than waitForAbsent (which fires on the first
 * falsy poll) — designed for stream indicators that briefly disappear
 * during phase transitions (e.g. Claude switching from thinking to
 * response, or between tool calls). A brief blip resets the counter; only
 * a sustained absence resolves.
 *
 * Used AFTER a "wait for present first" gate, so we know the indicator
 * was actually streaming-related and not just absent at startup.
 */
export function waitForSustainedAbsent(
  check: () => unknown,
  confirmMs = 5000,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 300,
  label?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let firstAbsentAt: number | null = null
    const tick = () => {
      try {
        const present = !!check()
        if (!present) {
          if (firstAbsentAt === null) firstAbsentAt = Date.now()
          if (Date.now() - firstAbsentAt >= confirmMs) return resolve()
        } else {
          firstAbsentAt = null
        }
        if (Date.now() - start > timeoutMs) {
          const detail = label ? ` (${label})` : ""
          return reject(
            new Error(
              `Never sustained-absent for ${confirmMs}ms within ${timeoutMs}ms${detail}`
            )
          )
        }
        setTimeout(tick, pollMs)
      } catch (e) {
        reject(e)
      }
    }
    tick()
  })
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms))

/**
 * Check if an element is actually visible to the user. Used to filter out
 * persistent hidden DOM elements (e.g. a "Cancel" button buried in a closed
 * modal) that would otherwise match selectors and trick the adapter into
 * thinking streaming is still in progress.
 *
 * Uses getComputedStyle so class-based hiding (CSS rules, not just inline
 * style) is detected — `el.style.display` would miss those.
 */
export function isElementVisible(el: Element | null | undefined): boolean {
  if (!el) return false
  if (el instanceof HTMLElement) {
    if (el.hidden) return false
    const cs = window.getComputedStyle(el)
    if (cs.display === "none") return false
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false
    if (parseFloat(cs.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    // offsetParent is null when an ancestor has display:none. Body itself
    // has no offsetParent but is always visible if reached.
    if (el.offsetParent === null && el.tagName !== "BODY") return false
  }
  return true
}

/**
 * Wait until `getText()` stops growing — the universal "response is done"
 * signal for streaming chat UIs. We require multiple growth events (not just
 * one) so a brief "Thinking..." placeholder appearing doesn't fool us into
 * thinking the response is complete.
 *
 * Critically: empty text is NEVER considered stable. If the selectors don't
 * find any response yet (e.g. while DeepSeek is in DeepThink mode and the
 * answer hasn't started rendering into the captured container), we keep
 * waiting rather than incorrectly declaring success-with-empty-result.
 */
export async function waitForStableText(
  getText: () => string,
  stableMs = 6000,
  timeoutMs = 300_000,
  pollMs = 400,
  label?: string
): Promise<void> {
  // Real streaming has many token updates. A short placeholder appearing
  // and then sitting still is ONE growth event — not enough to declare done.
  const MIN_GROWTH_EVENTS = 4

  const start = Date.now()
  let lastText = getText() ?? ""
  let growthEvents = 0
  let lastChangeAt = Date.now()

  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs)
    const currentText = getText() ?? ""
    if (currentText !== lastText) {
      // Only GROWTH counts as "still streaming". A streaming chat response
      // only ever adds tokens — it never shrinks. So if length didn't
      // increase, the diff is from post-render artifacts (KaTeX/MathJax
      // re-rendering, action-button hover states, lazy-loaded UI bits, etc.)
      // and shouldn't keep us waiting forever.
      if (currentText.length > lastText.length) {
        growthEvents++
        lastChangeAt = Date.now()
      }
      lastText = currentText
    } else if (
      growthEvents >= MIN_GROWTH_EVENTS &&
      Date.now() - lastChangeAt > stableMs &&
      currentText.trim().length > 0
    ) {
      return
    }
  }
  const detail = label ? ` (${label})` : ""
  throw new Error(
    `Response text never stabilized after ${timeoutMs}ms${detail}`
  )
}

/**
 * Insert text into a contenteditable element so React picks it up.
 * Plain `el.textContent = "..."` does NOT trigger React state updates.
 *
 * MULTI-LINE HANDLING (matters!): some contenteditables — notably Gemini's
 * `<rich-textarea>` — have a keydown handler bound to Enter that submits
 * the form. If we pass a multi-line string directly to
 * `document.execCommand("insertText", ..., text)`, the embedded `\n`
 * synthesizes an Enter keypress that fires the submit handler. The result:
 * only the FIRST line of the prompt lands in the input, and the message
 * gets sent prematurely.
 *
 * The fix is to split on `\n` and insert each line separately, using
 * `insertLineBreak` (which produces `<br>` and does NOT fire submit) between
 * lines. This is also safe for ChatGPT/Claude — `insertLineBreak`
 * is a standard contenteditable command that all of them honor.
 */
/**
 * For large prompts, the per-line execCommand approach above is too slow.
 * A 100KB prompt with 3000 newlines results in 6000 execCommand calls,
 * each of which fires a synthetic React input event. The cumulative
 * reconciliation cost can block the main thread for 30+ seconds AND
 * leave the page in an inconsistent state where the send button is
 * stuck in disabled/intermediate appearance, so our click fails silently.
 *
 * Threshold: anything over 8KB or 200 newlines uses bulk-paste. Below
 * that, the line-by-line path is fine and has better React compatibility
 * with some edge-case input components.
 */
const BULK_PASTE_CHAR_THRESHOLD = 8_000
const BULK_PASTE_NEWLINE_THRESHOLD = 200

function pasteIntoContentEditable(el: HTMLElement, text: string): boolean {
  try {
    el.focus()

    // Clear existing content
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.execCommand("delete", false)

    // Build a ClipboardEvent with our text as payload. Modern contenteditable
    // implementations (ChatGPT/Claude/Gemini all use ProseMirror or similar
    // editors that respect "paste" events) parse the clipboard data and
    // commit in a single transaction — one React update, no per-keystroke
    // reconciliation thrash.
    const dt = new DataTransfer()
    dt.setData("text/plain", text)
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    })

    // dispatchEvent returns false if a handler called preventDefault, which
    // means the editor took over and handled the paste itself. That's
    // success in our world — we just want the text in the input.
    const handlerHandled = !el.dispatchEvent(pasteEvent)

    if (!handlerHandled) {
      // No handler took over. Fall back to a manual insertion in one shot.
      // execCommand("insertText", _, text) with the full string is still
      // one operation, no per-line loop.
      document.execCommand("insertText", false, text)
    }

    // Belt-and-suspenders: fire an input event so any listeners that
    // missed the paste event still know the value changed.
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: text
      })
    )

    return true
  } catch {
    return false
  }
}

export function typeIntoContentEditable(el: HTMLElement, text: string) {
  // For large prompts, use bulk paste — orders of magnitude faster and
  // doesn't get stuck mid-reconciliation.
  const lineCount = (text.match(/\n/g) || []).length
  if (
    text.length >= BULK_PASTE_CHAR_THRESHOLD ||
    lineCount >= BULK_PASTE_NEWLINE_THRESHOLD
  ) {
    if (pasteIntoContentEditable(el, text)) return
    // If paste path threw, fall through to the line-by-line path below
    // as a safety net.
  }

  el.focus()

  // Clear existing content
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  document.execCommand("delete", false)

  // Insert line-by-line. insertLineBreak between lines produces a <br>
  // without triggering an Enter-key submit.
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      document.execCommand("insertLineBreak", false)
    }
    if (lines[i].length > 0) {
      document.execCommand("insertText", false, lines[i])
    }
  }

  // Belt-and-suspenders: dispatch an input event so any React/Angular
  // listeners that didn't pick up execCommand still see the change.
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    })
  )
}

/** Insert text into a native textarea or input, React-compatible. */
export function typeIntoTextarea(
  el: HTMLTextAreaElement | HTMLInputElement,
  text: string
) {
  el.focus()

  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set

  if (setter) {
    setter.call(el, text)
  } else {
    el.value = text
  }

  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
}
