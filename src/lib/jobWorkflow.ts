/**
 * Shared video job workflow construction.
 *
 * All three job dispatch paths MUST go through this single function so that a
 * new model/workflow type (WAN i2v, WAN fl2v, MiniMax H3, …) only ever needs to
 * be taught to build in ONE place:
 *
 *   1. kickoff → RunPod directly            (api/i2v/kickoff/+server.ts)
 *   2. local worker claiming a job          (api/worker/task/+server.ts)
 *   3. local job → RunPod migration/retry   (lib/local-queue.ts + api/video/[id]/retry/+server.ts)
 *
 * In the past each path carried its own copy of the construction logic and they
 * drifted (sage attention, prompt relay, MiniMax were each added to paths 1 & 2
 * but missed on path 3). This module is the single source of truth.
 */

import { Buffer } from 'node:buffer';
import { env } from '$env/dynamic/private';
import { getWorkflowById, getDefaultWorkflow } from '$lib/db';
import { buildWorkflow } from '$lib/i2vWorkflow';
import { buildFL2VWorkflow } from '$lib/fl2vWorkflow';
import { buildMiniMaxWorkflow } from '$lib/minimaxWorkflow';
import { buildRef2VWorkflow } from '$lib/ref2vWorkflow';
import { isMiniMaxWorkflow } from '$lib/workflows';
import { toOriginalUrl } from '$lib/serverImageUrl';
import type { AdminSettings, VideoEntry, Workflow } from '$lib/IDatabase';

const DEFAULT_IMAGE_MIME = 'image/png';

/**
 * Build the webhook callback URL for a video.
 *
 * Honors the CALLBACK_BASE_URL env override — useful when the request origin is
 * NOT reachable by the worker (e.g. dev server on localhost + a remote RunPod
 * endpoint, or a worker polling through a tunnel). When unset, falls back to
 * the request origin: the worker demonstrably can reach that origin (it just
 * fetched the task from it), so omitting the callback for loopback addresses
 * (the old behaviour) silently dropped error notifications and left jobs stuck
 * in 'processing' until the timeout.
 */
export function getCallbackUrl(base: string, videoId: string): string {
  const override = env.CALLBACK_BASE_URL?.trim();
  const baseUrl = (override || base).replace(/\/+$/, '');
  return `${baseUrl}/api/i2v-webhook/${videoId}`;
}

async function fetchImageAsBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? DEFAULT_IMAGE_MIME;
  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString('base64');
  return `data:${contentType};base64,${base64}`;
}

export interface BuildJobWorkflowOptions {
  video: VideoEntry;
  settings: AdminSettings;
  /** Webhook URL to embed in the payload (may be undefined for localhost) */
  callbackUrl?: string;
  /**
   * 'url'   – images referenced by URL (RunPod: the handler downloads them)
   * 'base64' – images inlined as base64 (local worker: WORKER_IMAGE_INPUT_MODE)
   * Defaults to 'url'.
   */
  imageMode?: 'url' | 'base64';
  /** Inject PathchSageAttentionKJ nodes (WAN workflows only). Caller decides via env var. */
  useSageAttention?: boolean;
}

export interface BuildJobWorkflowResult {
  /** The resolved workflow record (explicit selection or type default) */
  workflow: Workflow;
  /** Complete `{ input: { workflow, images, callback_url, node_weights } }` payload */
  payload: any;
}

/**
 * Build the RunPod/worker payload for a video entry.
 *
 * Resolves the workflow record (explicit `workflow_id` or the type default),
 * detects the model stack (MiniMax H3 vs WAN i2v/fl2v), and produces the
 * payload for the correct builder. Optionally inlines images as base64.
 */
export async function buildJobWorkflow(options: BuildJobWorkflowOptions): Promise<BuildJobWorkflowResult> {
  const { video, settings, callbackUrl, imageMode = 'url', useSageAttention = false } = options;

  // Detect workflow type from the job: ref2v flag takes precedence (its template
  // path contains 'minimax'), then first+last image => fl2v, else i2v.
  const isRef2V = video.additional_options?.ref2v === true;
  const isFL2V = !!video.last_image_url;
  const workflowType = isRef2V ? 'ref2v' : isFL2V ? 'fl2v' : 'i2v';

  // Resolve workflow record (explicit selection or type default)
  let workflow: Workflow | null = null;
  if (video.workflow_id) {
    workflow = await getWorkflowById(video.workflow_id);
  }
  if (!workflow) {
    workflow = await getDefaultWorkflow(workflowType);
  }
  if (!workflow) {
    throw new Error(`No ${workflowType.toUpperCase()} workflow configured`);
  }

  const shouldSendBase64 = imageMode === 'base64';
  const seed = video.seed ?? Math.floor(Math.random() * 1000000);
  const hasLoraWeights = typeof video.lora_weights === 'object' && video.lora_weights !== null;
  const loraWeights = hasLoraWeights ? (video.lora_weights as Record<string, number>) : undefined;
  const promptRelayMode = video.additional_options?.prompt_relay_mode === true;
  const promptRelaySegments = Array.isArray(video.additional_options?.prompt_relay_segments)
    ? video.additional_options!.prompt_relay_segments!
    : undefined;

  let payload: any;

  if (isRef2V) {
    // MiniMax H3 reference-to-video — refs are ALL optional (no ref video +
    // no ref images degrades to pure t2v). Refs are snapshotted in
    // additional_options at upload time. Must be checked BEFORE
    // isMiniMaxWorkflow because the ref2v template path also contains 'minimax'.
    const refVideoUrl = video.additional_options?.ref_video_url
      ? toOriginalUrl(video.additional_options.ref_video_url)
      : undefined;
    const refImageUrls: string[] | undefined = Array.isArray(video.additional_options?.ref_image_urls)
      ? video.additional_options.ref_image_urls.map((u: string) => toOriginalUrl(u))
      : undefined;

    const [refVideoBase64, refImageBase64s] = shouldSendBase64
      ? await Promise.all([
          refVideoUrl ? fetchImageAsBase64(refVideoUrl) : Promise.resolve(null),
          refImageUrls && refImageUrls.length > 0
            ? Promise.all(refImageUrls.map((u) => fetchImageAsBase64(u)))
            : Promise.resolve([]),
        ])
      : [null, [] as string[]];

    payload = await buildRef2VWorkflow({
      ref_video_name: video.additional_options?.ref_video_name ?? '',
      ref_video_url: refVideoUrl ?? '',
      ref_image_names: Array.isArray(video.additional_options?.ref_image_names)
        ? (video.additional_options.ref_image_names as string[])
        : undefined,
      ref_image_urls: refImageUrls,
      input_prompt: video.prompt ?? 'A beautiful video',
      seed,
      callback_url: callbackUrl,
      videoDuration: video.video_duration as 4 | 6 | 8 | 10 | undefined,
      videoResolution: video.video_resolution as '480p' | '720p' | undefined,
      iterationSteps: video.iteration_steps as 10 | 12 | 15 | undefined,
      loraWeights,
      loraPresets: settings.loraPresets,
      workflow,
    });

    if (shouldSendBase64 && payload?.input?.images) {
      payload.input.images = refImageBase64s.map((b64, i) => ({
        name: payload.input.images[i]?.name ?? `ref_image_${i + 1}.png`,
        image: b64,
      }));
    }
    if (shouldSendBase64 && refVideoBase64 && payload?.input?.videos) {
      payload.input.videos = [
        { name: payload.input.videos[0]?.name ?? 'ref_video.mp4', image: refVideoBase64 },
      ];
    }
  } else if (isMiniMaxWorkflow(workflow)) {
    // MiniMax H3 uses a different node stack — dedicated builder.
    // It handles both i2v (no last image) and fl2v (has last image).
    const originalImageUrl = toOriginalUrl(video.original_image_url);
    const originalLastImageUrl = video.last_image_url ? toOriginalUrl(video.last_image_url) : undefined;

    const [firstImageBase64, lastImageBase64] = shouldSendBase64
      ? await Promise.all([
          fetchImageAsBase64(originalImageUrl),
          originalLastImageUrl ? fetchImageAsBase64(originalLastImageUrl) : Promise.resolve(null),
        ])
      : [null, null];

    payload = await buildMiniMaxWorkflow({
      first_image_name: `${video.id}_first.png`,
      first_image_url: originalImageUrl,
      ...(originalLastImageUrl
        ? {
            last_image_name: `${video.id}_last.png`,
            last_image_url: originalLastImageUrl,
          }
        : {}),
      input_prompt: video.prompt ?? 'A beautiful video',
      seed,
      callback_url: callbackUrl,
      videoDuration: video.video_duration as 4 | 6 | 8 | 10 | undefined,
      videoResolution: video.video_resolution as '480p' | '720p' | undefined,
      iterationSteps: video.iteration_steps as 10 | 12 | 15 | undefined,
      loraWeights,
      loraPresets: settings.loraPresets,
      useSageAttention,
      workflow,
    });

    if (shouldSendBase64 && payload?.input?.images) {
      payload.input.images = [
        { name: `${video.id}_first.png`, image: firstImageBase64 },
        ...(lastImageBase64
          ? [{ name: `${video.id}_last.png`, image: lastImageBase64 }]
          : []),
      ];
    }
  } else if (isFL2V) {
    // Convert proxy URLs to original S3 URLs for the worker
    const originalImageUrl = toOriginalUrl(video.original_image_url);
    const lastImageUrl = toOriginalUrl(video.last_image_url!);

    const [firstImageBase64, lastImageBase64] = shouldSendBase64
      ? await Promise.all([
          fetchImageAsBase64(originalImageUrl),
          fetchImageAsBase64(lastImageUrl),
        ])
      : [null, null];

    payload = await buildFL2VWorkflow({
      first_image_name: `${video.id}_first.png`,
      first_image_url: originalImageUrl,
      last_image_name: `${video.id}_last.png`,
      last_image_url: lastImageUrl,
      input_prompt: video.prompt ?? 'A beautiful video',
      seed,
      callback_url: callbackUrl,
      iterationSteps: video.iteration_steps as 4 | 6 | 8 | undefined,
      videoDuration: video.video_duration as 4 | 6 | undefined,
      videoResolution: video.video_resolution as '480p' | '720p' | undefined,
      motionScale: video.additional_options?.motion_scale,
      freeLongBlendStrength: video.additional_options?.freelong_blend_strength,
      useSageAttention,
      loraWeights,
      loraPresets: settings.loraPresets,
      workflow,
      promptRelayMode,
      promptRelaySegments,
    });

    if (shouldSendBase64 && payload?.input?.images) {
      payload.input.images = [
        { name: `${video.id}_first.png`, image: firstImageBase64 },
        { name: `${video.id}_last.png`, image: lastImageBase64 },
      ];
    }
  } else {
    // Convert proxy URL to original S3 URL for the worker
    const originalImageUrl = toOriginalUrl(video.original_image_url);

    const imageBase64 = shouldSendBase64
      ? await fetchImageAsBase64(originalImageUrl)
      : null;

    payload = await buildWorkflow({
      image_name: `${video.id}.png`,
      image_url: originalImageUrl,
      input_prompt: video.prompt ?? 'A beautiful video',
      seed,
      callback_url: callbackUrl,
      iterationSteps: video.iteration_steps as 4 | 6 | 8 | undefined,
      videoDuration: video.video_duration as 4 | 6 | undefined,
      videoResolution: video.video_resolution as '480p' | '720p' | undefined,
      motionScale: video.additional_options?.motion_scale,
      freeLongBlendStrength: video.additional_options?.freelong_blend_strength,
      useSageAttention,
      loraWeights,
      loraPresets: settings.loraPresets,
      workflow,
      promptRelayMode,
      promptRelaySegments,
    });

    if (shouldSendBase64 && payload?.input?.images) {
      payload.input.images = [{ name: `${video.id}.png`, image: imageBase64 }];
    }
  }

  return { workflow, payload };
}
