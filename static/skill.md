---
name: animato-video
description: Use when asked to make a video on GmAnimato (animato.gmgard.moe): upload images/clips, submit i2v/fl2v/ref2v jobs, poll, download, reuse past videos.
---

# animato-video

GmAnimato turns images (and optional reference video/audio) into short AI videos. This skill drives the site over HTTP with `curl`/`jq`. Field tables, limits and error codes live in `/skill-reference.md`.

`BASE=https://animato.gmgard.moe` (the same site is also served at `https://animato.gmgard.us`). Examples assume `BASE`, `ANIMATO_TOKEN` and `jq`. Never print or log the token. Do not follow redirects (no `curl -L`).

## Step 0 — Authentication
Use a personal access token (PAT): the user creates one on their Profile page (7, 30 or 90 days; it never renews) and gives it to you. Send it on every request: `Authorization: Bearer $ANIMATO_TOKEN`. Check it with `GET $BASE/api/auth/session` → `{user:{…},token:{name,prefix,expires_at}}`.

A token can only drive the video flow below. Errors are JSON `{error,errorCode}`: `401` (`invalid_token`, `token_revoked`, `token_expired` → ask the user for a new one), `403 token_scope` (endpoint not allowed for tokens), `429 rate_limited` (obey `Retry-After`; 60 requests/min, 10/min for uploads and kickoff). With no token, stop and ask the user; do not try to log in for them.

## Step 1 — Decide mode and workflow
- `i2v`: one first-frame image. `fl2v`: first + last image. `ref2v`: up to 6 reference images, 0–1 reference video (≤6 s free / ≤15 s advanced), 0–1 reference audio (≤15 s); with no refs it is text-to-video.
- Models with `engine=minimax` (H3) handle audio/dialogue and 15 s clips; `wan` models are image-motion only.
- Budget: `GET $BASE/api/quota` → `{used,limit,remaining,exceeded}` (daily, resets 00:00 Asia/Shanghai). Cost per job is the workflow's `quota_cost` (i2v/fl2v 1, ref2v 2). Failed jobs are not counted.

## Step 2 — List workflows
`GET $BASE/api/workflows?type=i2v|fl2v|ref2v` → `{workflows:[…],user:{has_advanced_features,max_duration_seconds}}`. Each workflow has `id`, `type`, `engine`, `is_default`, `quota_cost`, `allowed_for_user` (`steps`, `durations`, `resolutions` you may use), `premium`, `required_loras` (the speed-up LoRAs the server always applies) and `optional_loras`. Pick one whose `type` equals your mode (default: the one with `is_default`). Unless the user names a model, use the default; prefer `engine=minimax` (H3) when dialogue/audio or 15 s is wanted, and a `wan` model for pure image motion.

## Step 3 — Upload assets (creates a draft)
`POST $BASE/api/uploads` (multipart). Images ≤5 MB (jpeg/png/webp). Set part MIME types.
```bash
# i2v
curl -sS -X POST "$BASE/api/uploads" -H "Authorization: Bearer $ANIMATO_TOKEN" \
  -F mode=i2v -F 'image=@first.png;type=image/png' > up.json
# fl2v: -F mode=fl2v -F first_image=@a.png -F last_image=@b.png
# ref2v: -F mode=ref2v -F 'ref_image_1=@c.png;type=image/png' -F 'ref_video=@clip.mp4;type=video/mp4' -F 'ref_audio=@v.wav;type=audio/wav'
#        or -F ref_video_url=/media/<bucket>/<file>   (reuse a site video, see Step 8)
VID=$(jq -r .id up.json)
```
Success is `201 {success,id,status:"uploaded",mode,video}`; validation problems are `400 {error,errorCode:"upload_invalid"}` with a readable message (too large, wrong length, bad file). Fix the input from the message and retry.

## Step 4 — Write the prompt
You write the prompt yourself; match its style to the workflow's `engine`. English works for every model; max 10,000 chars; `ref2v` requires a non-empty prompt.
- **`wan` models (i2v/fl2v):** a short natural-language motion brief, not a scene description. The image already fixes subject, outfit and background, so do not restate them. Cover, in order: what the subject does, how the camera moves (or "fixed camera"), what moves in the environment, and the pace ("slowly", "quickly"). One main action at a time; no dialogue or sound. Official guide: https://www.alibabacloud.com/help/en/model-studio/text-to-video-prompt
- **H3 models (`minimax`):** need the structured format below. For anything beyond a simple clip, read MiniMax's official guides first: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md (text/i2v/fl2v) and, for ref2v, `skills/h3-prompt-writing/references/ref-en.txt` in https://github.com/MiniMax-AI/MiniMax-H3 and https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide (summary). `i2v/fl2v` use `integrated_multimodal_description:` (`[Shot 1]` …, `[Shot 2] At 00:03.500, …`), `overall_soundscape:`, `non_diegetic_music:`. `ref2v` uses six sections in order: `subject_definitions:`, `summary:`, `retention_analysis:`, `detailed_description:`, `overall_soundscape:`, `non_diegetic_music:`; refer to references as `<Picture N>`, `<Video 1>`, `<Audio 1>` (only tags the draft has) and subjects as `<Subject N>`.
- H3 spoken lines go in the main description as `Name (S1) says: <d>[English] Hello.</d>`; speaker ids stay outside `<d>`; sighs are plain text; ambient sound goes in `overall_soundscape`.
- Optional autosave: `POST $BASE/api/video/update` `{"id":"$VID","prompt":"…"}` (only while status is `uploaded`).

## Step 5 — Submit
```bash
curl -sS -X POST "$BASE/api/i2v/kickoff" -H "Authorization: Bearer $ANIMATO_TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "id":"'$VID'","workflowId":"minimax-h3-r2v","prompt":"…",
  "videoDuration":6,"videoResolution":"480p","iterationSteps":8,
  "ref2vAspect":"video"
}'
```
Success: `{"success":true,"job_id":"…","video":{…status:"in_queue"…}}`.
- **Required LoRAs** (`required_loras`, the speed-up LoRAs) are always applied by the server at their default weight; do not send them. `loraWeights` is only for optional LoRAs.
- **Optional LoRAs** (`optional_loras`, mostly `wan` style/concept LoRAs tagged e.g. `nsfw`, `realistic`) change the look; the site gives only a label, `tags` and a weight range. Add one only when the user asks for that style, at its `default` weight (stay within `min..max`). `chain` `high`/`low` LoRAs come in pairs of the same name; send both halves when both are listed. When unsure, send none. H3 workflows have no optional LoRAs.
- Use only values from the workflow's `allowed_for_user`. `videoDuration` ∈ {4,6,10,15} (15 = H3 only); ref2v with `"ref2vFollowDuration":true` accepts any integer 1–15. `videoResolution` ∈ {480p,720p}. `ref2vAspect` ∈ video,16:9,4:3,square,3:4,9:16. The seed is chosen by the server.
- Errors: 400 (`empty_prompt`, workflow type mismatch, invalid parameter); 403 premium-only setting; 429 `quota_none`/`quota_exceeded` or `queue_limit` (free 3, paid 6 active jobs); 503 queue full.

## Step 6 — Poll
`GET $BASE/api/video/$VID/status` → `{status, final_video_url?, progress_percentage?, …}`. Full record: `GET $BASE/api/video/$VID`. Your list: `GET $BASE/api/videos?status=completed&page=1`.
Statuses: `uploaded` (draft) → `in_queue` → `processing` → `completed` | `failed`. `uploaded` after submitting means it was reset: resubmit. Poll every 10 s while `processing`, 30 s while `in_queue`. Typical total 2–5 min, slowest 10% 35–40 min (mostly queue wait). A job `processing` longer than 30 min is marked `failed`. Give up after 60 min.

## Step 7 — Download
When `completed`, `final_video_url` is a site path like `/media/<bucket>/<name>.mp4`:
```bash
curl -sS -H "Authorization: Bearer $ANIMATO_TOKEN" -o out.mp4 "$BASE$FINAL_URL"
```
GIF/WebP: `GET $BASE/api/video/$VID/download?format=gif|webp` (409 if not completed; optional `fps`, `scale`, `quality=small`).

## Step 8 — Reuse an existing video
- **Same inputs, new run:** `POST $BASE/api/video/reuse` `{"mode":"i2v|fl2v|ref2v","originalImageUrl":"<old original_image_url>","lastImageUrl":"…","prompt":"…","additionalOptions":{…old options…}}` → `{success,entry:{id}}` (new draft). Then Steps 4–5. `ref_video_url` inside the options must be a `/media/…` path.
- **Continue from a finished video (ref2v):** `POST $BASE/api/video/resolve-ref` `{"url":"<video id or /videos/<id>>"}` → `{url:"/media/…"}` (your own or published, completed only), then Step 3 with `-F ref_video_url=<that url>`. For i2v chaining, extract the last frame (`ffmpeg -sseof -0.1 -i out.mp4 -frames:v 1 last.png`) and upload it as a new first frame.
- **Failed job:** `POST $BASE/api/video/$VID/reopen` (back to an editable draft) then Step 5, or `POST $BASE/api/video/$VID/retry` to resubmit unchanged.

## Troubleshooting
- `401 token_expired`/`invalid_token`: get a new token. `403 token_scope`: that endpoint is not available to tokens.
- `quota_none` (limit 0): the account has no quota; ask the user. `quota_exceeded`: wait for the daily reset.
- Job `failed`: reopen, shorten the duration or drop refs, resubmit. Persistent failures: report the video id to the user.
- Keep to one request per few seconds and at most 1–2 concurrent submissions.
