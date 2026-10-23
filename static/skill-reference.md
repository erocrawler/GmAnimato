# animato-video — reference

Companion to `/skill.md`. Use `BASE=https://animato.gmgard.moe` (also served at `https://animato.gmgard.us`). Items marked **(unverified)** were read from the code but not exercised against a live account.

## 1. Authentication
Every API call carries `Authorization: Bearer anim_pat_…`, a personal access token the user creates on their Profile page.
- Lifetime 7, 30 or 90 days (default 30), no renewal; at most 5 active tokens per account. Only a hash is stored server-side, so the full token is shown once at creation. The user can revoke it at any time (it stops working immediately).
- A token only works for the endpoints in §2; anything else answers `403 {errorCode:"token_scope"}`.
- Errors are JSON `{error,errorCode}`: `401` `invalid_token` | `token_revoked` | `token_expired`; `403` `token_scope`; `429` `rate_limited` with `Retry-After` (60 requests/min per token, 10/min for `POST /api/uploads` and `POST /api/i2v/kickoff`).
- Token requests need no `Origin` header and ignore cookies.

## 2. Endpoint matrix (everything a token may call)
Owner = the video's creator; other users' videos answer `404`.
- `GET /api/auth/session` — whoami: `{user:{id,username,roles,…},token:{name,prefix,expires_at}}`.
- `GET /api/quota` — `{used,limit,remaining,exceeded}`.
- `GET /api/workflows[?type=i2v|fl2v|ref2v]` — models with allowed steps/durations/resolutions, premium flags, `required_loras`, `optional_loras`, `quota_cost`.
- `GET /api/videos?page&page_size≤50&status=uploaded|in_queue|processing|completed|failed&sort=upload|completion&direction=asc|desc` — your videos: `{videos,page,page_size,total,total_pages}`.
- `GET /api/video/{id}` — one video in full (inputs, options, LoRAs, seed, status).
- `GET /api/video/{id}/status` — poll (§5).
- `GET /api/video/{id}/download?format=gif|webp[&quality=small&fps=1-30&scale=120-1280]` — converted clip, cached 10 min; 409 when not completed.
- `GET /media/{bucket}/{file}` — media files (supports Range).
- `POST /api/uploads` — create a draft (§3).
- `POST /api/video/update` — `{id,prompt?}`; prompt only while `uploaded`.
- `POST /api/i2v/kickoff` — submit a job (§4).
- `POST /api/video/{id}/reopen` — failed → `uploaded` draft.
- `POST /api/video/{id}/retry` — resubmit a failed job unchanged.
- `POST /api/video/reuse` — new draft from existing URLs/options; `ref_video_url` must be a `/media/…` path.
- `POST /api/video/resolve-ref` — `{url}` → `{success,id,url,name}` for a completed video you own or that is published.
There is no cancel or delete for tokens.

## 3. `POST /api/uploads`
`multipart/form-data` (files) or `application/json` (string/number/boolean fields only, e.g. `{"mode":"ref2v","ref_video_url":"/media/…"}`). Returns `201 {success,id,status:"uploaded",mode,video}`; failures are `400 {error,errorCode:"upload_invalid"}`.
- `mode=i2v` (default) + `image` — 1 image.
- `mode=fl2v` + `first_image` + `last_image`.
- `mode=ref2v` + optional: `ref_image_1`…`ref_image_6`; `ref_video` (file) **or** `ref_video_url`; `ref_audio`; `ref_video_start`, `ref_video_end` (seconds, server-side trim), `ref_video_include_audio=false`, `ref_video_duration`.
- Limits: image ≤5 MB (jpeg/png/webp kept, others → JPEG); ref video ≤50 MB, mp4/webm/mov/mkv, trimmed length ≤ tier cap (6 s free, 15 s advanced; error `ref video is Ns — max Ms`), downscaled to long edge 854 px, fps capped at 24, ≥5 frames; ref audio ≤15 s / ≤50 MB (mp3, wav, ogg, aac, m4a, flac; re-encoded to WAV); `ref_video_url` must be `/media/…` (get one from `resolve-ref`; `/media/` URLs are not duration-checked, keep within the tier cap). Request bodies are capped at 100 MB.

## 4. `POST /api/i2v/kickoff` body
`{id (required), prompt, tags?, workflowId?, loraWeights?, iterationSteps?, videoDuration?, videoResolution?, ref2vAspect?, ref2vFollowDuration?, motionScale?, freeLongBlendStrength?, promptRelayMode?, promptRelaySegments?}`
- `workflowId` omitted → default workflow of the draft's type. Type must match draft: ref2v if `additional_options.ref2v`, fl2v if it has `last_image_url`, else i2v (otherwise 400 `Workflow type mismatch`).
- `loraWeights`: `{ "<lora id>": strength }`; only LoRAs compatible with the workflow survive. Required LoRAs (`required_loras`, the speed-up LoRAs) are applied by the server at their default weight whatever you send, so omit them. Optional LoRAs (`optional_loras`): add with a strength within `min..max`.
- `iterationSteps`: allowed per workflow `capabilities.steps` (engine default WAN [4,6], minimax [4,8]); explicit out-of-range → 400; above `capabilities.freeSteps` (default 4) needs an advanced role (403). Default when omitted: engine default.
- `videoDuration`: workflow `capabilities.durations` (default WAN 4/6/10, minimax 4/6/10/15); explicit unsupported → 400; 15 s only for engine `minimax`; capped to the account tier (6 s free, 15 s advanced, silent clamp). ref2v "follow ref video" → set `ref2vFollowDuration:true` and any integer 1–15.
- `videoResolution`: `480p` or `720p` (720p advanced only; generated at 480p then upscaled).
- `ref2vAspect`: `video` (follow ref media), `16:9`, `4:3`, `square`, `3:4`, `9:16`.
- WAN-only experiments: `motionScale` 0.5–2.0, `freeLongBlendStrength` 0–1, relay mode (`promptRelaySegments` 1–10 items `{prompt ≤500 chars, frames 9–121}`, total frames 4n+1, 81–121 free / ≤177 advanced). **(unverified outside the UI)**
- Seed: random 0–999999 chosen by the server (stored in `seed`), cannot be supplied.
- Credit cost = the workflow's `quota_cost` (see `GET /api/workflows`): i2v/fl2v 1, ref2v 2 today. The check runs after your settings are saved, so a 429 still leaves the draft updated.
- Returns `{success,job_id,is_local,video}`; `{"success":true,"mock":true}` only when no worker backend is configured.
- Concurrency: active (`in_queue`+`processing`) jobs per account ≤ free 3 / advanced 6 (`queue_limit`, 429). Errors carry `errorCode` where available: `empty_prompt`, `quota_none`, `quota_exceeded`, `queue_limit`.

## 5. Status payload and state machine
`GET /api/video/{id}/status`:
- `completed|failed`: `{status, final_video_url, revalidation_status, manual_recognition_*}`.
- `in_queue|processing`: adds `is_local`, `progress_percentage` (0–100), `progress_details {completed_nodes,total_nodes,current_node,current_node_progress}`; RunPod-run jobs also return `job_status`, `job_data`.
- States: `uploaded` → (kickoff) `in_queue` → `processing` → `completed`/`failed`; cancelled queue entries return to `uploaded`; `processing` for more than 30 min since dequeue is flagged `failed` with `reason:"processing_timeout"` on the next poll; `deleted` hides the video. There is no user-facing cancel endpoint.
- `final_video_url` is a site-relative `/media/<bucket>/<file>`; prepend `BASE`.
- Fresh drafts can sit in `uploaded` indefinitely.

## 6. Error cheat-sheet
- `401` token problem (see §1); `403` `token_scope` or a premium-only setting (720p, steps above `free_steps`).
- `400` missing/invalid fields, `empty_prompt`, workflow mismatch, relay frame rules, `upload_invalid`.
- `404` unknown video or not yours. `409` download of a non-completed video.
- `429` `rate_limited` (+`Retry-After`), `quota_none`/`quota_exceeded` (+limit, used, cost) or `queue_limit` (+limit).
- `500` worker/RunPod submission failure (the video is set `failed`); `503` queue full (`queueFull:true`) or serverless endpoint not configured.
