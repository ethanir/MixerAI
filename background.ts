import { SERVICE_URLS } from "~lib/config"
import { executeTask } from "~lib/orchestrator"
import type {
  AIService,
  ExtensionMessage,
  ServiceStatus,
  TaskUpdate
} from "~lib/types"

// Toolbar icon click opens the side panel
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[SuperAI] sidePanel setup failed", err))

// ============================================================
// Auth state coordination
// ============================================================

const statusMap = new Map<AIService, ServiceStatus>()

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, _sender, sendResponse) => {
    if (msg.type === "AUTH_STATE_UPDATE") {
      statusMap.set(msg.payload.service, msg.payload)
      broadcastStatuses()
      return
    }

    if (msg.type === "GET_ALL_STATUSES") {
      sendResponse(Array.from(statusMap.values()))
      return true
    }

    if (msg.type === "REFRESH_ALL") {
      refreshAllStatuses(msg.services)
      return
    }

    if (msg.type === "OPEN_ALL") {
      openAllMissing(msg.services)
      return
    }

    if (msg.type === "OPEN_SERVICE") {
      openServiceForUser(msg.service)
      return
    }
  }
)

function broadcastStatuses() {
  chrome.runtime
    .sendMessage({
      type: "STATUS_BROADCAST",
      statuses: Array.from(statusMap.values())
    } satisfies ExtensionMessage)
    .catch(() => {
      // Sidepanel may be closed
    })
}

/**
 * Re-detect auth state on tabs that ALREADY exist. Does NOT create
 * new tabs — that's what OPEN_ALL is for.
 */
async function refreshAllStatuses(services: AIService[]) {
  for (const service of services) {
    const url = SERVICE_URLS[service]
    const tabs = await chrome.tabs.query({ url: `${url}/*` })
    if (tabs.length === 0) {
      // No tab — clear any stale status so the UI shows "Not connected"
      statusMap.delete(service)
      continue
    }
    const tabId = tabs[0].id
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, { type: "CHECK_AUTH" }).catch(() => {})
    }
  }
  broadcastStatuses()
}

// ============================================================
// Tab lifecycle: clear stale statuses when AI tabs disappear
//
// Previously, the connection dots stayed green forever after the user
// closed an AI tab. The auth-detector only runs inside a live tab, so
// once the tab dies, no new updates arrive and the last "signed_in" state
// persists. These listeners catch tab close + URL navigation away and
// re-check whether each service still has a live tab — if not, clear its
// status so the UI flips to "Not connected".
// ============================================================
const ALL_TRACKED_SERVICES: AIService[] = [
  "chatgpt",
  "claude",
  "gemini"
]

async function recheckTabsExist() {
  let changed = false
  for (const service of ALL_TRACKED_SERVICES) {
    const url = SERVICE_URLS[service]
    const tabs = await chrome.tabs.query({ url: `${url}/*` })
    if (tabs.length === 0 && statusMap.has(service)) {
      statusMap.delete(service)
      changed = true
    }
  }
  if (changed) broadcastStatuses()
}

chrome.tabs.onRemoved.addListener(() => {
  recheckTabsExist()
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // Only when the URL itself changed (user navigated away from
  // claude.ai → google.com, for example). Other changeInfo events
  // (favicon, title, audible) don't affect tab presence.
  if (changeInfo.url) recheckTabsExist()
})

/** Open any services that don't already have a tab. Opens in the background. */
async function openAllMissing(services: AIService[]) {
  for (const service of services) {
    const url = SERVICE_URLS[service]
    const tabs = await chrome.tabs.query({ url: `${url}/*` })
    if (tabs.length === 0) {
      await chrome.tabs.create({ url, active: false })
    }
  }
}

async function openServiceForUser(service: AIService) {
  const url = SERVICE_URLS[service]
  const tabs = await chrome.tabs.query({ url: `${url}/*` })
  if (tabs.length > 0) {
    const tab = tabs[0]
    if (tab.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true })
    }
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
  } else {
    await chrome.tabs.create({ url, active: true })
  }
}

// ============================================================
// Task execution (via long-lived port from sidepanel)
//
// Long-lived ports keep the MV3 service worker alive during the
// multi-minute task. Posting back on the port also handles the
// case where the sidepanel closes mid-task (port disconnects).
// ============================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "task-execution") return

  let cancelled = false
  port.onDisconnect.addListener(() => {
    cancelled = true
  })

  port.onMessage.addListener(async (msg: ExtensionMessage) => {
    if (msg.type !== "EXECUTE_TASK") return

    const safePost = (update: TaskUpdate) => {
      if (cancelled) return
      try {
        port.postMessage(update)
      } catch {
        // Port closed mid-task; nothing to do
      }
    }

    // MV3 service-worker keepalive — v1.3.4 hardened version.
    //
    // In Manifest V3 the background SW is evicted after ~30s of inactivity,
    // and an outright hard kill after 5 minutes regardless of activity.
    // Long awaits inside a listener count as inactivity. When the SW dies
    // mid-task, every port it owns is torn down silently — the content
    // script's port.postMessage({ type: "RESULT", ... }) goes into a dead
    // channel and is lost forever. Side panel hangs at "Running..." until
    // the 7-minute timeout finally rejects.
    //
    // v1.3.3 used setInterval with a 20s tick of chrome.runtime.getPlatformInfo().
    // That works MOSTLY but has two failure modes:
    //   1. setInterval's first tick fires at 20s — for the first 19.9s of
    //      a task, the keepalive isn't doing anything yet. If Chrome was
    //      already mid-eviction when the task started, the SW can still die.
    //   2. setInterval itself doesn't survive SW restarts. If anything
    //      restarts the SW (e.g. Chrome backgrounds it briefly), the timer
    //      is gone and never reschedules.
    //
    // chrome.alarms is the OFFICIAL Chrome-recommended MV3 keepalive
    // primitive. Alarms are persisted across SW lifecycle events — even
    // if the SW dies and restarts, the alarm wakes it back up at its
    // scheduled interval. We can't actually go below 30s on production
    // builds (Chrome enforces a 30s minimum), but combined with an
    // immediate kick at start (`chrome.runtime.getPlatformInfo` synchronously
    // resets the idle timer) this covers the gap setInterval had.
    //
    // Pattern recommended by Google's MV3 lifecycle docs:
    //   https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#idle-shutdown
    const KEEPALIVE_ALARM_NAME = "mixerai-task-keepalive"

    // Immediate kick — resets idle timer BEFORE we await anything.
    chrome.runtime.getPlatformInfo().catch(() => {})

    // Schedule recurring wakeup. periodInMinutes is fractional; 0.5 = 30s.
    // We also use setInterval as a SECOND keepalive layer for the first
    // 30s window before the alarm system can fire — alarms have a 30s
    // minimum on stable Chrome but setInterval can fire sooner.
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: 0.5
    })

    const keepaliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {})
    }, 15_000)

    console.log(
      `[MixerAI/sw] task started — alarms + setInterval keepalive armed`
    )

    try {
      await executeTask(msg.prompt, msg.plan, safePost)
      console.log(`[MixerAI/sw] task completed normally`)
    } catch (err) {
      console.log(
        `[MixerAI/sw] task threw: ${err instanceof Error ? err.message : String(err)}`
      )
      safePost({
        type: "TASK_ERROR",
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      clearInterval(keepaliveTimer)
      chrome.alarms.clear(KEEPALIVE_ALARM_NAME).catch(() => {})
    }
  })
})

// Alarms listener — no-op handler. The alarm firing itself is what keeps
// the SW alive. We don't need to do anything in the handler; Chrome's
// alarm dispatch counts as an "event" that resets the idle timer.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mixerai-task-keepalive") {
    // intentional no-op — presence of this listener is the keepalive
  }
})
