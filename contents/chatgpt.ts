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
  matches: [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*"
  ],
  run_at: "document_idle"
}

// === Auth detection ===

function detect(): AuthState {
  if (location.pathname.startsWith("/auth")) return "signed_out"

  if (
    findByText(
      /you've reached.*limit|usage cap|please try again later/i
    )
  ) {
    return "rate_limited"
  }

  const profileBtn =
    findByAriaLabel(/open profile menu|profile menu|account menu/i) ||
    document.querySelector('[data-testid="profile-button"]')
  if (profileBtn) return "signed_in"

  if (document.getElementById("prompt-textarea")) return "signed_in"

  const sidebar =
    document.querySelector('nav[aria-label*="chat history" i]') ||
    document.querySelector('[data-testid="conversation-history"]')
  if (sidebar) return "signed_in"

  if (findByText(/^(log in|sign up)$/i, ["button", "a"])) return "signed_out"

  return "unknown"
}

// === Adapter ===

function findChatGPTSendButton(): HTMLButtonElement | null {
  const candidates: (HTMLButtonElement | null)[] = [
    document.querySelector<HTMLButtonElement>(
      '[data-testid="send-button"]:not([disabled])'
    ),
    findByAriaLabel(/^send prompt$/i) as HTMLButtonElement | null,
    findByAriaLabel(/^send message$/i) as HTMLButtonElement | null,
    findByAriaLabel(/^send$/i) as HTMLButtonElement | null,
    document.querySelector<HTMLButtonElement>(
      'button[aria-label*="send" i]:not([disabled])'
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

// Find all assistant message elements on ChatGPT. Tries multiple patterns
// since OpenAI changes class names frequently.
function chatGPTAssistantMessages(): HTMLElement[] {
  const strategies = [
    '[data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn"]:not([data-testid*="user"])',
    'div[data-message-id]:not([data-message-author-role="user"])',
    '.markdown.prose',
    '[class*="agent-turn"]'
  ]
  for (const sel of strategies) {
    const els = document.querySelectorAll<HTMLElement>(sel)
    if (els.length > 0) return Array.from(els)
  }
  return []
}

const sendPrompt = makeAdapter({
  service: "chatgpt",
  backendCapture: true,

  findInput: () =>
    document.getElementById("prompt-textarea") ||
    document.querySelector<HTMLElement>(
      'div[contenteditable="true"][role="textbox"]'
    ),

  typePrompt: typeIntoContentEditable,

  findSendButton: findChatGPTSendButton,

  countMessages: () => chatGPTAssistantMessages().length,

  findStreamIndicator: () =>
    document.querySelector('[data-testid="stop-button"]') ||
    findByAriaLabel(/stop generating|stop streaming/i),

  getLatestMessageText: () => {
    const messages = chatGPTAssistantMessages()
    if (messages.length === 0) return ""
    const latest = messages[messages.length - 1]
    // `||`, not `??`: innerText returns "" (not null/undefined) when
    // layout hasn't run, which is the failure mode in a backgrounded
    // tab where Chrome has stalled rAF. We need textContent (which is
    // layout-independent) to get the fallback shot. With `??`, an
    // empty-string innerText satisfied the operator and textContent
    // was never tried — the polling loop reported textLen=0 forever.
    return (latest?.innerText || latest?.textContent || "").trim()
  },

  isMessageFinalized: () => {
    // Detect post-completion action buttons on the latest assistant
    // message. ChatGPT shows Regenerate / Read aloud / Switch model /
    // Edit (for user messages) only after the response is fully done.
    // "Read aloud" and "Regenerate" specifically are exclusive to the
    // post-completion state and don't appear elsewhere during streaming.
    const messages = chatGPTAssistantMessages()
    const latest = messages[messages.length - 1]
    if (!latest) return false

    // ChatGPT often puts action buttons in a sibling/descendant of
    // the data-message-author-role element — extend search to the
    // parent conversation-turn container.
    const turn =
      latest.closest('article[data-testid^="conversation-turn"]') ||
      latest.parentElement ||
      latest

    const buttons = turn.querySelectorAll<HTMLElement>(
      "button[aria-label], [data-testid][aria-label]"
    )
    for (const btn of Array.from(buttons)) {
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase()
      if (
        /^regenerate\b/.test(aria) ||
        /^read aloud\b/.test(aria) ||
        /^switch model\b/.test(aria) ||
        /^try again\b/.test(aria) ||
        /good response|bad response/.test(aria)
      ) {
        return true
      }
    }

    // Fallback: check for data-testid markers ChatGPT uses for action rows
    const actionRow =
      turn.querySelector('[data-testid="copy-turn-action-button"]') ||
      turn.querySelector('[data-testid="regenerate-button"]') ||
      turn.querySelector('[data-testid="voice-play-turn-action-button"]')
    if (actionRow) return true

    return false
  }
})

installMonitor("chatgpt", detect, sendPrompt)
