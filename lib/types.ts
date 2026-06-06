export type AIService =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "deepseek"

export type AuthState =
  | "signed_in"
  | "signed_out"
  | "unknown"
  | "rate_limited"

export interface ServiceStatus {
  service: AIService
  authState: AuthState
  detectedAt: number
  url?: string
  notes?: string
}

// === Planning ===

// task_type is intentionally a free-form string — the planner LLM may pick
// labels like "algorithm" or "debugging" that aren't in any fixed enum.
export type TaskType = string

export type TaskDifficulty = "simple" | "moderate" | "hard"

/**
 * The execution strategy chosen by the planner.
 *
 *  - "simple"     : Single proposer = aggregator. No synthesis. Fast-path.
 *  - "moa"        : Standard Mixture-of-Agents. N proposers → 1 aggregator synthesizes.
 *  - "moa_critic" : Full pipeline (Pro+ only). N proposers → aggregator drafts →
 *                    a DIFFERENT model critiques → aggregator revises. Grounded in
 *                    Chain-of-Verification (Dhuliawala et al., Meta AI 2023):
 *                    independent critique catches hallucinations the drafter cannot
 *                    see in its own output.
 */
export type TaskStrategy = "simple" | "moa" | "moa_critic"

export interface ProposerSpec {
  service: AIService
  reason: string
}

export interface AggregatorSpec {
  service: AIService
  reason: string
}

/**
 * Critic that runs an independent audit pass after the aggregator drafts.
 * Should be a different model than the aggregator (different lab when possible)
 * to bring outside perspective — copying CoVe's "independence" principle.
 */
export interface CriticSpec {
  service: AIService
  reason: string
}

export interface TaskPlan {
  task_type: TaskType
  difficulty: TaskDifficulty
  /**
   * One-sentence directive describing exactly what shape the final answer
   * should take. Drives both proposer hints and aggregator instructions.
   */
  output_format: string
  rationale: string
  strategy: TaskStrategy
  proposers: ProposerSpec[]
  aggregator: AggregatorSpec
  /** Only set when strategy === "moa_critic". */
  critic?: CriticSpec
  estimated_seconds: number
  /**
   * v1.6.0: Optional per-task-instance guidance for the critic. When set,
   * the planner has identified specific failure modes worth hunting in THIS
   * particular task (not just the task-type defaults). Layered on top of
   * the task-type CRITIC_VARIANTS appendix.
   *
   * Example: for a Chicago/St-Louis DP algorithm question, this might be
   * "verify the stated O(n) complexity by counting operations; check
   * whether the base case handles n=0 and n=1 correctly."
   *
   * Older planners may not emit this field. The orchestrator treats it as
   * additive — when absent, falls back to task-type defaults alone.
   */
  critic_focus?: string
  /**
   * v1.6.0: Optional one-line explanation of WHY the planner picked this
   * strategy over alternatives. Not used at runtime; surfaces in logs for
   * debugging when planner output feels off. Additive — older planners may
   * not emit this.
   */
  strategy_rationale?: string
}

export interface ProposerResult {
  service: AIService
  text: string
  durationMs: number
}

// === Task execution updates (background → sidepanel) ===

export type TaskUpdate =
  | { type: "PROPOSER_STARTED"; service: AIService }
  | { type: "PROPOSER_DONE"; service: AIService; text: string; durationMs: number }
  | { type: "PROPOSER_FAILED"; service: AIService; error: string }
  | { type: "AGGREGATOR_STARTED"; service: AIService }
  | { type: "AGGREGATOR_DONE"; text: string; durationMs: number }
  | { type: "CRITIC_STARTED"; service: AIService }
  | { type: "CRITIC_DONE"; text: string; durationMs: number }
  | { type: "REVISION_STARTED"; service: AIService }
  | { type: "REVISION_DONE"; text: string; durationMs: number }
  | { type: "TASK_COMPLETE"; finalText: string }
  | { type: "TASK_ERROR"; error: string }

// === Adapter response (content script → background) ===

export interface AdapterResponse {
  ok: boolean
  text?: string
  error?: string
}

// === All extension messages ===

export type ExtensionMessage =
  // Auth state
  | { type: "AUTH_STATE_UPDATE"; payload: ServiceStatus }
  | { type: "STATUS_BROADCAST"; statuses: ServiceStatus[] }
  | { type: "CHECK_AUTH" }
  | { type: "REFRESH_ALL"; services: AIService[] }
  | { type: "OPEN_ALL"; services: AIService[] }
  | { type: "GET_ALL_STATUSES" }
  | { type: "OPEN_SERVICE"; service: AIService }
  // Prompt dispatch (background → content script)
  | { type: "SEND_PROMPT"; prompt: string }
  // Task execution (sidepanel ↔ background, via port)
  | { type: "EXECUTE_TASK"; plan: TaskPlan; prompt: string }
  | TaskUpdate
