# Anthropic API Cost Controls

## Dashboard Setup (Manual — Do Once)

Go to [console.anthropic.com](https://console.anthropic.com) and configure:

### 1. Usage Alerts
Navigate to **Settings → Usage → Alerts** and set:
- **$50/month** — informational, confirm normal usage patterns
- **$100/month** — warning, review what's driving spend
- **$200/month** — critical, investigate immediately

### 2. Spending Limit
Navigate to **Settings → Usage → Spending Limit** and set a hard cap:
- **Recommended: $300/month** for early-stage development
- Adjust upward as real usage patterns emerge
- A runaway retry loop or re-upload storm cannot exceed this cap

### 3. Review Model Usage
The app currently uses:
- **claude-haiku-4-5** — Punchy CP1, CP2, CP3 (4 calls per extraction)
- **claude-sonnet-4** — triage route, deep extraction job runs
- **claude_vision** — Python classify-pages (page-by-page for deep extraction)

Haiku calls are cheap (~$0.001–0.005 each). Sonnet calls are ~10x more expensive. Vision calls with full page images are the most expensive per call.

## Application-Level Rate Limiting

The app enforces a per-project extraction rate limit to prevent accidental cost spikes:

- **Max 5 extraction jobs per project per hour**
- Enforced at job creation time in the API route
- Users see a clear message: "Too many recent extractions for this project. Please wait before starting another."
- This prevents: accidental re-uploads, retry storms, and bulk-upload cost spikes

## Future: Per-Request Token Tracking

When ready, add input/output token counts from Anthropic responses to the `extraction_jobs.extraction_summary` JSONB field. This gives cost-per-extraction visibility before the monthly bill arrives.

Fields to track:
```json
{
  "token_usage": {
    "classify_input": 1200,
    "classify_output": 340,
    "extract_input": 8500,
    "extract_output": 2100,
    "punchy_cp1_input": 3000,
    "punchy_cp1_output": 800,
    "total_input": 12700,
    "total_output": 3240
  }
}
```
