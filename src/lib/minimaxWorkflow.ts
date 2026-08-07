import fs from 'fs/promises';
import path from 'path';
import probe from 'probe-image-size';
import type { Workflow } from './IDatabase';
import type { LoraPreset } from './loraPresets';
import { findNode, getNodeInputs, calculateVideoDimensions, add720pUpscaleNodes } from './workflowUtils';

interface MiniMaxWorkflowParams {
  first_image_name: string;
  first_image_url: string;
  last_image_name?: string; // omitted for i2v (single image) mode
  last_image_url?: string;
  input_prompt: string;
  seed: number;
  callback_url?: string;
  videoDuration?: 4 | 6 | 8 | 10; // seconds; frames derived via ComfyMathExpression (24fps)
  videoResolution?: '480p' | '720p';
  iterationSteps?: 10 | 12 | 15; // sampler steps (MiniMax fast/balanced/quality)
  loraWeights?: Record<string, number>; // enabled LoRAs + strengths (drives speed-up LoRA)
  loraPresets?: LoraPreset[]; // admin-configured presets (find required speed-up LoRA)
  useSageAttention?: boolean; // inject MiniMaxH3MemoryEfficientSageAttentionPatch
  workflow?: Workflow;
}

/**
 * Build a MiniMax H3 workflow payload.
 *
 * Unlike WAN templates, MiniMax H3 uses a completely different node stack:
 * - MiniMaxH3ImageToVideo encoder (first_frame + optional last_frame)
 * - RandomNoise -> BasicScheduler -> SamplerCustomAdvanced (res_multistep)
 * - Single UNETLoader (minimax_h3_fl2va_pruned_fp8_scaled.safetensors)
 * - Separate video + audio VAEs, with VAEDecodeAudio -> VHS_VideoCombine.audio
 * - No negative prompt, no motion scale / free-long / relay
 * - Optional sage attention (MiniMaxH3MemoryEfficientSageAttentionPatch) when
 *   useSageAttention is set — the patch node slots into the model chain
 *   (after the speed-up LoRA, if present) and rewires BasicScheduler/BasicGuider.
 *
 * The only shared utility is add720pUpscaleNodes for the 720p upscale path.
 */
export async function buildMiniMaxWorkflow(params: MiniMaxWorkflowParams): Promise<object> {
  // Resolve template path from workflow object or use default
  const resolvedTemplatePath = params.workflow?.templatePath || path.resolve('data/minimax_h3.json.tmpl');
  let template = await fs.readFile(resolvedTemplatePath, 'utf-8');

  // Sanitize and replace placeholders using JSON.stringify to properly escape values
  // slice(1, -1) removes the outer quotes that JSON.stringify adds
  template = template.replace(/{first_image_name}/g, JSON.stringify(params.first_image_name).slice(1, -1));
  template = template.replace(/{first_image_url}/g, JSON.stringify(params.first_image_url).slice(1, -1));
  template = template.replace(/{last_image_name}/g, JSON.stringify(params.last_image_name ?? '').slice(1, -1));
  template = template.replace(/{last_image_url}/g, JSON.stringify(params.last_image_url ?? '').slice(1, -1));
  template = template.replace(/{input_prompt}/g, JSON.stringify(params.input_prompt).slice(1, -1));
  template = template.replace(/{seed}/g, String(Math.floor(params.seed))); // Ensure seed is a valid integer

  const workflow = JSON.parse(template);

  // Find all required nodes dynamically
  const encodeNode = findNode(workflow, 'MiniMaxH3ImageToVideo');
  const samplerNode = findNode(workflow, 'SamplerCustomAdvanced');
  const decodeNode = findNode(workflow, 'VAEDecode');
  const audioDecodeNode = findNode(workflow, 'VAEDecodeAudio');
  const videoCombineNode = findNode(workflow, 'VHS_VideoCombine');
  const randomNoiseNode = findNode(workflow, 'RandomNoise');
  const durationNode = findNode(workflow, 'PrimitiveFloat');
  const firstImageNode = findNode(workflow, 'LoadImage', 'First');
  const lastImageNode = findNode(workflow, 'LoadImage', 'Last');

  // Validate all required nodes are present
  const validationErrors: string[] = [];

  if (!encodeNode) validationErrors.push('MiniMaxH3ImageToVideo node not found');
  if (!samplerNode) validationErrors.push('SamplerCustomAdvanced node not found');
  if (!decodeNode) validationErrors.push('VAEDecode node not found');
  if (!videoCombineNode) validationErrors.push('VHS_VideoCombine node not found');
  if (!randomNoiseNode) validationErrors.push('RandomNoise node not found');
  if (!durationNode) validationErrors.push('PrimitiveFloat (duration) node not found');
  if (!firstImageNode) validationErrors.push('LoadImage (First) node not found');

  if (validationErrors.length > 0) {
    console.error('MiniMax workflow validation errors:', validationErrors);
    throw new Error(`MiniMax workflow template validation failed:\n${validationErrors.join('\n')}`);
  }

  // Add callback_url to input if provided
  if (params.callback_url) {
    workflow.input.callback_url = params.callback_url;
  }

  // Add node weights for accurate progress calculation
  // These weights reflect the actual compute cost of each node
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

  // Speed-up LoRA (WAN lightx2v pattern): apply the workflow's required LoRA
  // (isConfigurable=false preset present in loraWeights) after the UNETLoader,
  // and reduce sampler steps to the preset's `steps` (default 8). The LoRA
  // filename is fully configurable via admin — no hardcoding. If none is
  // configured, the workflow runs at the template's 20 steps with no LoRA.
  const schedulerNode = findNode(workflow, 'BasicScheduler');
  const guiderNode = findNode(workflow, 'BasicGuider');
  const unetLoaderNode = findNode(workflow, 'UNETLoader');

  // Fixed node ids for injected nodes (speed-up LoRA + sage attention patch)
  const loraNodeId = '105:1000:lora_speedup';

  const appliedLora = (params.loraPresets ?? [])
    .filter((p) => p.isConfigurable === false)
    .find((p) => params.loraWeights && Object.prototype.hasOwnProperty.call(params.loraWeights, p.id));

  if (appliedLora && unetLoaderNode && schedulerNode) {
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
    console.log(`[MiniMax] Applied speed-up LoRA ${appliedLora.id} (strength ${strength}) -> ${schedulerInputs?.steps} steps`);
  } else {
    console.log('[MiniMax] No speed-up LoRA configured — using template steps (20)');
  }

  // MiniMax H3 sage attention: inject MiniMaxH3MemoryEfficientSageAttentionPatch
  // (from ComfyUI-KJNodes ltxv_nodes.py) into the model chain. It takes the
  // current model (UNETLoader, or the speed-up LoRA output if one was applied)
  // and re-emits the patched model, so we rewire BasicScheduler.model and
  // BasicGuider.model to its output. Requires sageattention on the worker.
  const sageAttentionNodeId = '105:1001:sage';
  if (params.useSageAttention && unetLoaderNode && schedulerNode) {
    const modelSourceId = appliedLora ? loraNodeId : unetLoaderNode;

    workflow.input.workflow[sageAttentionNodeId] = {
      inputs: {
        model: [modelSourceId, 0],
      },
      class_type: 'MiniMaxH3MemoryEfficientSageAttentionPatch',
      _meta: { title: 'MiniMax H3 Mem Eff Sage Attention Patch' },
    };
    workflow.input.node_weights[sageAttentionNodeId] = 1.0;

    const schedulerInputs = getNodeInputs(workflow, schedulerNode);
    const guiderInputs = guiderNode ? getNodeInputs(workflow, guiderNode) : null;
    if (schedulerInputs && Array.isArray(schedulerInputs.model)) {
      schedulerInputs.model = [sageAttentionNodeId, 0];
    }
    if (guiderInputs && Array.isArray(guiderInputs.model)) {
      guiderInputs.model = [sageAttentionNodeId, 0];
    }
    console.log('[MiniMax] Applied MiniMaxH3MemoryEfficientSageAttentionPatch');
  }

  // i2v mode: no last image -> drop the last-frame LoadImage node and
  // the encoder's last_frame input, and keep only the first images entry.
  const hasLastImage = !!params.last_image_url && !!params.last_image_name;
  if (!hasLastImage) {
    if (lastImageNode) {
      delete workflow.input.workflow[lastImageNode];
    }
    const encodeInputs = getNodeInputs(workflow, encodeNode);
    if (encodeInputs) {
      delete encodeInputs.last_frame;
    }
    if (Array.isArray(workflow.input.images) && workflow.input.images.length > 1) {
      workflow.input.images = workflow.input.images.slice(0, 1);
    }
  }

  // Always generate at 480p for efficiency, then upscale to 720p if needed
  const resolution = params.videoResolution ?? '480p';
  let gen480pWidth: number;
  let gen480pHeight: number;
  let originalImageWidth: number;
  let originalImageHeight: number;

  try {
    const dimensions = await probe(params.first_image_url);
    originalImageWidth = dimensions.width;
    originalImageHeight = dimensions.height;

    // Always calculate for 480p generation — MiniMax H3 requires multiples
    // of 32 (floor rounding mirrors the official ResolutionSelector), unlike
    // WAN's multiples of 16.
    const { width, height } = calculateVideoDimensions(
      dimensions.width,
      dimensions.height,
      '480p',
      { roundToMultiple: 32, rounding: 'floor' }
    );
    gen480pWidth = width;
    gen480pHeight = height;

    // Set dimensions on the encoder node
    const encodeInputs = getNodeInputs(workflow, encodeNode);
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

    const encodeInputs = getNodeInputs(workflow, encodeNode);
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
