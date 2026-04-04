# Image VL Setup

This guide configures the optional Custom VL endpoint used for image understanding in prompt generation and prompt-property evaluation.

## What This Powers

- Tag extraction from uploaded image(s)
- Suggested English and Chinese motion prompts
- Photo-realistic detection
- NSFW detection

If not configured, the app still works and falls back to empty recognition results.

## Required Variables

Set these in your production environment or local .env file.

CUSTOM_VL_URL=
CUSTOM_VL_AUTH_MODE=

Supported CUSTOM_VL_AUTH_MODE values:

- modal
- cf
- custom
- bearer
- none

Production behavior is explicit mode only. No auto-detection is used.

## Mode A: Modal Proxy Auth

Use when your endpoint expects Modal headers.

CUSTOM_VL_AUTH_MODE=modal
CUSTOM_VL_URL=https://your-modal-endpoint/v1/chat/completions
CUSTOM_VL_TOKEN_ID=your_modal_token_id
CUSTOM_VL_TOKEN_SECRET=your_modal_token_secret

Headers sent:

- Modal-Key: CUSTOM_VL_TOKEN_ID
- Modal-Secret: CUSTOM_VL_TOKEN_SECRET

## Mode B: Cloudflare Access

Use when your endpoint is behind Cloudflare Access service token auth.

CUSTOM_VL_AUTH_MODE=cf
CUSTOM_VL_URL=https://your-domain/v1/chat/completions
CUSTOM_VL_TOKEN_ID=your_cf_access_client_id
CUSTOM_VL_TOKEN_SECRET=your_cf_access_client_secret

Headers sent:

- CF-Access-Client-Id: CUSTOM_VL_TOKEN_ID
- CF-Access-Client-Secret: CUSTOM_VL_TOKEN_SECRET

## Mode C: Custom Header Names

Use when a gateway expects non-standard header names.

CUSTOM_VL_AUTH_MODE=custom
CUSTOM_VL_URL=https://your-domain/v1/chat/completions
CUSTOM_VL_TOKEN_ID=your_id_value
CUSTOM_VL_TOKEN_SECRET=your_secret_value
CUSTOM_VL_TOKEN_ID_HEADER=X-Your-Id-Header
CUSTOM_VL_TOKEN_SECRET_HEADER=X-Your-Secret-Header

Headers sent:

- CUSTOM_VL_TOKEN_ID_HEADER: CUSTOM_VL_TOKEN_ID
- CUSTOM_VL_TOKEN_SECRET_HEADER: CUSTOM_VL_TOKEN_SECRET

## Mode D: Bearer Token

Use for OpenAI-compatible providers requiring Authorization bearer token.

CUSTOM_VL_AUTH_MODE=bearer
CUSTOM_VL_URL=https://provider.example/v1/chat/completions
CUSTOM_VL_API_KEY=your_api_key
CUSTOM_VL_MODEL=gpt-4.1-mini

Header sent:

- Authorization: Bearer CUSTOM_VL_API_KEY

In bearer mode only, request body includes model.

## Optional Variables

CUSTOM_VL_MAX_TOKENS=1024
CUSTOM_VL_TIMEOUT_MS=60000

## Optional Queue-Aware Routing (Primary endpoint + Modal fallback)

If your primary endpoint shares GPU with local I2V workers, you can route recognition traffic:

- Local queue idle: use primary Custom VL endpoint
- Local queue busy: prefer Modal fallback endpoint
- If primary request fails: automatically retry with Modal fallback (when configured)

Environment variables:

CUSTOM_VL_ROUTE_MODAL_WHEN_LOCAL_BUSY=true
CUSTOM_VL_LOCAL_BUSY_THRESHOLD=0
CUSTOM_VL_MODAL_FALLBACK_URL=https://your-modal-endpoint/v1/chat/completions
CUSTOM_VL_MODAL_FALLBACK_TOKEN_ID=your_modal_token_id
CUSTOM_VL_MODAL_FALLBACK_TOKEN_SECRET=your_modal_token_secret

Busy check rule:

- Route to Modal when `(in_queue + processing) > CUSTOM_VL_LOCAL_BUSY_THRESHOLD`

## Quick Validation

1. Set CUSTOM_VL_AUTH_MODE and matching credentials.
2. Upload an image in the app and create a new video.
3. Confirm generated tags and suggested prompts are populated.
4. If recognition is empty, check server logs for Custom VL request errors.
