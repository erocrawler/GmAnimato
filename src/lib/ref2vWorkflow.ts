import fs from 'fs/promises';
import path from 'path';
import probe from 'probe-image-size';
import type { Workflow } from './IDatabase';
import type { LoraPreset } from './loraPresets';
import { findNode, getNodeInputs, calculateVideoDimensions, add720pUpscaleNodes } from './workflowUtils';

interface Ref2VWorkflowParams {
  ref_video_name: string;
  ref_video_url: string;
  ref_image_names?: string[]; // up to 5 reference images
  ref_image_urls?: string[];
  input_prompt: string;
  seed: number;
  callback_url?: string;
  videoDuration?: 4 | 6 | 8 | 10; // seconds; frames derived via ComfyMathExpression (24fps)
  videoResolution?: '480p' | '720p';
  iterationSteps?: 10 | 12 | 15; // sampler steps (MiniMax fast/balanced/quality)
  loraWeights?: Record<string, number>; // enabled LoRAs + strengths (drives speed-up LoRA)
  loraPresets?: LoraPreset[]; // admin-configured presets (find required speed-up LoRA)
  workflow?: Workflow;
}

const MAX_REF_IMAGES = 5;

/**
 * Build a MiniMax H3 reference-to-video (ref2v) workflow payload.
 *
 * Node stack (MiniMaxH3ReferenceToVideo):
 * - VHS_LoadVideo decodes the reference video -> frames (IMAGE) + audio (AUDIO) [optional]
 * - LoadImage xN for the optional reference images [optional]
 * - MiniMaxH3ReferenceToVideo conditions on prompt + refs
 * - RandomNoise -> BasicScheduler -> SamplerCustomAdvanced (res_multistep)
 * - Video + audio VAEs -> VAEDecode/VAEDecodeAudio -> VHS_VideoCombine
 *
 * Refs are ALL optional: with no ref video and no ref images, the workflow
 * degrades to pure text-to-video (t2v) — unused LoadVideo/LoadImage nodes are
 * stripped from the payload.
 *
 * Reuses the i2v MiniMax builder patterns: x32 dimension rounding, 720p upscale,
 * and the always-required speed-up LoRA with 10/12/15 steps.
 */
export async function buildRef2VWorkflow(params: Ref2VWorkflowParams): Promise<object> {
  // Resolve template path from workflow object or use default
  const resolvedTemplatePath = params.workflow?.templatePath || path.resolve('data/minimax_ref2v_template.json.tmpl');
  let template = await fs.readFile(resolvedTemplatePath, 'utf-8');

  // Sanitize and replace placeholders using JSON.stringify to properly escape values
  // slice(1, -1) removes the outer quotes that JSON.stringify adds.
  // JSON.stringify(undefined) === undefined, so coerce to '' for optional refs.
  const quote = (v: string | undefined) => JSON.stringify(v ?? '').slice(1, -1);
  template = template.replace(/{ref_video_name}/g, quote(params.ref_video_name));
  template = template.replace(/{ref_video_url}/g, quote(params.ref_video_url));
  for (let i = 1; i <= MAX_REF_IMAGES; i++) {
    const name = params.ref_image_names?.[i - 1] ?? '';
    const url = params.ref_image_urls?.[i - 1] ?? '';
    template = template.replace(new RegExp(`{ref_image_${i}_name}`, 'g'), JSON.stringify(name).slice(1, -1));
    template = template.replace(new RegExp(`{ref_image_${i}_url}`, 'g'), JSON.stringify(url).slice(1, -1));
  }
  template = template.replace(/{input_prompt}/g, JSON.stringify(params.input_prompt).slice(1, -1));
  template = template.replace(/{seed}/g, String(Math.floor(params.seed))); // Ensure seed is a valid integer

  const workflow = JSON.parse(template);

  const hasRefVideo = !!params.ref_video_url && !!params.ref_video_name;
  const refImageCount = Math.max(0, Math.min(MAX_REF_IMAGES, params.ref_image_urls?.length ?? 0));

  // Find all required nodes dynamically
  const encodeNode = findNode(workflow, 'MiniMaxH3ReferenceToVideo');
  const samplerNode = findNode(workflow, 'SamplerCustomAdvanced');
  const decodeNode = findNode(workflow, 'VAEDecode');
  const audioDecodeNode = findNode(workflow, 'VAEDecodeAudio');
  const videoCombineNode = findNode(workflow, 'VHS_VideoCombine');
  const randomNoiseNode = findNode(workflow, 'RandomNoise');
  const durationNode = findNode(workflow, 'PrimitiveFloat');
  const loadVideoNode = findNode(workflow, 'VHS_LoadVideo');

  // Validate all required nodes are present
  const validationErrors: string[] = [];

  if (!encodeNode) validationErrors.push('MiniMaxH3ReferenceToVideo node not found');
  if (!samplerNode) validationErrors.push('SamplerCustomAdvanced node not found');
  if (!decodeNode) validationErrors.push('VAEDecode node not found');
  if (!videoCombineNode) validationErrors.push('VHS_VideoCombine node not found');
  if (!randomNoiseNode) validationErrors.push('RandomNoise node not found');
  if (!durationNode) validationErrors.push('PrimitiveFloat (duration) node not found');
  if (hasRefVideo && !loadVideoNode) validationErrors.push('VHS_LoadVideo node not found');

  if (validationErrors.length > 0) {
    console.error('Ref2V workflow validation errors:', validationErrors);
    throw new Error(`Ref2V workflow template validation failed:\n${validationErrors.join('\n')}`);
  }

  // Add callback_url to input if provided
  if (params.callback_url) {
    workflow.input.callback_url = params.callback_url;
  }

  // Add node weights for accurate progress calculation
  workflow.input.node_weights = {
    [samplerNode as string]: 60.0,   // SamplerCustomAdvanced - main generation (heavy)
    [decodeNode as string]: 15.0,    // VAEDecode - decode video latents
    [audioDecodeNode as string]: 5.0, // VAEDecodeAudio - decode audio latents
    [videoCombineNode as string]: 15.0, // VHS_VideoCombine - video encoding (moderate)
    // Other nodes use default weight of 1.0
  };

  // Configure video duration (default 6 seconds). Frames are derived by the
  // ComfyMathExpression node from the PrimitiveFloat seconds value (24fps).
  const duration = params.videoDuration ?? 6;
  const durationInputs = getNodeInputs(workflow, durationNode);
  if (durationInputs) {
    durationInputs.value = duration;
  }

  // Configure seed on the RandomNoise node
  const noiseInputs = getNodeInputs(workflow, randomNoiseNode);
  if (noiseInputs) {
    noiseInputs.noise_seed = Math.floor(params.seed);
  }

  const encodeInputs = getNodeInputs(workflow, encodeNode);

  // Reference video is optional. When absent, strip the LoadVideo node,
  // the ref_videos/ref_video_audios inputs, and the videos upload entry.
  if (!hasRefVideo) {
    if (loadVideoNode) {
      delete workflow.input.workflow[loadVideoNode];
    }
    if (encodeInputs) {
      delete encodeInputs.ref_videos;
      delete encodeInputs.ref_video_audios;
    }
    if (Array.isArray(workflow.input.videos)) {
      workflow.input.videos = [];
    }
  } else {
    if (loadVideoNode) {
      workflow.input.node_weights[loadVideoNode] = 2.0; // VHS_LoadVideo - ref video decode
    }
  }

  // Reference images are optional (0-5). Remove unused LoadImage nodes, their
  // ref_images dict entries, and their input.images entries.
  if (refImageCount === 0) {
    // No ref images at all — drop ref_images entirely
    if (encodeInputs) delete encodeInputs.ref_images;
  } else {
    for (let i = refImageCount + 1; i <= MAX_REF_IMAGES; i++) {
      const nodeId = findNode(workflow, 'LoadImage', `Reference Image ${i}`);
      if (nodeId) {
        delete workflow.input.workflow[nodeId];
      }
      if (encodeInputs?.ref_images) {
        delete encodeInputs.ref_images[`ref_image_${i}`];
      }
    }
  }
  if (Array.isArray(workflow.input.images)) {
    workflow.input.images = workflow.input.images.slice(0, refImageCount);
  }

  // Speed-up LoRA (WAN lightx2v pattern): apply the workflow's required LoRA
  // (isConfigurable=false preset present in loraWeights) after the UNETLoader,
  // and set sampler steps to the user-selected iteration steps (10 fast / 12
  // balanced / 15 quality), defaulting to 10. The LoRA filename is fully
  // configurable via admin — no hardcoding. If none is configured, the workflow
  // runs at the template's 20 steps with no LoRA.
  const schedulerNode = findNode(workflow, 'BasicScheduler');
  const guiderNode = findNode(workflow, 'BasicGuider');
  const unetLoaderNode = findNode(workflow, 'UNETLoader');

  const appliedLora = (params.loraPresets ?? [])
    .filter((p) => p.isConfigurable === false)
    .find((p) => params.loraWeights && Object.prototype.hasOwnProperty.call(params.loraWeights, p.id));

  if (appliedLora && unetLoaderNode && schedulerNode) {
    const loraNodeId = '105:1000:lora_speedup';
    const strength =
      typeof params.loraWeights?.[appliedLora.id] === 'number'
        ? params.loraWeights![appliedLora.id]
        : (appliedLora.default ?? 1);

    workflow.input.workflow[loraNodeId] = {
      inputs: {
        lora_name: appliedLora.id,
        strength_model: strength,
        model: [unetLoaderNode, 0],
      },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: 'LoraLoaderModelOnly (Speed-Up)' },
    };
    workflow.input.node_weights[loraNodeId] = 1.0;

    // Rewire BasicScheduler.model and BasicGuider.model to the LoRA output
    const schedulerInputs = getNodeInputs(workflow, schedulerNode);
    const guiderInputs = getNodeInputs(workflow, guiderNode);
    if (schedulerInputs && Array.isArray(schedulerInputs.model) && schedulerInputs.model[0] === unetLoaderNode) {
      schedulerInputs.model = [loraNodeId, 0];
    }
    if (guiderInputs && Array.isArray(guiderInputs.model) && guiderInputs.model[0] === unetLoaderNode) {
      guiderInputs.model = [loraNodeId, 0];
    }

    // Reduce steps: user-selected iteration steps (10 fast / 12 balanced / 15 quality),
    // defaulting to 10. The speed-up LoRA makes low step counts viable.
    if (schedulerInputs) {
      schedulerInputs.steps = params.iterationSteps ?? 10;
    }
    console.log(`[Ref2V] Applied speed-up LoRA ${appliedLora.id} (strength ${strength}) -> ${schedulerInputs?.steps} steps`);
  } else {
    console.log('[Ref2V] No speed-up LoRA configured — using template steps (20)');
  }

  // Always generate at 480p for efficiency, then upscale to 720p if needed.
  // Aspect follows the first reference image when available (video refs are
  // adapted by the node itself); with no refs (pure t2v) use default landscape.
  const resolution = params.videoResolution ?? '480p';
  let gen480pWidth: number;
  let gen480pHeight: number;
  let originalImageWidth: number;
  let originalImageHeight: number;

  try {
    const probeTarget = params.ref_image_urls?.[0] || (hasRefVideo ? params.ref_video_url : null);
    if (!probeTarget) {
      throw new Error('No reference media to probe (pure t2v)');
    }
    const dimensions = await probe(probeTarget);
    originalImageWidth = dimensions.width;
    originalImageHeight = dimensions.height;

    const { width, height } = calculateVideoDimensions(
      dimensions.width,
      dimensions.height,
      '480p',
      { roundToMultiple: 32, rounding: 'floor' }
    );
    gen480pWidth = width;
    gen480pHeight = height;

    if (encodeInputs) {
      encodeInputs.width = width;
      encodeInputs.height = height;
    }
  } catch (error) {
    // Fallback to default 480p landscape dimensions
    originalImageWidth = 1280;
    originalImageHeight = 720;
    gen480pWidth = 832;
    gen480pHeight = 480;

    if (encodeInputs) {
      encodeInputs.width = gen480pWidth;
      encodeInputs.height = gen480pHeight;
    }
  }

  // Add upscale nodes after VAE decode if 720p is requested
  if (resolution === '720p') {
    add720pUpscaleNodes(
      workflow,
      decodeNode as string,
      videoCombineNode as string,
      gen480pWidth,
      gen480pHeight,
      originalImageWidth,
      originalImageHeight
    );
  }

  return workflow;
}
