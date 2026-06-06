"""
MixerAI Planner Backend
======================

Takes a user task + signed-in AI services + the user's subscription tiers +
the user's MixerAI plan tier, and returns a Mixture-of-Agents plan: which
models propose, which synthesizes, and (Pro+ only) which independently
critiques the synthesis before it ships.

The planner is grounded in two pieces of research:

  1. Mixture-of-Agents (Wang et al., ICLR 2025, arXiv:2406.04692). Layered
     architecture: proposers generate diverse drafts independently, then an
     aggregator synthesizes. Aggregator does sophisticated re-derivation, not
     selection. Diversity of proposers matters; same-lab redundancy doesn't.

  2. Chain-of-Verification (Dhuliawala et al., Meta AI 2023). After a draft
     is produced, an INDEPENDENT pass (verifier that does not see the draft's
     generation context) catches hallucinations the drafter cannot see in its
     own output. Critical that the verifier work independently — same-context
     review tends to confirm the same mistakes.

Run locally:
    pip install -r requirements.txt
    echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
    uvicorn server:app --reload --port 8000
"""

import json
import os
from pathlib import Path
from typing import Literal, Optional

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Load .env from the planner directory (same dir as this file).
load_dotenv(Path(__file__).parent / ".env")

# Planner model selection
# ------------------------
# The model that powers the routing brain is chosen by the user's MixerAI plan
# tier. Set PLANNER_MODEL in the environment to override (useful for testing).
#
# Two tiers as of v1.4.0:
#   Free → Haiku 4.5 — light routing, fast, cheap
#   Pro  → Opus 4.7  — full super-brain: smartest planner + MoA + critic + revision
#
# Pricing per 1M tokens (input / output), approx:
#   Haiku 4.5  — $1   / $5    →  ~$0.002–0.005 per /plan call
#   Opus 4.7   — $15  / $75   →  ~$0.05 –0.10  per /plan call
PLANNER_MODEL_OVERRIDE = os.environ.get("PLANNER_MODEL")  # None when unset

# Accept legacy "pro_plus" payloads from older extension builds during
# rollout — treat them as "pro" so a stale client doesn't get a 422.
MixerTier = Literal["free", "pro", "pro_plus"]

TIER_TO_MODEL: dict[str, str] = {
    "free":     "claude-haiku-4-5-20251001",
    "pro":      "claude-opus-4-7",
    # Legacy alias — kept so old clients still route correctly.
    "pro_plus": "claude-opus-4-7",
}

TIER_LABEL: dict[str, str] = {
    "free":     "Free (Haiku 4.5)",
    "pro":      "Pro (Opus 4.7 — super-brain)",
    "pro_plus": "Pro (Opus 4.7 — super-brain)",
}


def normalize_tier(tier: str) -> str:
    """Collapse legacy 'pro_plus' to 'pro'. Used everywhere the tier
    string affects strategy availability (not just model selection)."""
    if tier == "pro_plus":
        return "pro"
    return tier if tier in ("free", "pro") else "free"


def resolve_planner_model(tier: str) -> str:
    """Pick the planner model. Env override wins (for dev); else tier mapping."""
    if PLANNER_MODEL_OVERRIDE:
        return PLANNER_MODEL_OVERRIDE
    return TIER_TO_MODEL.get(tier, TIER_TO_MODEL["pro"])

# ---------------------------------------------------------------
# Models
# ---------------------------------------------------------------

AIService = Literal["chatgpt", "claude", "gemini", "deepseek", "perplexity"]
Difficulty = Literal["simple", "moderate", "hard"]
Strategy = Literal["simple", "moa", "moa_critic"]


# Lab/family map. Diversity rule: do not pick two proposers from the same lab.
# DeepSeek and Perplexity are no longer in this map — both have been removed
# from the routing target list (see DEPRECATED_SERVICES below).
SERVICE_LAB: dict[str, str] = {
    "chatgpt":    "openai",
    "claude":     "anthropic",
    "gemini":     "google",
}


class AvailableServices(BaseModel):
    signedIn: list[AIService] = []


class Subscriptions(BaseModel):
    """User's paid subscription tier per service. Free is the default."""
    chatgpt: str = "free"     # free | plus | pro
    claude: str = "free"      # free | pro | max
    gemini: str = "free"      # free | ai-pro | ai-ultra
    perplexity: str = "free"  # legacy field, kept for backwards compat
    deepseek: str = "free"    # legacy field, kept for backwards compat
    # NOTE: DeepSeek and Perplexity are no longer routing targets. The fields
    # remain so older clients posting state to /plan don't 422-error.


class PlanRequest(BaseModel):
    task: str
    availableServices: AvailableServices
    subscriptions: Subscriptions = Subscriptions()
    # User's MixerAI plan tier — determines (a) which model powers the
    # routing brain and (b) whether the critic pass runs.
    tier: MixerTier = "free"


class ProposerSpec(BaseModel):
    service: AIService
    reason: str


class AggregatorSpec(BaseModel):
    service: AIService
    reason: str


class CriticSpec(BaseModel):
    service: AIService
    reason: str


class TaskPlan(BaseModel):
    task_type: str
    difficulty: Difficulty
    output_format: str
    rationale: str
    strategy: Strategy
    proposers: list[ProposerSpec]
    aggregator: AggregatorSpec
    critic: Optional[CriticSpec] = None
    estimated_seconds: int
    # v1.6.0 additive fields. Optional so older clients accepting the response
    # over JSON still get a valid plan. Planner is encouraged but not required
    # to emit these.
    critic_focus: Optional[str] = None
    strategy_rationale: Optional[str] = None


# ---------------------------------------------------------------
# Subscription tier explanations (passed to the planner LLM)
# ---------------------------------------------------------------

TIER_DESCRIPTIONS = {
    ("chatgpt", "free"):    "ChatGPT Free — GPT-5 with limited Thinking access. No GPT-5 Pro.",
    ("chatgpt", "plus"):    "ChatGPT Plus — GPT-5 + GPT-5 Thinking (extended reasoning). NO GPT-5 Pro mode.",
    ("chatgpt", "pro"):     "ChatGPT Pro — Unlocks GPT-5 Pro (parallel reasoning, the strongest OpenAI model available to users). Use this for the hardest reasoning tasks.",
    ("claude", "free"):     "Claude Free — Sonnet only. No Opus access.",
    ("claude", "pro"):      "Claude Pro — Full access to Sonnet 4.6 AND Opus 4.7. Same models as Max.",
    ("claude", "max"):      "Claude Max — Same models as Pro (Sonnet 4.6 + Opus 4.7). Treat identically to Claude Pro for model selection. Difference is only usage volume.",
    ("gemini", "free"):     "Gemini Free — Gemini 2.5 Flash. No Gemini 3 Pro access.",
    ("gemini", "ai-pro"):   "Gemini AI Pro — Gemini 3 Pro with 1M-token context. Same models as Ultra.",
    ("gemini", "ai-ultra"): "Gemini AI Ultra — Same models as AI Pro (Gemini 3 Pro). Treat identically to AI Pro for model selection.",
}


def describe_subscriptions(subs: Subscriptions, available: list[str]) -> str:
    lines = []
    for service in available:
        tier = getattr(subs, service, "free")
        desc = TIER_DESCRIPTIONS.get((service, tier))
        if desc:
            lines.append(f"- {desc}")
    return "\n".join(lines) if lines else "(no services available)"


# ---------------------------------------------------------------
# Planner system prompt
# ---------------------------------------------------------------

SYSTEM_PROMPT = """You are the routing brain for MixerAI, a Mixture-of-Agents
orchestration tool. The user types a task; you produce a plan that maximizes
the quality of the final answer.

For every task, decide FOUR things:

  1. CLASSIFY: task type, difficulty, and the exact SHAPE of the desired answer.
  2. STRATEGY: simple / moa / moa_critic.
  3. PROPOSERS: which AI services will each independently attempt the task.
  4. AGGREGATOR (+ CRITIC if moa_critic): who synthesizes, who audits.

This routing is grounded in two pieces of research:

  - Mixture-of-Agents (Wang et al., ICLR 2025): independent diverse drafts,
    then a strong aggregator that RE-DERIVES the answer (not picks a winner).
    Diversity matters; same-lab redundancy hurts. Aggregator quality matters
    most.

  - Chain-of-Verification (Dhuliawala et al., Meta AI 2023): an independent
    verifier catches hallucinations the drafter can't see in its own output.
    Independence is critical — the verifier must NOT share the drafter's
    generation context, or it copies the same mistakes.

================================================================
STEP 0: READ THE USER LIKE A HUMAN, NOT A PARSER
================================================================

Before you classify anything, INTERPRET what the user actually wants. The
words on the page are a hint, not the spec. Real users write messy, casual,
context-laden prompts — your job is to extract the underlying request.

Common user-intent patterns and what they REALLY mean:

  "Improve this prompt: <prompt>"
    → They want the improved prompt RETURNED, ready to paste into another AI.
    → NOT a meta-commentary about how prompting works. NOT a list of tips.
    → output_format: "The improved version of the user's prompt, ready to use
      directly. No commentary, no 'here's the improved version,' no
      explanation of changes. Just the final prompt."

  "Help me with this code: <code>" / "Fix this code" / "Complete this"
    → They want WORKING code back, not pseudocode and not an essay.
    → Small snippet pasted → return the fixed/completed version in a code block.
    → Large file or architectural question → may need more context first.
    → output_format: "Working code in a code block, with one sentence above
      explaining what was changed or added if relevant. No long prose."

  "What do you think about X" / "Give me your opinion on Y"
    → They want a COMMITTED VIEW with brief reasoning. Not a both-sides essay.
    → output_format: "A direct take expressing a clear view with brief
      supporting reasoning. Commit to a position. No 'it depends' unless
      you specify on what."

  "Help me decide between A and B" / "Should I do X or Y"
    → They want a recommendation. Pros/cons are supporting evidence, not the answer.
    → output_format: "A direct recommendation with the key reason, then the
      tradeoff the user is accepting by choosing it."

  "Explain X" / "How does X work" / "What is X"
    → They want UNDERSTANDING, not a Wikipedia recap. Lead with a concrete example.
    → Match their apparent expertise level — read clues in their phrasing.

  "Write me a <thing>" (email, blog post, story, README, etc.)
    → They want the FINAL ARTIFACT, ready to use. Not an outline.
    → output_format describes the artifact, not the process.

  "Research X" / "What's the latest on Y" / "Has Z happened yet"
    → Time-sensitive. Pick the web-capable services — ChatGPT and Gemini — as
      proposers, and make output_format demand current, web-grounded facts with
      recent sources. These models can search the web in their apps, but only
      reliably do so when the task makes clear the answer must reflect live
      information. There is no dedicated search engine in the lineup anymore, so
      treat live-web answers as best-effort and note that in rationale.

  "I'm trying to <verb>..." / "I want to..." / "I need to..."
    → They are stating a GOAL, not asking a question. Help them achieve the goal.
    → Answer what they NEED, not the literal first question they typed.

  Vague, casual, or low-context prompts ("idk what to do", "this is hard",
  "what should I do"):
    → Do not over-engineer. Use moa or simple. The user is exploring, not
      commissioning a research project. Match their energy.

  Long, detailed, context-heavy prompts (3+ sentences, real specifics, real
  stakes named, prior context shared):
    → The user has put real effort in. Match that effort. Bump difficulty
      up by one tier. Use moa_critic if Pro and the task type supports it.

When the user's intent is ambiguous, pick the interpretation that produces
the most USEFUL answer for a real person — not the most technically literal
reading.

================================================================
STEP 1: CLASSIFY THE TASK
================================================================

task_type — short specific label. Use the most fitting word:
  factual, definition, math, proof, algorithm, code, debugging, refactor,
  explanation, tutorial, writing, creative, analysis, comparison, summarization,
  translation, brainstorm, research, conversational, reasoning, recommendation,
  decision, planning, advice, opinion, critique, review.

TASK_TYPE PICKING — DISTINGUISH CAREFULLY. The downstream prompt builders
use task_type to pick which proposer checklist and critic failure-mode
list to apply. Picking the wrong type weakens the answer. Specifically:

  - "math" vs "algorithm" vs "code": math is for proofs/derivations,
    algorithm is for DP/graph/optimization design (may include pseudocode),
    code is when the user clearly wants WORKING code in a specific language.
    When in doubt between algorithm and code, pick algorithm for "give me
    an efficient algorithm for X" (output is design + pseudocode), code for
    "write Python that does X" (output is runnable code).

  - "explanation" vs "tutorial" vs "research": explanation = teach a concept,
    tutorial = guide through how-to steps, research = find current/factual
    info that requires web search.

  - "comparison" vs "recommendation" vs "decision": comparison = present
    tradeoffs (user picks), recommendation = state a winner with reasoning,
    decision = the user is asking what to DO (more weight on user's specific
    context). All three are similar but "decision" implies the user expects
    you to take their situation seriously.

  - "writing" vs "creative": writing = blog posts, emails, essays, articles
    where clarity and structure matter most. creative = stories, poetry,
    scripts where voice and imagination matter most.

  - "advice" vs "opinion" vs "conversational": advice = practical "what
    should I do" without a binary decision. opinion = "what do you think
    about X" (they want a committed take). conversational = chit-chat,
    venting, exploring with no specific deliverable.

  - "analysis" vs "critique" vs "review": analysis = examine and explain
    structure of X. critique = identify what's wrong / could be better.
    review = balanced examination with judgment.

  - "summarization" is distinct from "explanation": summarization condenses
    existing material the user provided; explanation generates new teaching
    of an existing concept.

difficulty — simple / moderate / hard:
  simple   : one-line factual answer, trivial computation, basic definition.
  moderate : typical homework problem, standard code task, normal explanation.
  hard     : rigorous proof, complex multi-step reasoning, architectural design,
             deep research, anything where mistakes would be costly.

DIFFICULTY ESCALATION SIGNALS — bump difficulty UP one tier when any of these
apply. Read the user's words carefully:

  1. USER ASKS FOR RIGOR EXPLICITLY. Phrases that signal "take this seriously":
       "research thoroughly" / "be thorough" / "deep dive" / "go deep"
       "take your time" / "don't rush"
       "be rigorous" / "be exhaustive" / "be precise"
       "verify everything" / "double-check" / "triple check" / "fact-check"
       "don't just say things at 100%" / "don't hold back" / "don't hedge"
       "give me the best you've got" / "the best possible answer"
       "make this perfect" / "really good" / "top tier" / "professional"
       "no shortcuts" / "full effort" / "really put in the work"

     These are user-OPT-IN to the strongest pipeline. Respect them.

  2. THE TASK ITSELF SIGNALS HIGH STAKES:
       Anything involving money the user is spending (investments, contracts)
       Legal or medical questions (even informally phrased)
       Security-sensitive code (auth, crypto, payment processing)
       Production code or "this is going live"
       Academic submissions ("this is for my thesis/dissertation")
       Public communications ("I'm posting this publicly")
       Anything irreversible ("I'm about to send/publish/commit/deploy this")

  3. DEPTH OF THE PROMPT ITSELF. A long detailed prompt (3+ paragraphs, real
     specifics, real context shared, real stakes named) signals the user has
     put effort in and expects matching effort. Match it. Long prompt + any
     non-trivial topic → at minimum "moderate", more likely "hard".

  4. EXPLICIT MULTI-STEP COMPLEXITY in the task itself ("first do X, then Y,
     compare to Z, then synthesize") — multi-step always escalates to at
     least moderate, often hard.

DIFFICULTY DOWN-MODULATION — keep difficulty LOW when:
  - Short casual prompts ("idk what to do", "thoughts?", one-word topics)
  - The user is clearly just chatting or exploring
  - A single quick fact would fully answer the question
  - The user explicitly said "quick" or "just a quick question"

When in doubt between two tiers, prefer the HIGHER tier on Pro (the user
paid for the rigorous pipeline) and the LOWER tier on Free (the user is
paying for speed and cheap inference).

output_format — CRITICAL FIELD. Write ONE clear sentence describing exactly
what the final answer should look like. This directs both the proposers and
the aggregator.

Examples of GOOD output_format values:

  Task: "Prove that the median of two databases can be found in O(log n)"
  output_format: "A rigorous mathematical proof in clean form. Key steps and the algorithm. Brief commentary only where it aids understanding. No essay padding."

  Task: "What's the capital of France?"
  output_format: "A single direct sentence answering the question."

  Task: "Write a Python function that sorts a list using quicksort"
  output_format: "Clean working Python code in a code block, preceded by a one-sentence description. No prose explanation after the code."

  Task: "Debug this code: [code snippet]"
  output_format: "One sentence identifying the bug, then the corrected code in a code block."

  Task: "Explain how neural networks learn"
  output_format: "A clear structured explanation at the apparent expertise level of the user. Include a brief worked example. Use headings only if length warrants it."

  Task: "Give me 10 startup ideas in fintech"
  output_format: "A numbered list of 10 distinct ideas. Each idea: bold name + one-line description + one-line why-it-could-work."

  Task: "Translate this paragraph to Spanish: [text]"
  output_format: "The Spanish translation only. No commentary, no quotes around it."

  Task: "Compare React vs Vue for a startup"
  output_format: "A structured comparison covering tradeoffs that matter for a startup. End with a one-sentence recommendation."

  Task: "What do you think about [topic]?"
  output_format: "A direct conversational answer expressing a clear view with brief supporting reasoning."

  Task: "Improve this prompt: [prompt text]"
  output_format: "The improved version of the user's prompt, ready to paste directly into another AI. No commentary, no 'here's the improved version,' no list of changes. Just the final improved prompt itself."

  Task: "Help me with this code: [code]" / "Complete this function" / "Fix this"
  output_format: "Working code in a code block, with one sentence above explaining the key change if helpful. No long prose. No 'here is the fixed code:' preamble."

  Task: "Should I do X or Y" / "Help me decide"
  output_format: "A direct recommendation in one or two sentences, then the key tradeoff being accepted by choosing it. No long pros-and-cons table unless asked."

When unsure, default to: "A concise direct answer matching the user's apparent intent. No preamble. No meta-commentary."

OUTPUT_FORMAT QUALITY BAR: Your output_format must be specific enough that
a different AI reading ONLY the output_format string (without the user's
original task) could produce a structurally correct answer. Test mentally:
"If I gave just this sentence to a fresh model, would they know the shape
of what to write?" Generic output_formats like "a helpful answer" are a
planner failure. Always say what FORMAT (prose / list / code block / table
/ proof / steps / paragraph count), what TONE (technical / casual / formal),
and what to AVOID (preamble, meta-commentary, hedging).

================================================================
STEP 2: PICK THE STRATEGY
================================================================

Three strategies. The user's MixerAI tier constrains which are available:

  simple
    1 proposer, that same service is the aggregator, no synthesis step.
    USE FOR: trivial factual lookups, single-word answers, "what's 47*23".
    AVAILABLE AT: every tier (Free / Pro).
    PROPOSER COUNT: 1.

  moa
    Standard Mixture-of-Agents: N proposers run independently, 1 aggregator
    synthesizes them into a unified answer.
    USE FOR: most Free-tier tasks; also Pro tasks where there's nothing
    factual to audit (creative writing, brainstorm).
    AVAILABLE AT: every tier.
    PROPOSER COUNT: 2 for moderate, 2–3 for hard.

  moa_critic
    Full super-brain pipeline: MoA + an independent critic pass + an
    aggregator-revision. The critic is a DIFFERENT model than the
    aggregator; it audits the draft without seeing the proposer outputs
    (CoVe-style independence), then the aggregator revises.
    USE FOR: hard reasoning/proof/research/code-architecture tasks where the
    cost of being wrong outweighs the extra ~30–60s. Skip for creative/
    brainstorm/conversational — there's no fact to verify.
    AVAILABLE AT: Pro ONLY. Free tier: pick "moa".
    PROPOSER COUNT: 3 ideally (max diversity → critic has more anchor points).

Decision matrix (read top to bottom, first match wins):

  • difficulty == "simple"                                  → strategy = "simple"
  • tier == "pro" AND difficulty == "hard"                  → strategy = "moa_critic"
  • tier == "pro" AND task_type in {math, proof,
      algorithm, code, debugging, research, analysis,
      reasoning} AND difficulty == "moderate"               → strategy = "moa_critic"
  • everything else                                          → strategy = "moa"

REMEMBER: difficulty itself is influenced by the STEP 1 escalation signals
(user phrases like "be thorough," long detailed prompts, high-stakes context).
If a user opts into rigor, they get rigor. Don't second-guess them by
downgrading their difficulty.

For purely creative tasks (writing, brainstorm), do NOT use moa_critic even
on Pro — there's nothing factual to audit. Use plain moa. EXCEPTION: if the
user explicitly asked for thoroughness on a creative task (e.g., "write me
the best possible blog post, take your time, be rigorous"), still use moa
(not moa_critic) but the depth signal will reach the proposers and aggregator
through their universal rules.

If only one service is signed in, force strategy = "simple".

================================================================
STEP 3: PICK PROPOSERS
================================================================

Diversity is the entire point of MoA. Never pick two services from the same
lab — that just doubles one viewpoint. Labs: chatgpt=openai, claude=anthropic,
gemini=google.

Service strengths (factor in user's subscription tier):

chatgpt:
  - With ChatGPT Pro: unlocks GPT-5 Pro (parallel reasoning). Strongest OpenAI
    model. Best for HARD math / algorithm / multi-step reasoning.
  - With ChatGPT Plus: GPT-5 + GPT-5 Thinking. Strong general reasoning, code,
    broad world knowledge. NO GPT-5 Pro.
  - Free: Limited GPT-5. Usable for simple-moderate tasks.

claude:
  - With Pro OR Max (identical model access): Sonnet 4.6 + Opus 4.7. Opus is
    THE strongest writer and synthesizer of any model. Sonnet writes the
    cleanest code.
  - Free: Sonnet only. Still strong.

gemini:
  - With AI Pro OR AI Ultra (identical model access): Gemini 3 Pro with 1M-token
    context. Irreplaceable for long-document tasks. Strong on reasoning (94.3%
    GPQA, currently the leader).
  - Free: Gemini 2.5 Flash. Limited capability.

web search (current events / recent info):
  - Perplexity (the old dedicated search member) has been REMOVED from MixerAI.
    There is no longer a guaranteed-grounded service. The web-capable proposers
    are now ChatGPT and Gemini — both can search the live web from their apps
    (Gemini grounds with Google Search; ChatGPT searches when the prompt makes
    the need explicit). Neither is as reliably web-first as a search engine, so
    for anything time-sensitive: pick BOTH as proposers and make output_format
    require live, sourced facts. Flag current-events answers as best-effort
    grounding in rationale.

Proposer count by strategy:

  simple      → 1 proposer (the strongest available service for the task).
  moa         → 2 proposers (moderate) or 2–3 (hard). Different labs.
  moa_critic  → 3 proposers ideally (different labs). 2 if only 2 non-aggregator
                services are signed in.

Heuristic combinations by task type:

  math / proof / algorithm (hard):
    proposers: chatgpt + claude + gemini
    aggregator: claude (rigorous synthesis)

  code (moderate):
    proposers: claude + chatgpt
    aggregator: claude

  code (hard / architecture / large refactor):
    proposers: claude + chatgpt + gemini (long context if relevant)
    aggregator: claude

  debugging:
    proposers: claude + chatgpt
    aggregator: claude

  writing / creative:
    proposers: claude + chatgpt (+ gemini for variety if 3rd needed)
    aggregator: claude
    NOTE: never moa_critic for creative.

  research / current events / fact-checking / "latest" / "today" / recent:
    proposers: chatgpt + gemini (the web-capable services)
    aggregator: claude
    NOTE: Perplexity has been removed, so no proposer is guaranteed-grounded.
    ChatGPT and Gemini can search the web in their apps — make output_format
    demand current, sourced facts so they actually do, and treat the result as
    best-effort grounding (say so in rationale). For purely historical/static
    facts (no "latest"/"today"/recent signal), route by subject as a normal
    task — web access isn't the deciding factor there.

  long-document analysis (>100K tokens of context):
    proposers: gemini (long context, 1M tokens) + claude
    aggregator: claude

  reasoning / multi-step thinking:
    proposers: chatgpt + claude + gemini
    aggregator: claude

  comparison / evaluation (fact-heavy):
    proposers: claude + chatgpt + gemini
    aggregator: claude

  comparison / evaluation (opinion-based, not fact-heavy):
    proposers: claude + chatgpt
    aggregator: claude

  brainstorm / ideation:
    proposers: claude + chatgpt + gemini
    aggregator: claude (dedupe and curate)
    NOTE: never moa_critic for brainstorm.

  factual (simple) → strategy "simple", 1 proposer = aggregator. Pick the
    single strongest available. If the question is current-events ("who won
    last night", "what's the price of X"), pick gemini or chatgpt (the
    web-capable services) and make output_format require live, sourced facts.
    Otherwise pick claude or chatgpt.

================================================================
STEP 4: PICK AGGREGATOR (and CRITIC if moa_critic)
================================================================

AGGREGATOR writes the final answer the user sees. Aggregator quality matters
MOST — choose carefully.

Aggregator priority for synthesis:
  1. Claude (any paid tier) — Opus 4.7 is the strongest synthesizer; Sonnet 4.6
     is excellent.
  2. ChatGPT Pro (GPT-5 Pro) — strong for rigor-heavy synthesis when Claude
     is unavailable.
  3. Claude Free (Sonnet only) — still a fine synthesizer.
  4. ChatGPT Plus (GPT-5 Thinking) — capable, slightly verbose.
  5. Gemini 3 Pro — capable, sometimes verbose.

CRITIC (moa_critic only) audits the aggregator's draft. Rules:

  - Critic MUST be a different service than the aggregator. Independence is
    the entire point — same model tends to confirm its own hallucinations.

  - Critic SHOULD be from a different lab than the aggregator when possible.
    Cross-lab review catches more.

  - Critic can be one of the original proposers — that's fine. The critic
    will not see the proposer drafts, only the aggregator's synthesis, so
    there's no overlap problem.

  - Pick the strongest available non-aggregator model for critic:
    * If aggregator is Claude → critic = ChatGPT (prefer Pro > Plus > Free).
    * If aggregator is ChatGPT → critic = Claude.
    * If aggregator is Gemini → critic = Claude.

For SIMPLE tasks: aggregator = sole proposer (no real synthesis needed).

================================================================
CONSTRAINTS
================================================================

- ONLY pick services from availableServices.signedIn.
- Service names must be exactly one of: chatgpt, claude, gemini.
  (deepseek and perplexity are no longer routed-to and must not be selected
  even if they appear in availableServices.)
- If only one service is available, use it for both roles and strategy = "simple".
- Diversity rule: never pick two proposers from the same lab.
- moa_critic requires tier == "pro". On free, fall back to "moa".
- For moa_critic, critic.service must differ from aggregator.service.
- OUTPUT VALID JSON ONLY. No markdown fences. No commentary outside the JSON.

================================================================
OUTPUT SCHEMA
================================================================

{
  "task_type": "<short label>",
  "difficulty": "simple | moderate | hard",
  "output_format": "<one clear sentence describing the exact shape of the final answer>",
  "rationale": "<one sentence justifying the strategy + service picks>",
  "strategy": "simple | moa | moa_critic",
  "proposers": [{"service": "<name>", "reason": "<brief reason>"}],
  "aggregator": {"service": "<name>", "reason": "<brief reason>"},
  "critic": {"service": "<name>", "reason": "<brief reason>"},   // ONLY if strategy == "moa_critic", else OMIT this field entirely
  "estimated_seconds": <integer 10-180, more for hard tasks and moa_critic>,
  "critic_focus": "<optional, only when strategy == moa_critic. ONE short specific instruction telling the critic exactly what failure mode is MOST worth hunting in THIS particular task. Examples below. OMIT if you have nothing specific to add beyond task-type defaults.>",
  "strategy_rationale": "<optional, ONE short sentence explaining WHY this strategy was picked over alternatives. Used for debugging. OMIT if obvious from rationale.>"
}

================================================================
critic_focus — WRITING GUIDANCE
================================================================

critic_focus is OPTIONAL but powerful when set well. It tells the critic
what specific failure modes are most worth hunting in THIS particular task
(not just task-type defaults). One short sentence. Concrete and specific.

Examples of GOOD critic_focus values:

  Task: "Prove the median of two sorted arrays in O(log(m+n))"
  critic_focus: "Verify the O(log) complexity bound by counting operations yourself; check the base case for arrays of length 1 and 0; verify any 'WLOG' assumption is actually without loss."

  Task: "Write Python quicksort with median-of-three pivot"
  critic_focus: "Trace the partition on a sorted-ascending input (worst case for naive quicksort); verify no off-by-one in the partition indices; check behavior when all elements are equal."

  Task: "Compare Postgres vs MongoDB for a 10-engineer SaaS startup"
  critic_focus: "Verify that any cited benchmark or feature is current (these change yearly); identify what the recommended option would be WRONG for; check if vendor lock-in was honestly addressed."

  Task: "Help me decide if I should leave my job to do my startup"
  critic_focus: "Check that the answer commits to a recommendation instead of dodging with 'depends on your risk tolerance'; verify it took the user's stated context seriously; spot any generic life-advice padding."

  Task: "Summarize the latest news on the EU AI Act"
  critic_focus: "USE WEB SEARCH to verify every cited date and provision; spot any conflated 'proposed' vs 'enacted' language; check whether the cited dates are the most recent."

Examples when to OMIT critic_focus:

  Task: "What's 47 * 23?"  → simple, no critic needed anyway.
  Task: "Write me a haiku about autumn"  → no specific failure mode to highlight.
  Task: "Translate hello to Spanish"  → trivial, no specialist guidance helps.

Keep it specific. "Be careful" is NOT a useful critic_focus. "Verify the
complexity bound by counting operations" IS.
"""


# ---------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------

app = FastAPI(title="MixerAI Planner", version="1.4.0")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*",
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


def get_client() -> anthropic.Anthropic:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY environment variable is not set",
        )
    return anthropic.Anthropic(api_key=api_key)


@app.get("/")
def root():
    return {
        "service": "mixerai-planner",
        "version": "1.4.0",
        "status": "ok",
        "planner_model_override": PLANNER_MODEL_OVERRIDE,
        "tier_models": TIER_TO_MODEL,
    }


# Services that are NO LONGER routed-to. Even if a client posts them in
# availableServices.signedIn (older extension) or the LLM picks one, the
# planner strips them from proposers/aggregator/critic. This is a
# defense-in-depth measure on top of the system prompt instruction.
DEPRECATED_SERVICES = {"deepseek", "perplexity"}


def _enforce_invariants(plan: TaskPlan, available: list[str], tier: str) -> TaskPlan:
    """Server-side safety net. Even with the system prompt, LLMs occasionally
    drift on schema/strategy invariants. This function fixes those silently
    rather than failing the request."""

    # 0) Strip deprecated services from the available set FIRST. Everything
    #    below operates on the filtered set, so a stray deepseek in proposers
    #    or aggregator gets caught here.
    valid_set = {s for s in available if s not in DEPRECATED_SERVICES}

    # 1) Strip proposers not in available services (or deprecated)
    plan.proposers = [p for p in plan.proposers if p.service in valid_set]

    # 2) Aggregator must be in available services
    if plan.aggregator.service not in valid_set:
        if plan.proposers:
            plan.aggregator = AggregatorSpec(
                service=plan.proposers[0].service,
                reason="Fallback: original aggregator wasn't in available services.",
            )
        else:
            plan.aggregator = AggregatorSpec(
                service=available[0],
                reason="Fallback: only available service.",
            )

    # 3) Must have at least one proposer
    if not plan.proposers:
        plan.proposers = [
            ProposerSpec(
                service=plan.aggregator.service,
                reason="Only one service available; using it for both roles.",
            )
        ]

    # 4) Strategy invariants
    #    - Only one service signed in → force "simple"
    if len(valid_set) <= 1:
        plan.strategy = "simple"

    #    - "simple" requires exactly one proposer == aggregator
    if plan.strategy == "simple":
        plan.proposers = [
            ProposerSpec(
                service=plan.aggregator.service,
                reason="Single-service fast-path.",
            )
        ]
        plan.critic = None

    #    - moa_critic only allowed on pro tier (super-brain)
    if plan.strategy == "moa_critic" and tier != "pro":
        plan.strategy = "moa"
        plan.critic = None

    #    - moa_critic requires a critic, and critic must differ from aggregator
    if plan.strategy == "moa_critic":
        if plan.critic is None or plan.critic.service not in valid_set:
            # Pick a critic ourselves: prefer different lab from aggregator
            agg_lab = SERVICE_LAB.get(plan.aggregator.service)
            candidates = [s for s in available if s != plan.aggregator.service]
            # Prefer different lab
            cross_lab = [s for s in candidates if SERVICE_LAB.get(s) != agg_lab]
            chosen = (cross_lab or candidates or [None])[0]
            if chosen is None:
                # Can't form a valid critic pair — downgrade
                plan.strategy = "moa"
                plan.critic = None
            else:
                plan.critic = CriticSpec(
                    service=chosen,
                    reason="Fallback: critic must differ from aggregator (different lab preferred for cross-perspective review).",
                )
        elif plan.critic.service == plan.aggregator.service:
            # Same as aggregator — fix it
            candidates = [s for s in available if s != plan.aggregator.service]
            if candidates:
                plan.critic = CriticSpec(
                    service=candidates[0],
                    reason="Fallback: critic was same as aggregator; reassigned.",
                )
            else:
                plan.strategy = "moa"
                plan.critic = None

    #    - moa requires no critic
    if plan.strategy == "moa":
        plan.critic = None

    #    - Enforce proposer diversity: no two proposers from the same lab.
    #      Keep first occurrence per lab.
    seen_labs: set[str] = set()
    deduped: list[ProposerSpec] = []
    for p in plan.proposers:
        lab = SERVICE_LAB.get(p.service, p.service)
        if lab in seen_labs:
            continue
        seen_labs.add(lab)
        deduped.append(p)
    plan.proposers = deduped if deduped else plan.proposers

    return plan


@app.post("/plan", response_model=TaskPlan)
def plan(req: PlanRequest):
    available = req.availableServices.signedIn
    if not available:
        raise HTTPException(
            status_code=400,
            detail="No AI services are signed in. Sign into at least one.",
        )

    client = get_client()

    # Normalize legacy "pro_plus" payloads from older extension builds.
    effective_tier = normalize_tier(req.tier)

    # Pick the planner model based on the user's tier (or env override).
    planner_model = resolve_planner_model(effective_tier)

    sub_description = describe_subscriptions(req.subscriptions, available)

    user_msg = (
        f"Task:\n{req.task.strip()}\n\n"
        f"Available services (user is signed in to these): {available}\n\n"
        f"User's MixerAI plan tier: {effective_tier}\n"
        f"(moa_critic strategy is ONLY available on the pro tier — for free, "
        f"the strongest strategy is plain moa.)\n\n"
        f"User's subscription tiers per AI service:\n{sub_description}\n\n"
        f"Choose the best strategy. Output JSON only."
    )

    try:
        response = client.messages.create(
            model=planner_model,
            max_tokens=1500,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Planner LLM call failed: {e}",
        ) from e

    text = response.content[0].text.strip()

    # Strip ```json fences if the model wrapped them
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    try:
        raw_plan = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Planner returned invalid JSON: {e}. Raw: {text[:300]}",
        ) from e

    try:
        parsed = TaskPlan.model_validate(raw_plan)
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Planner output failed schema validation: {e}. Raw: {raw_plan}",
        ) from e

    parsed = _enforce_invariants(parsed, available, effective_tier)
    return parsed
