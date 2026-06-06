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
  matches: ["https://gemini.google.com/*"],
  run_at: "document_idle"
}

// === Auth detection ===

function detect(): AuthState {
  if (findByText(/you've reached.*limit|try again later/i)) {
    return "rate_limited"
  }
  if (findByAriaLabel(/google account/i)) return "signed_in"
  if (
    document.querySelector(
      'rich-textarea, [contenteditable="true"][aria-label*="prompt" i]'
    )
  ) {
    return "signed_in"
  }
  if (findByText(/^sign in$/i, ["a", "button"])) return "signed_out"
  return "unknown"
}

// === Adapter ===

// As of the 2026 Gemini UI, each model response renders inside a
// <message-content> custom element whose text lives in a
// `.markdown.markdown-main-panel` div. The old <model-response> element
// and `.model-response-text` class are gone. We try the new structure
// first and fall back to the legacy selectors so an older Gemini build
// (or a partial rollout) still works.
function geminiResponseEls(): HTMLElement[] {
  // Prefer the new markdown panel; each finished/streaming response has one.
  const panels = document.querySelectorAll<HTMLElement>(".markdown-main-panel")
  if (panels.length > 0) return Array.from(panels)
  const legacy = document.querySelectorAll<HTMLElement>("model-response")
  if (legacy.length > 0) return Array.from(legacy)
  return Array.from(
    document.querySelectorAll<HTMLElement>(".model-response-text, .markdown")
  )
}

function latestGeminiResponseEl(): HTMLElement | null {
  const els = geminiResponseEls()
  return els[els.length - 1] || null
}

function findGeminiSendButton(): HTMLButtonElement | null {
  const candidates: (HTMLButtonElement | null)[] = [
    findByAriaLabel(/^send message$/i) as HTMLButtonElement | null,
    findByAriaLabel(/^send$/i) as HTMLButtonElement | null,
    findByAriaLabel(/^submit$/i) as HTMLButtonElement | null,
    document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i]:not([disabled])'
    ),
    document.querySelector<HTMLButtonElement>(
      'send-button:not([disabled]) button'
    )
  ]
  for (const btn of candidates) {
    if (btn && !(btn as any).disabled) return btn
  }
  return null
}

const sendPrompt = makeAdapter({
  service: "gemini",
  backendCapture: true,

  findInput: () => {
    // Gemini renders <rich-textarea> with a contenteditable inside
    const rich = document.querySelector("rich-textarea")
    if (rich) {
      const editable = rich.querySelector<HTMLElement>(
        '[contenteditable="true"]'
      )
      if (editable) return editable
    }
    return document.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label*="prompt" i]'
    )
  },

  typePrompt: typeIntoContentEditable,

  findSendButton: findGeminiSendButton,

  countMessages: () => geminiResponseEls().length,

  findStreamIndicator: () =>
    findByAriaLabel(/stop response|stop generating|stop streaming/i) ||
    document.querySelector<HTMLElement>(
      'button[aria-label*="stop" i]'
    ),

  getLatestMessageText: () => {
    const latest = latestGeminiResponseEl()
    // `||`, not `??`: innerText returns "" (not null/undefined) when
    // layout hasn't run — the failure mode in backgrounded tabs where
    // Chrome stalls rAF. textContent is layout-independent and needs a
    // shot at the fallback. With `??`, empty innerText was accepted
    // and textContent never ran.
    return latest ? latest.innerText || latest.textContent || "" : ""
  },

  isMessageFinalized: () => {
    const latest = latestGeminiResponseEl()
    if (!latest) return false

    // Don't call it finalized with no text yet.
    const text = latest.innerText || latest.textContent || ""
    if (text.trim().length === 0) return false

    // New UI: the markdown panel is an aria-live region. It carries
    // aria-busy="true" while streaming and "false" once complete.
    // Find the busy flag on the latest panel or a close ancestor.
    let busyHost: HTMLElement | null = latest
    for (let i = 0; busyHost && i < 4; i++) {
      const busy = busyHost.getAttribute?.("aria-busy")
      if (busy === "true") return false // still streaming
      if (busy === "false") {
        // Explicitly done streaming. Belt-and-suspenders: also require
        // that no stop button is visible.
        const stop = document.querySelector<HTMLElement>(
          'button[aria-label*="stop" i]'
        )
        if (!stop || stop.offsetParent === null) return true
      }
      busyHost = busyHost.parentElement
    }

    // Fallback (legacy + safety net): a visible stop button means it's
    // still generating; its absence plus post-completion action buttons
    // (Good/Bad response, Regenerate, Share) means done.
    const stop = document.querySelector<HTMLElement>(
      'button[aria-label*="stop" i]'
    )
    if (stop && stop.offsetParent !== null) return false

    const candidates: HTMLElement[] = [latest]
    let p: HTMLElement | null = latest.parentElement
    for (let i = 0; p && i < 4; i++) {
      candidates.push(p)
      p = p.parentElement
    }
    for (const scope of candidates) {
      const buttons = scope.querySelectorAll<HTMLElement>(
        "button[aria-label], [role='button'][aria-label]"
      )
      for (const btn of Array.from(buttons)) {
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase()
        if (
          /good response/.test(aria) ||
          /bad response/.test(aria) ||
          /^regenerate\b/.test(aria) ||
          /^thumbs (up|down)\b/.test(aria) ||
          /^share/.test(aria)
        ) {
          return true
        }
      }
    }
    return false
  }
})

installMonitor("gemini", detect, sendPrompt)
