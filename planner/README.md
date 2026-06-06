# MixerAI Planner Backend

A tiny FastAPI service that takes a user task + list of signed-in AI services and returns a Mixture-of-Agents plan. Calls Claude Haiku 4.5 (~$0.001 per request).

## Setup

```bash
cd planner
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Create your .env file (only do this once)
cp .env.example .env
# Open .env in any editor and paste your Anthropic API key

# Run the server
uvicorn server:app --reload --port 8000
```

The key in `.env` persists across terminal sessions — no need to `export` it every time you reboot.

You should see:

```
INFO:     Uvicorn running on http://127.0.0.1:8000
```

## Test it

```bash
curl -X POST http://localhost:8000/plan \
  -H "Content-Type: application/json" \
  -d '{
    "task": "prove that the sum 1+2+...+n equals n(n+1)/2",
    "availableServices": {
      "signedIn": ["chatgpt", "claude", "deepseek"]
    }
  }'
```

Expected response shape:

```json
{
  "task_type": "math",
  "difficulty": "moderate",
  "rationale": "Formal proof — pair reasoning-specialized models, synthesize via Claude.",
  "proposers": [
    {"service": "chatgpt", "reason": "Strong general math reasoning"},
    {"service": "deepseek", "reason": "Math-trained for symbolic work"}
  ],
  "aggregator": {
    "service": "claude",
    "reason": "Best at clear formal exposition"
  },
  "estimated_seconds": 40
}
```

## How it integrates

The Chrome extension's sidepanel POSTs to this `/plan` endpoint when the user clicks "Plan task". It expects the backend at `http://localhost:8000/plan` by default — change `PLANNER_URL` in `lib/config.ts` to point elsewhere for production.

## Production notes

- CORS is locked to `chrome-extension://*` origins
- Each plan call is one Claude Haiku request (~$0.001)
- Add auth (JWT, API key) before exposing publicly
- For scale: deploy to Fly.io / Railway / Cloud Run with the same `uvicorn server:app` command

## Cost math

At Claude Haiku 4.5 pricing, each plan request uses roughly:
- ~700 input tokens (system + user prompt)
- ~200 output tokens (JSON plan)
- Cost: ~$0.001 per plan

1000 daily active users × 5 plans each = 5,000 calls/day = ~$5/day.
