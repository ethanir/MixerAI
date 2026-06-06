import { useEffect, useRef, useState } from "react"

import { PLANNER_URL } from "~lib/config"
import type {
  AIService,
  AuthState,
  ExtensionMessage,
  ServiceStatus,
  TaskPlan,
  TaskUpdate
} from "~lib/types"

import "./style.css"

const SERVICES: AIService[] = ["chatgpt", "claude", "gemini"]

const LABELS: Record<AIService, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek"
}

// === MixerAI Plan ===
// The user's MixerAI plan tier — controls (a) which Anthropic model powers
// the routing brain, and (b) whether moa_critic strategy is available.
//   Free      → Haiku 4.5  (~$0.003/plan)  · standard MoA
//   Pro       → Opus 4.7   (~$0.08 /plan)  · full super-brain: MoA + independent critic + revision

type MixerTier = "free" | "pro"

const DEFAULT_TIER: MixerTier = "free"

// Hardcoded unlock code for closed-beta testing. Anyone with this string
// can upgrade to Pro on their own machine. Replace with server-side
// validation (bearer-token check on the planner) before any wider release.
const UNLOCK_CODE = "ethan"

const TIER_OPTIONS: { value: MixerTier; label: string; sub: string }[] = [
  { value: "free", label: "Free", sub: "Haiku 4.5" },
  { value: "pro", label: "Pro", sub: "Opus 4.7 · Super-brain" }
]

// === Subscriptions ===

type Subscriptions = {
  chatgpt: "free" | "plus" | "pro"
  claude: "free" | "pro" | "max"
  gemini: "free" | "ai-pro" | "ai-ultra"
}

const DEFAULT_SUBS: Subscriptions = {
  chatgpt: "free",
  claude: "free",
  gemini: "free"
}

const SUB_OPTIONS: Record<AIService, { value: string; label: string }[]> = {
  chatgpt: [
    { value: "free", label: "Free" },
    { value: "plus", label: "Plus" },
    { value: "pro", label: "Pro" }
  ],
  claude: [
    { value: "free", label: "Free" },
    { value: "pro", label: "Pro" },
    { value: "max", label: "Max" }
  ],
  gemini: [
    { value: "free", label: "Free" },
    { value: "ai-pro", label: "AI Pro" },
    { value: "ai-ultra", label: "AI Ultra" }
  ],
  deepseek: [{ value: "free", label: "Free" }]
}

type Phase =
  | { kind: "idle" }
  | { kind: "planning" }
  | { kind: "plan_ready"; plan: TaskPlan }
  | {
      kind: "executing"
      plan: TaskPlan
      proposerStates: Partial<
        Record<AIService, "pending" | "running" | "done" | "failed">
      >
      proposerErrors: Partial<Record<AIService, string>>
      aggregatorState: "pending" | "running" | "done"
      criticState: "pending" | "running" | "done"
      revisionState: "pending" | "running" | "done"
      finalText?: string
    }
  | {
      kind: "complete"
      plan: TaskPlan
      finalText: string
      successfulProposers: AIService[]
    }
  | { kind: "error"; message: string }

function statusText(state?: AuthState): string {
  switch (state) {
    case "signed_in":
      return "Ready"
    case "signed_out":
      return "Sign in"
    case "rate_limited":
      return "Rate limited"
    default:
      return "Not connected"
  }
}

function dotClass(state?: AuthState): string {
  switch (state) {
    case "signed_in":
      return "dot dot-signed-in"
    case "signed_out":
      return "dot dot-signed-out"
    case "rate_limited":
      return "dot dot-rate-limited"
    default:
      return "dot dot-unknown"
  }
}

// ============================================================
// Logo — three dots in a triangle joined by arcs that all bow the same
// rotational direction. Reads as "spinning" without animation. Clean.
// ============================================================
function MixerLogo() {
  return (
    <svg
      className="logo"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="MixerAI">
      <circle cx="16" cy="6" r="2.4" fill="currentColor" />
      <circle cx="7.3" cy="21" r="2.4" fill="currentColor" />
      <circle cx="24.7" cy="21" r="2.4" fill="currentColor" />
      <path
        d="M 16 6 Q 3.5 12.5 7.3 21"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 7.3 21 Q 16 30 24.7 21"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M 24.7 21 Q 28.5 12.5 16 6"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function Sidepanel() {
  const [statuses, setStatuses] = useState<
    Partial<Record<AIService, ServiceStatus>>
  >({})
  const [task, setTask] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [subs, setSubs] = useState<Subscriptions>(DEFAULT_SUBS)
  const [tier, setTier] = useState<MixerTier>(DEFAULT_TIER)

  // Edit-mode for subscriptions: when false, pills are locked across all
  // services. When true, every row's pills unlock together and the user can
  // adjust any service; Save commits all changes at once.
  const [editingSubs, setEditingSubs] = useState(false)
  const [pendingSubs, setPendingSubs] = useState<Subscriptions | null>(null)

  // Same edit-mode model for the MixerAI tier selector.
  const [editingTier, setEditingTier] = useState(false)
  const [pendingTier, setPendingTier] = useState<MixerTier | null>(null)

  // Unlock flow: by default the user is on Free with Pro locked. Clicking
  // the Unlock button shows an input; entering the correct code flips
  // `proUnlocked` to true and persists across sessions via chrome.storage.
  // Once unlocked, the Plan section behaves like the previous Edit/Save
  // flow — user can freely switch between Free and Pro.
  const [proUnlocked, setProUnlocked] = useState(false)
  const [showUnlockInput, setShowUnlockInput] = useState(false)
  const [unlockInput, setUnlockInput] = useState("")
  const [unlockError, setUnlockError] = useState<string | null>(null)

  const portRef = useRef<chrome.runtime.Port | null>(null)

  // === Load subs from chrome.storage on mount ===
  useEffect(() => {
    chrome.storage.local.get("subscriptions").then((result) => {
      if (result.subscriptions) {
        setSubs({ ...DEFAULT_SUBS, ...result.subscriptions })
      }
    })
  }, [])

  // === Load tier from chrome.storage on mount ===
  useEffect(() => {
    chrome.storage.local.get(["mixerTier", "proUnlocked"]).then((result) => {
      // Migration: users upgrading from a build that had "pro_plus" should
      // land on "pro" now (the new single super-brain tier).
      const stored = result.mixerTier as string | undefined
      if (stored === "free" || stored === "pro") {
        setTier(stored)
      } else if (stored === "pro_plus") {
        setTier("pro")
        chrome.storage.local.set({ mixerTier: "pro" })
      }
      // Pro stays locked until the user enters the unlock code. If a prior
      // build let the user pick "pro" without unlocking, force them back to
      // free until they unlock — closes the loophole during the beta.
      const unlocked = result.proUnlocked === true
      setProUnlocked(unlocked)
      if (!unlocked && (stored === "pro" || stored === "pro_plus")) {
        setTier("free")
        chrome.storage.local.set({ mixerTier: "free" })
      }
    })
  }, [])

  // === Status subscription ===
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: "GET_ALL_STATUSES" } satisfies ExtensionMessage)
      .then((arr: ServiceStatus[] | undefined) => {
        if (Array.isArray(arr)) {
          const map: Partial<Record<AIService, ServiceStatus>> = {}
          arr.forEach((s) => {
            map[s.service] = s
          })
          setStatuses(map)
        }
      })
      .catch(() => {})

    const listener = (msg: ExtensionMessage) => {
      if (msg.type === "STATUS_BROADCAST") {
        const map: Partial<Record<AIService, ServiceStatus>> = {}
        msg.statuses.forEach((s) => {
          map[s.service] = s
        })
        setStatuses(map)
      }
    }
    chrome.runtime.onMessage.addListener(listener)

    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  // === Subscriptions edit/save flow ===
  const handleEditSubs = () => {
    setEditingSubs(true)
    setPendingSubs(subs)
  }

  const handlePickPendingSub = (service: AIService, value: string) => {
    if (!pendingSubs) return
    setPendingSubs({ ...pendingSubs, [service]: value } as Subscriptions)
  }

  const handleSaveSubs = () => {
    if (pendingSubs) {
      setSubs(pendingSubs)
      chrome.storage.local.set({ subscriptions: pendingSubs })
    }
    setEditingSubs(false)
    setPendingSubs(null)
  }

  const handleCancelSubs = () => {
    setEditingSubs(false)
    setPendingSubs(null)
  }

  // === Tier edit/save flow ===
  // Only callable once Pro has been unlocked. Until then, the Edit button
  // is replaced by an Unlock button (see render below).
  const handleEditTier = () => {
    if (!proUnlocked) return
    setEditingTier(true)
    setPendingTier(tier)
  }

  const handlePickPendingTier = (value: MixerTier) => {
    setPendingTier(value)
  }

  const handleSaveTier = () => {
    if (pendingTier) {
      setTier(pendingTier)
      chrome.storage.local.set({ mixerTier: pendingTier })
    }
    setEditingTier(false)
    setPendingTier(null)
  }

  const handleCancelTier = () => {
    setEditingTier(false)
    setPendingTier(null)
  }

  // === Unlock flow ===
  // Show the input on first click; on second click (or Enter), validate
  // the code. Correct → flip proUnlocked, persist, immediately open the
  // edit flow so the user can pick Pro. Wrong → show inline error.
  const handleUnlockClick = () => {
    if (proUnlocked) return
    setShowUnlockInput(true)
    setUnlockError(null)
  }

  const handleUnlockSubmit = () => {
    const submitted = unlockInput.trim().toLowerCase()
    if (submitted === UNLOCK_CODE) {
      setProUnlocked(true)
      chrome.storage.local.set({ proUnlocked: true })
      setShowUnlockInput(false)
      setUnlockInput("")
      setUnlockError(null)
      // Drop the user straight into edit mode so they can pick Pro.
      setEditingTier(true)
      setPendingTier(tier)
    } else {
      setUnlockError("Invalid code")
    }
  }

  const handleUnlockCancel = () => {
    setShowUnlockInput(false)
    setUnlockInput("")
    setUnlockError(null)
  }

  const handleOpenAll = () => {
    chrome.runtime.sendMessage({
      type: "OPEN_ALL",
      services: SERVICES
    } satisfies ExtensionMessage)
  }

  const handleRefresh = () => {
    chrome.runtime.sendMessage({
      type: "REFRESH_ALL",
      services: SERVICES
    } satisfies ExtensionMessage)
  }

  const handleOpen = (service: AIService) => {
    chrome.runtime.sendMessage({
      type: "OPEN_SERVICE",
      service
    } satisfies ExtensionMessage)
  }

  // === Plan task ===
  const handlePlanTask = async () => {
    // Prompt-size sanity check. ChatGPT and Gemini cap input around
    // 32K characters; pastes much larger than that get truncated or
    // silently rejected by the site. Claude is more forgiving (~200K)
    // but still risky at extreme sizes. Warn the user before they
    // discover this through a stuck "Running…" state.
    const LARGE_PROMPT_WARN_CHARS = 30_000
    if (task.length >= LARGE_PROMPT_WARN_CHARS) {
      const proceed = confirm(
        `This prompt is ${task.length.toLocaleString()} characters. ChatGPT and Gemini ` +
          `typically reject or truncate prompts over ~30,000 characters. ` +
          `Claude can handle it. The task may fail for some services.\n\n` +
          `Continue anyway?`
      )
      if (!proceed) return
    }

    setPhase({ kind: "planning" })

    const signedInServices = SERVICES.filter(
      (s) => statuses[s]?.authState === "signed_in"
    )
    if (signedInServices.length === 0) {
      setPhase({
        kind: "error",
        message: "No AI services are connected. Sign in to all of them to start."
      })
      return
    }

    try {
      const res = await fetch(PLANNER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          availableServices: { signedIn: signedInServices },
          subscriptions: subs,
          tier
        })
      })
      if (!res.ok) {
        const errorBody = await res.text()
        let message = `Planner returned ${res.status}`
        try {
          const parsed = JSON.parse(errorBody)
          if (parsed?.detail) message = String(parsed.detail)
        } catch {
          if (errorBody) message = errorBody.slice(0, 300)
        }
        throw new Error(message)
      }
      const plan: TaskPlan = await res.json()
      setPhase({ kind: "plan_ready", plan })
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to reach planner"
      })
    }
  }

  // === Execute the planned task ===
  const handleRunPlan = (plan: TaskPlan) => {
    const proposerStates: Partial<
      Record<AIService, "pending" | "running" | "done" | "failed">
    > = {}
    plan.proposers.forEach((p) => {
      proposerStates[p.service] = "pending"
    })

    setPhase({
      kind: "executing",
      plan,
      proposerStates,
      proposerErrors: {},
      aggregatorState: "pending",
      criticState: "pending",
      revisionState: "pending"
    })

    const port = chrome.runtime.connect({ name: "task-execution" })
    portRef.current = port

    port.onMessage.addListener((update: TaskUpdate) => {
      setPhase((prev) => {
        if (prev.kind !== "executing") return prev

        if (update.type === "PROPOSER_STARTED") {
          return {
            ...prev,
            proposerStates: {
              ...prev.proposerStates,
              [update.service]: "running"
            }
          }
        }
        if (update.type === "PROPOSER_DONE") {
          return {
            ...prev,
            proposerStates: {
              ...prev.proposerStates,
              [update.service]: "done"
            }
          }
        }
        if (update.type === "PROPOSER_FAILED") {
          return {
            ...prev,
            proposerStates: {
              ...prev.proposerStates,
              [update.service]: "failed"
            },
            proposerErrors: {
              ...prev.proposerErrors,
              [update.service]: update.error
            }
          }
        }
        if (update.type === "AGGREGATOR_STARTED") {
          return { ...prev, aggregatorState: "running" }
        }
        if (update.type === "AGGREGATOR_DONE") {
          return {
            ...prev,
            aggregatorState: "done",
            finalText: update.text
          }
        }
        if (update.type === "CRITIC_STARTED") {
          return { ...prev, criticState: "running" }
        }
        if (update.type === "CRITIC_DONE") {
          return { ...prev, criticState: "done" }
        }
        if (update.type === "REVISION_STARTED") {
          return { ...prev, revisionState: "running" }
        }
        if (update.type === "REVISION_DONE") {
          return {
            ...prev,
            revisionState: "done",
            finalText: update.text
          }
        }
        if (update.type === "TASK_COMPLETE") {
          const successfulProposers = Object.entries(prev.proposerStates)
            .filter(([, state]) => state === "done")
            .map(([service]) => service as AIService)
          return {
            kind: "complete",
            plan: prev.plan,
            finalText: update.finalText,
            successfulProposers
          }
        }
        if (update.type === "TASK_ERROR") {
          return { kind: "error", message: update.error }
        }
        return prev
      })
    })

    port.postMessage({
      type: "EXECUTE_TASK",
      plan,
      prompt: task
    } satisfies ExtensionMessage)
  }

  const handleReset = () => {
    portRef.current?.disconnect()
    portRef.current = null
    setTask("")
    setPhase({ kind: "idle" })
  }

  // Gating: Plan button needs all services connected.
  const allConnected = SERVICES.every(
    (s) => statuses[s]?.authState === "signed_in"
  )
  const missingServices = SERVICES.filter(
    (s) => statuses[s]?.authState !== "signed_in"
  )

  // While in a non-idle phase, hide the settings sections so the active view
  // owns the whole panel. Less visual noise during planning/running/results.
  const showSettings = phase.kind === "idle"

  return (
    <div className="app">
      <div className="header">
        <div className="brand">
          <MixerLogo />
          <h1 className="title">MixerAI</h1>
        </div>
        <button
          className="header-refresh"
          onClick={handleRefresh}
          title="Re-check connections">
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg">
            <path
              d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M12 1.5V4.5H9M4 14.5V11.5H7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {showSettings && (
        <>
          <div className="section section-tight">
            <p className="section-label">Connections</p>
            {SERVICES.map((service) => {
              const state = statuses[service]?.authState
              return (
                <div key={service} className="service-row">
                  <div className="service-name">
                    <span className={dotClass(state)} />
                    <span>{LABELS[service]}</span>
                  </div>
                  <div className="service-meta">
                    <span className="status-text">{statusText(state)}</span>
                    {state !== "signed_in" && (
                      <button
                        className="open-link"
                        onClick={() => handleOpen(service)}>
                        Open →
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            {!allConnected && (
              <button className="open-all-btn" onClick={handleOpenAll}>
                Open all missing tabs
              </button>
            )}
          </div>

          <div className="section section-tight">
            <div className="section-head">
              <p className="section-label">Plan</p>
              {!proUnlocked ? (
                !showUnlockInput ? (
                  <button className="edit-btn" onClick={handleUnlockClick}>
                    Unlock
                  </button>
                ) : (
                  <div className="edit-actions unlock-row">
                    <input
                      className="unlock-input"
                      type="password"
                      autoFocus
                      placeholder="Enter code"
                      value={unlockInput}
                      onChange={(e) => {
                        setUnlockInput(e.target.value)
                        if (unlockError) setUnlockError(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleUnlockSubmit()
                        if (e.key === "Escape") handleUnlockCancel()
                      }}
                    />
                    <button className="edit-btn" onClick={handleUnlockCancel}>
                      Cancel
                    </button>
                    <button className="save-btn" onClick={handleUnlockSubmit}>
                      OK
                    </button>
                  </div>
                )
              ) : !editingTier ? (
                <button className="edit-btn" onClick={handleEditTier}>
                  Edit
                </button>
              ) : (
                <div className="edit-actions">
                  <button className="edit-btn" onClick={handleCancelTier}>
                    Cancel
                  </button>
                  <button className="save-btn" onClick={handleSaveTier}>
                    Save
                  </button>
                </div>
              )}
            </div>
            {unlockError && (
              <p className="unlock-error">{unlockError}</p>
            )}
            <div className="tier-group">
              {TIER_OPTIONS.map((opt) => {
                const isCurrent = tier === opt.value
                const isPending = editingTier && pendingTier === opt.value
                let cls = "tier"
                if (!editingTier && isCurrent) cls += " tier-active"
                else if (editingTier && isPending) cls += " tier-pending"
                else if (editingTier && isCurrent && !isPending)
                  cls += " tier-was-active"
                return (
                  <button
                    key={opt.value}
                    className={cls}
                    onClick={() =>
                      editingTier
                        ? handlePickPendingTier(opt.value)
                        : undefined
                    }
                    disabled={!editingTier}>
                    <span className="tier-label">{opt.label}</span>
                    <span className="tier-sub">{opt.sub}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="section section-tight">
            <div className="section-head">
              <p className="section-label">Subscriptions</p>
              {!editingSubs ? (
                <button className="edit-btn" onClick={handleEditSubs}>
                  Edit
                </button>
              ) : (
                <div className="edit-actions">
                  <button className="edit-btn" onClick={handleCancelSubs}>
                    Cancel
                  </button>
                  <button className="save-btn" onClick={handleSaveSubs}>
                    Save
                  </button>
                </div>
              )}
            </div>
            {SERVICES.map((service) => {
              const options = SUB_OPTIONS[service]
              const current = subs[service]
              const pending = pendingSubs?.[service]
              const onlyOption = options.length === 1
              return (
                <div key={service} className="sub-row">
                  <span className="sub-name">{LABELS[service]}</span>
                  <div className="pill-group">
                    {options.map((opt) => {
                      const isCurrent = current === opt.value
                      const isPending = editingSubs && pending === opt.value
                      let cls = "pill"
                      if (!editingSubs && isCurrent) cls += " pill-active"
                      else if (editingSubs && isPending) cls += " pill-pending"
                      else if (editingSubs && isCurrent && !isPending)
                        cls += " pill-was-active"
                      return (
                        <button
                          key={opt.value}
                          className={cls}
                          onClick={() =>
                            editingSubs
                              ? handlePickPendingSub(service, opt.value)
                              : undefined
                          }
                          disabled={!editingSubs || onlyOption}>
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {phase.kind === "idle" && (
        <div className="task-area task-area-flex">
          <p className="section-label">New task</p>
          <textarea
            className="task-input"
            rows={4}
            placeholder="What do you want to get done?"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          {!allConnected && (
            <p className="gate-hint">
              Sign in to {missingServices.map((s) => LABELS[s]).join(", ")} to
              unlock Plan task.
            </p>
          )}
          <button
            className="plan-btn"
            disabled={!task.trim() || !allConnected}
            onClick={handlePlanTask}>
            {!allConnected ? "Connect all services first" : "Plan task"}
          </button>
        </div>
      )}

      {phase.kind === "planning" && (
        <div className="task-area task-area-flex">
          <div className="status-banner">
            <div className="spinner" />
            <span>Routing your task to the best models…</span>
          </div>
        </div>
      )}

      {phase.kind === "plan_ready" && (
        <PlanCard
          task={task}
          plan={phase.plan}
          tier={tier}
          onRun={() => handleRunPlan(phase.plan)}
          onCancel={handleReset}
        />
      )}

      {phase.kind === "executing" && (
        <ExecutionView
          phase={phase}
          onCancel={handleReset}
          onOpenService={handleOpen}
        />
      )}

      {phase.kind === "complete" && (
        <ResultView
          plan={phase.plan}
          finalText={phase.finalText}
          successfulProposers={phase.successfulProposers}
          onOpenAggregator={() => handleOpen(phase.plan.aggregator.service)}
          onReset={handleReset}
        />
      )}

      {phase.kind === "error" && (
        <div className="task-area task-area-flex">
          <div className="error-banner">
            <strong>Something went wrong.</strong>
            <p>{phase.message}</p>
          </div>
          <button className="plan-btn" onClick={handleReset}>
            Start over
          </button>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Plan card — cleaner, more visual layout. Less prose.
// ============================================================

function PlanCard({
  task,
  plan,
  tier,
  onRun,
  onCancel
}: {
  task: string
  plan: TaskPlan
  tier: MixerTier
  onRun: () => void
  onCancel: () => void
}) {
  const isSimple = plan.strategy === "simple"
  const hasCritic = plan.strategy === "moa_critic" && plan.critic

  return (
    <div className="task-area task-area-flex">
      <div className="plan-card">
        <div className="plan-meta">
          <span className="badge">{plan.task_type}</span>
          <span className="badge badge-muted">{plan.difficulty}</span>
        </div>

        <div className="plan-pipeline">
          <div className="pipeline-stage">
            <div className="pipeline-stage-label">
              {isSimple ? "Answering" : "Proposers"}
            </div>
            <div className="pipeline-services">
              {plan.proposers.map((p) => (
                <span key={p.service} className="pipeline-chip">
                  {LABELS[p.service]}
                </span>
              ))}
            </div>
          </div>

          {!isSimple && (
            <>
              <div className="pipeline-arrow">→</div>
              <div className="pipeline-stage">
                <div className="pipeline-stage-label">Synthesizer</div>
                <div className="pipeline-services">
                  <span className="pipeline-chip pipeline-chip-strong">
                    {LABELS[plan.aggregator.service]}
                  </span>
                </div>
              </div>
            </>
          )}

          {hasCritic && plan.critic && (
            <>
              <div className="pipeline-arrow">→</div>
              <div className="pipeline-stage">
                <div className="pipeline-stage-label">Audit</div>
                <div className="pipeline-services">
                  <span className="pipeline-chip pipeline-chip-strong">
                    {LABELS[plan.critic.service]}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="plan-format">{plan.output_format}</div>

        {!hasCritic && plan.strategy === "moa" && tier !== "pro" && (
          <div className="upsell">
            <span className="upsell-dot" />
            Pro adds an independent critic pass that audits the synthesis
            for errors before it ships.
          </div>
        )}
      </div>

      <div className="task-prompt-preview">
        <p className="task-prompt-text">{task}</p>
      </div>

      <div className="button-row">
        <button className="secondary-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="plan-btn" onClick={onRun}>
          Run
        </button>
      </div>
    </div>
  )
}

// ============================================================
// Execution view — shows proposers, synthesizer, and (Pro+) critic + revision
// ============================================================

function ExecutionView({
  phase,
  onCancel,
  onOpenService
}: {
  phase: Extract<Phase, { kind: "executing" }>
  onCancel: () => void
  onOpenService: (service: AIService) => void
}) {
  const hasCritic = phase.plan.strategy === "moa_critic" && phase.plan.critic

  // Track how long each service has been in "running" state.
  // After 60 seconds of running, we add a subtle "been a while" visual
  // hint to the row so the user knows they can peek at the tab.
  // The check button is always visible while running; the hint is
  // additive, not a replacement.
  const [delayedServices, setDelayedServices] = useState<Set<string>>(new Set())
  const runningSinceRef = useRef<Record<string, number>>({})

  useEffect(() => {
    const allRunning: { key: string; service: AIService }[] = []
    phase.plan.proposers.forEach((p) => {
      if (phase.proposerStates[p.service] === "running") {
        allRunning.push({ key: `proposer-${p.service}`, service: p.service })
      }
    })
    if (phase.aggregatorState === "running") {
      allRunning.push({
        key: "aggregator",
        service: phase.plan.aggregator.service
      })
    }
    if (phase.criticState === "running" && phase.plan.critic) {
      allRunning.push({ key: "critic", service: phase.plan.critic.service })
    }
    if (phase.revisionState === "running") {
      allRunning.push({
        key: "revision",
        service: phase.plan.aggregator.service
      })
    }

    // Stamp start time for newly-running rows; clear stamps for rows
    // that are no longer running.
    const now = Date.now()
    const currentlyTracked = runningSinceRef.current
    const newTracked: Record<string, number> = {}
    for (const { key } of allRunning) {
      newTracked[key] = currentlyTracked[key] ?? now
    }
    runningSinceRef.current = newTracked

    // Tick every 5s to update the delayed-services set. We don't need
    // higher frequency — this only drives a subtle visual hint.
    const evaluate = () => {
      const t = Date.now()
      const delayed = new Set<string>()
      for (const [key, startedAt] of Object.entries(runningSinceRef.current)) {
        if (t - startedAt >= 60_000) delayed.add(key)
      }
      setDelayedServices(delayed)
    }
    evaluate()
    const interval = setInterval(evaluate, 5_000)
    return () => clearInterval(interval)
  }, [
    phase.proposerStates,
    phase.aggregatorState,
    phase.criticState,
    phase.revisionState,
    phase.plan
  ])

  const renderRow = (opts: {
    key: string
    state: "pending" | "running" | "done" | "failed"
    service: AIService
    label: string
    error?: string
  }) => {
    const isDelayed = opts.state === "running" && delayedServices.has(opts.key)
    const isRunning = opts.state === "running"
    const rowClass = `progress-row${isDelayed ? " progress-row-delayed" : ""}`
    return (
      <div key={opts.key} className="progress-row-wrap">
        <div className={rowClass}>
          <ProgressIcon state={opts.state} />
          <span className="progress-label">{opts.label}</span>
          {isRunning && (
            <button
              className="check-btn"
              onClick={() => onOpenService(opts.service)}
              title={
                isDelayed
                  ? "Taking a while — click to check this tab"
                  : "Open this tab"
              }
              aria-label={`Open ${LABELS[opts.service]} tab`}>
              ↗
            </button>
          )}
          <span className="progress-state">{stateLabel(opts.state)}</span>
        </div>
        {opts.state === "failed" && opts.error && (
          <div className="progress-error" title={opts.error}>
            {opts.error}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="task-area task-area-flex">
      <div className="section-head">
        <p className="section-label">Running</p>
        <button className="edit-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="progress-list">
        {phase.plan.proposers.map((p) =>
          renderRow({
            key: `proposer-${p.service}`,
            state: phase.proposerStates[p.service] ?? "pending",
            service: p.service,
            label: LABELS[p.service],
            error: phase.proposerErrors[p.service]
          })
        )}
        <div className="progress-divider" />
        {renderRow({
          key: "aggregator",
          state: phase.aggregatorState,
          service: phase.plan.aggregator.service,
          label: `${LABELS[phase.plan.aggregator.service]} · synthesizing`
        })}
        {hasCritic && phase.plan.critic && (
          <>
            {renderRow({
              key: "critic",
              state: phase.criticState,
              service: phase.plan.critic.service,
              label: `${LABELS[phase.plan.critic.service]} · auditing`
            })}
            {renderRow({
              key: "revision",
              state: phase.revisionState,
              service: phase.plan.aggregator.service,
              label: `${LABELS[phase.plan.aggregator.service]} · revising`
            })}
          </>
        )}
      </div>
      <p className="progress-hint">
        Tap <span className="progress-hint-icon">↗</span> to peek at a service.
        The task keeps running.
      </p>
    </div>
  )
}

function stateLabel(s: "pending" | "running" | "done" | "failed"): string {
  switch (s) {
    case "pending":
      return "Waiting"
    case "running":
      return "Running…"
    case "done":
      return "Done"
    case "failed":
      return "Failed"
  }
}

function ProgressIcon({
  state
}: {
  state: "pending" | "running" | "done" | "failed"
}) {
  if (state === "running") return <div className="spinner spinner-sm" />
  if (state === "done") return <span className="check-icon">✓</span>
  if (state === "failed") return <span className="fail-icon">×</span>
  return <span className="pending-dot" />
}

// ============================================================
// Result view — the synthesized answer lives in the aggregator's AI tab where
// it's natively rendered. We just confirm completion and let the user jump there.
// ============================================================

function ResultView({
  plan,
  successfulProposers,
  onOpenAggregator,
  onReset
}: {
  plan: TaskPlan
  finalText: string
  successfulProposers: AIService[]
  onOpenAggregator: () => void
  onReset: () => void
}) {
  const successCount = successfulProposers.length
  const plannedCount = plan.proposers.length
  const failedCount = plannedCount - successCount
  const failedServices = plan.proposers
    .map((p) => p.service)
    .filter((s) => !successfulProposers.includes(s))

  const isSimple = plan.strategy === "simple"
  const aggregatorLabel = LABELS[plan.aggregator.service]

  let summary: string
  if (isSimple) {
    summary = `Answer is in ${aggregatorLabel}`
  } else if (plan.strategy === "moa_critic") {
    summary = `Synthesized in ${aggregatorLabel} from ${successCount} draft${
      successCount === 1 ? "" : "s"
    }, audited, revised`
  } else {
    summary = `Synthesized in ${aggregatorLabel} from ${successCount} draft${
      successCount === 1 ? "" : "s"
    }`
  }

  return (
    <div className="task-area task-area-flex">
      <div className="result-done">
        <div className="result-done-icon">✓</div>
        <div className="result-done-text">
          <div className="result-done-title">Done</div>
          <div className="result-done-sub">{summary}</div>
        </div>
      </div>

      {failedCount > 0 && !isSimple && (
        <div className="result-failures">
          {failedServices.map((s) => LABELS[s]).join(", ")} failed
        </div>
      )}

      <div className="button-row">
        <button className="plan-btn" onClick={onOpenAggregator}>
          Open {aggregatorLabel}
        </button>
        <button className="secondary-btn" onClick={onReset}>
          New task
        </button>
      </div>
    </div>
  )
}
