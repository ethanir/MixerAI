import type { PlasmoCSConfig } from "plasmo"

import { typeIntoContentEditable } from "~lib/adapter-utils"
import {
  findByAriaLabel,
  findByText,
  installMonitor
} from "~lib/auth-detector"
import { makeAdapter } from "~lib/make-adapter"
import type { AuthState } from "~lib/types"

export const config: PlasmoCSConfig = {
  matches: ["https://claude.ai/*"],
  run_at: "document_idle"
}

// === Auth detection ===

/**
 * Clean common artifacts from Claude's captured innerText:
 *   1. Duplicate leading short phrase (e.g. "State.\nState. Let L[i]..." → "State. Let L[i]...")
 *      Claude renders a hidden anchor element with the section name plus a visible bold version
 *      in the paragraph — innerText picks up both.
 *   2. KaTeX math rendered character-by-character. KaTeX puts each token (L, [, i, ], =, 1, +, ...)
 *      in its own inline element which innerText interprets as block-level. Collapse runs of
 *      4+ consecutive short lines into one inline string.
 *   3. Adjacent identical lines. The artifact widget renders its description
 *      twice (once visible, once for accessibility), producing two identical
 *      adjacent lines in innerText.
 *   4. Full-body repetition. When Claude's UI auto-creates an artifact for a
 *      long structured response, innerText captures BOTH the chat-prose copy
 *      AND the artifact's rendered body — so the entire answer ends up in the
 *      text twice. Detect a 5+ consecutive identical-line run at two
 *      positions and truncate at the start of the second copy.
 */
function cleanClaudeText(raw: string): string {
  let text = raw

  // 1. Remove duplicate leading "Word." prefix
  const splitOnce = text.split("\n")
  if (splitOnce.length >= 2) {
    const firstIdx = splitOnce.findIndex((l) => l.trim().length > 0)
    if (firstIdx >= 0) {
      const first = splitOnce[firstIdx].trim()
      if (first.length < 30 && first.endsWith(".")) {
        const secondIdx = splitOnce.findIndex(
          (l, i) => i > firstIdx && l.trim().length > 0
        )
        if (
          secondIdx >= 0 &&
          splitOnce[secondIdx].trim().startsWith(first)
        ) {
          splitOnce.splice(firstIdx, 1)
          text = splitOnce.join("\n")
        }
      }
    }
  }

  // 2. Collapse KaTeX char-per-line math token sequences.
  // Conservative heuristic: a "math run" requires
  //   (a) 4+ consecutive short non-empty lines (≤4 chars each),
  //   (b) at least one of those lines is exactly 1 character.
  // Single-character lines are a dead-giveaway for KaTeX rendering each math
  // token in its own block. Real code blocks and bullet lists virtually
  // never contain runs of 4+ short lines with at least one single-char line,
  // so this filter is safe in practice.
  const lines = text.split("\n")
  const result: string[] = []
  let buffer: string[] = []

  const flush = () => {
    const hasSingleChar = buffer.some((s) => s.length === 1)
    if (buffer.length >= 4 && hasSingleChar) {
      result.push(buffer.join(""))
    } else {
      result.push(...buffer)
    }
    buffer = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (
      trimmed.length > 0 &&
      trimmed.length <= 4 &&
      !/[.!?;{}]$/.test(trimmed) && // not sentence/code ending
      !/^[-*•]/.test(trimmed) && // not bullet
      !/^\d+\./.test(trimmed) // not numbered list
    ) {
      buffer.push(trimmed)
    } else {
      flush()
      result.push(line)
    }
  }
  flush()
  text = result.join("\n")

  // 3. Dedup near-adjacent identical non-empty lines (handles artifact widget
  //    rendering its title/description twice — once visible, once
  //    aria-hidden — which innerText flattens with sometimes a blank line
  //    between them).
  {
    const RECENT_NONEMPTY = 3
    const ls = text.split("\n")
    const out: string[] = []
    for (const line of ls) {
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        // Check the last RECENT_NONEMPTY non-empty lines we've kept.
        let dup = false
        let seen = 0
        for (let k = out.length - 1; k >= 0 && seen < RECENT_NONEMPTY; k--) {
          const candTrim = out[k].trim()
          if (candTrim.length === 0) continue
          seen++
          if (candTrim === trimmed) {
            dup = true
            break
          }
        }
        if (dup) continue
      }
      out.push(line)
    }
    text = out.join("\n")
  }

  // 4. Dedup full-body repetition. When Claude's chat UI auto-creates an
  //    artifact, innerText captures both the chat-prose answer and the
  //    artifact's rendered body. Find a 5+ consecutive identical-line run at
  //    two positions in the text; if found, cut at the start of the meta
  //    region between the two bodies (not just at body 2's start) so that
  //    any intermediate widget title/description noise gets dropped too.
  {
    const ls = text.split("\n")
    const MIN_RUN = 5
    const MIN_ANCHOR_LEN = 25
    let cut = -1

    outer: for (let i = 0; i < ls.length; i++) {
      const anchor = ls[i].trim()
      if (anchor.length < MIN_ANCHOR_LEN) continue
      for (let j = i + MIN_RUN; j < ls.length; j++) {
        if (ls[j].trim() !== anchor) continue
        // Count consecutive matching non-blank lines starting at (i, j).
        let matches = 0
        let k = 0
        while (
          i + k < j &&
          j + k < ls.length &&
          ls[i + k].trim() === ls[j + k].trim()
        ) {
          if (ls[i + k].trim().length > 0) matches++
          k++
          if (matches >= MIN_RUN) break
        }
        if (matches >= MIN_RUN) {
          // Confirmed body repeat. Gather substantive lines from the
          // original body (everything before bodyEnd), then walk forward
          // from bodyEnd to find the earliest line that re-appears — that
          // marks where the meta-widget region begins.
          const bodyEnd = i + k
          const bodyLines = new Set<string>()
          for (let m = 0; m < bodyEnd; m++) {
            const t = ls[m].trim()
            if (t.length >= MIN_ANCHOR_LEN) bodyLines.add(t)
          }
          let metaStart = j
          for (let m = bodyEnd; m < j; m++) {
            if (bodyLines.has(ls[m].trim())) {
              metaStart = m
              break
            }
          }
          cut = metaStart
          break outer
        }
      }
    }

    if (cut > 0) {
      text = ls.slice(0, cut).join("\n")
    }
  }

  // 5. Strip accessibility prefixes (already handled but defensive)
  text = text.replace(
    /^(Claude responded:|Claude said:|Assistant said:)\s*/i,
    ""
  )

  return text.trim()
}

function detect(): AuthState {
  if (location.pathname.startsWith("/login")) return "signed_out"
  if (findByText(/continue with (google|email|apple)/i)) return "signed_out"
  if (findByText(/message limit|reached your.*limit/i)) return "rate_limited"

  if (findByAriaLabel(/profile|user menu|account menu/i)) return "signed_in"
  if (document.querySelector('[contenteditable="true"][role="textbox"]'))
    return "signed_in"
  if (findByText(/^new chat$/i, ["a", "button"])) return "signed_in"

  return "unknown"
}

// === Adapter ===

function findClaudeSendButton(): HTMLButtonElement | null {
  // Try several patterns. Order matters — most specific first.
  const candidates: (HTMLButtonElement | null)[] = [
    findByAriaLabel(/^send message$/i) as HTMLButtonElement | null,
    findByAriaLabel(/^send$/i) as HTMLButtonElement | null,
    findByAriaLabel(/send (message|prompt)/i) as HTMLButtonElement | null,
    document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i]:not([disabled])'
    ),
    // Some Claude builds use a submit button at the bottom of the composer
    document.querySelector<HTMLButtonElement>(
      'fieldset button[type="submit"]:not([disabled])'
    ),
    document.querySelector<HTMLButtonElement>(
      'form button[type="submit"]:not([disabled])'
    )
  ]
  for (const btn of candidates) {
    if (btn && !btn.disabled) return btn
  }
  return null
}

/**
 * Extract text from a Claude message container, replacing each KaTeX-rendered
 * math element with its original LaTeX source (wrapped in $…$ or $$…$$).
 *
 * Claude's UI renders math via KaTeX which puts each glyph in its own
 * inline-block span — innerText then treats each as a block-level node and
 * splits them across lines, producing the shredded "i\n<\nj\ni<j" pattern.
 * Each `.katex` element also contains a hidden MathML `<annotation>` with
 * the original LaTeX source — so we clone the DOM, swap every `.katex`
 * for a text node containing `$<source>$`, then read innerText from the
 * clean clone. This gives well-formed math in the captured output without
 * mutating the live page.
 */
function extractCleanText(element: HTMLElement): string {
  // Cloning is essential — we must not mutate the live page DOM, since the
  // user can still see and interact with it.
  const clone = element.cloneNode(true) as HTMLElement

  const mathEls = clone.querySelectorAll<HTMLElement>(".katex")
  for (const m of Array.from(mathEls)) {
    const annotation = m.querySelector<HTMLElement>(
      'annotation[encoding="application/x-tex"]'
    )
    const latex = annotation?.textContent?.trim() ?? ""
    if (!latex) continue
    const isDisplay =
      m.classList.contains("katex-display") ||
      m.closest(".katex-display") !== null
    const wrapped = isDisplay ? `\n$$${latex}$$\n` : `$${latex}$`
    m.replaceWith(document.createTextNode(wrapped))
  }

  // `||`, not `??`: innerText returns "" (not null/undefined) on the
  // cloned tree because cloneNode produces an unattached element with no
  // layout. With `??`, the empty innerText satisfied the operator and
  // textContent never ran. `||` falls through on empty string, giving the
  // layout-independent textContent a chance.
  return (clone.innerText || clone.textContent || "").trim()
}

const sendPrompt = makeAdapter({
  service: "claude",
  backendCapture: true,

  findInput: () =>
    document.querySelector<HTMLElement>(
      '[contenteditable="true"][role="textbox"]'
    ) ||
    // Fallback: any contenteditable at the bottom of the page
    document.querySelector<HTMLElement>(
      'fieldset [contenteditable="true"]'
    ),

  typePrompt: typeIntoContentEditable,

  findSendButton: findClaudeSendButton,

  countMessages: () => {
    const renderCountEls = document.querySelectorAll("[data-test-render-count]")
    if (renderCountEls.length > 0) return renderCountEls.length
    return document.querySelectorAll('[role="article"]').length
  },

  findStreamIndicator: () =>
    // Match ANY button whose aria-label starts with "Stop" — Claude uses
    // different labels in different phases (Stop response, Stop generating,
    // Stop reply, sometimes just Stop during transitions). Word boundary
    // prevents matching "Stopwatch" or similar.
    findByAriaLabel(/^stop\b/i) ||
    findByAriaLabel(/stop response|stop generating|stop reply/i),

  getLatestMessageText: () => {
    // STREAMING-SAFE PATH for STABILITY DETECTION. Uses textContent (not
    // innerText) because Claude's thinking section is COLLAPSED during
    // streaming — its reasoning content is in the DOM but hidden behind
    // a click-to-expand widget. innerText respects layout and skips
    // hidden text, which is wrong for our purposes: we'd see only the
    // brief thinking-section header (which updates infrequently),
    // mistake the sparse header changes for "near-stable" text, and
    // waitForStableText would fire prematurely while Claude is actually
    // deep in reasoning. textContent walks all descendants regardless
    // of visibility, so it grows steadily as thinking tokens stream in,
    // giving stability detection a true signal.
    //
    // Cleanup (KaTeX swap, dedup, etc.) is deferred to getFinalMessageText,
    // so this stays cheap and never shrinks mid-stream.
    const turns = document.querySelectorAll<HTMLElement>(
      "[data-test-render-count]"
    )
    if (turns.length > 0) {
      const latest = turns[turns.length - 1]
      const t = (latest?.textContent ?? "").trim()
      if (t.length > 0) return t
    }

    const articles = document.querySelectorAll<HTMLElement>('[role="article"]')
    if (articles.length > 0) {
      const latest = articles[articles.length - 1]
      const t = (latest?.textContent ?? "").trim()
      if (t.length > 0) return t
    }

    const blocks = document.querySelectorAll<HTMLElement>(
      ".font-claude-message, [class*='font-claude'], .prose"
    )
    if (blocks.length > 0) {
      return Array.from(blocks)
        .map((el) => el.textContent ?? "")
        .join("\n\n")
        .trim()
    }

    return ""
  },

  isMessageFinalized: () => {
    // Detect post-completion action buttons attached to the latest
    // assistant message. Claude renders Retry, Good response, Bad
    // response (thumbs), and Copy buttons ONLY after the message is
    // fully done — never during streaming, thinking, or tool use. This
    // is the most reliable "fully done" signal.
    const turns = document.querySelectorAll<HTMLElement>(
      "[data-test-render-count]"
    )
    const latest = turns[turns.length - 1]
    if (!latest) return false

    // Scan buttons within the latest message for completion-only labels.
    const buttons = latest.querySelectorAll<HTMLButtonElement>(
      "button[aria-label]"
    )
    for (const btn of Array.from(buttons)) {
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase()
      // These labels appear only after the message is fully rendered
      // and finalized — Retry button, thumbs up/down, "Copy response".
      if (
        /^retry\b/.test(aria) ||
        /^regenerate\b/.test(aria) ||
        /^good response\b/.test(aria) ||
        /^bad response\b/.test(aria) ||
        /^copy (response|message)\b/.test(aria)
      ) {
        return true
      }
    }
    return false
  },

  getFinalMessageText: () => {
    // FINAL-CAPTURE PATH. Called only once after streaming has fully ended.
    // Safe to do the expensive work here: clone the DOM, swap KaTeX widgets
    // for their LaTeX source, run cleanup passes (adjacent dedup, full-body
    // artifact dedup, etc.).
    const turns = document.querySelectorAll<HTMLElement>(
      "[data-test-render-count]"
    )
    if (turns.length > 0) {
      const latest = turns[turns.length - 1]
      if (latest) {
        const raw = extractCleanText(latest)
        if (raw.length > 0) return cleanClaudeText(raw)
      }
    }

    const articles = document.querySelectorAll<HTMLElement>('[role="article"]')
    if (articles.length > 0) {
      const latest = articles[articles.length - 1]
      if (latest) {
        const raw = extractCleanText(latest)
        if (raw.length > 0) return cleanClaudeText(raw)
      }
    }

    const blocks = document.querySelectorAll<HTMLElement>(
      ".font-claude-message, [class*='font-claude'], .prose"
    )
    if (blocks.length > 0) {
      const raw = Array.from(blocks)
        .map((el) => extractCleanText(el))
        .join("\n\n")
        .trim()
      return cleanClaudeText(raw)
    }

    return ""
  }
})

installMonitor("claude", detect, sendPrompt)
