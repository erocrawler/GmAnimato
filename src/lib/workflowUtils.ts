/**
 * Shared utilities for workflow builders
 */

/**
 * Default negative prompt for video generation workflows
 */
export const DEFAULT_NEGATIVE_PROMPT = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走，阴茎变形，脸部变形，画面转场，rapid mouth movement";

/**
 * Round to nearest multiple of 16
 */
export function roundToMultipleOf16(value: number): number {
  return Math.round(value / 16) * 16;
}

/**
 * Find a node by class_type and optionally by predicate function
 * @param workflow The workflow object
 * @param classType The class_type to search for
 * @param predicate Optional predicate function to filter nodes, or title pattern (string/RegExp)
 * @returns The node ID if found, otherwise null
 */
export function findNode(
  workflow: any, 
  classType: string, 
  predicate?: ((node: any) => boolean) | string | RegExp
): string | null {
  const wf = workflow?.input?.workflow;
  if (!wf) return null;
  
  for (const [nodeId, node] of Object.entries(wf)) {
    if ((node as any).class_type === classType) {
      if (!predicate) return nodeId;
      
      // If predicate is a function, use it to test the node
      if (typeof predicate === 'function') {
        if (predicate(node)) return nodeId;
      }
      // If predicate is a string or regex, match against title
      else {
        const title = (node as any)._meta?.title || '';
        if (typeof predicate === 'string') {
          if (title.includes(predicate)) return nodeId;
        } else if (predicate instanceof RegExp) {
          if (predicate.test(title)) return nodeId;
        }
      }
    }
  }
  
  return null;
}

/**
 * Get node inputs safely
 */
export function getNodeInputs(workflow: any, nodeId: string | null): any {
  if (!nodeId) return null;
  return workflow?.input?.workflow?.[nodeId]?.inputs;
}

/**
 * Calculate video dimensions based on image aspect ratio and resolution
 * @param imageWidth Original image width
 * @param imageHeight Original image height
 * @param resolution Target resolution (480p or 720p)
 * @returns {width, height} Video dimensions (both multiples of 16)
 */
export function calculateVideoDimensions(
  imageWidth: number,
  imageHeight: number,
  resolution: '480p' | '720p'
): { width: number; height: number } {
  const totalPixels = resolution === '720p' ? 921600 : 409600;
  let aspectRatio = imageWidth / imageHeight;
  
  // Clamp aspect ratio to reasonable range:
  // 1:2.2 (phone full screen portrait) to 2.2:1 (cinema widescreen)
  const minAspectRatio = 1 / 2.2;  // ~0.45
  const maxAspectRatio = 2.2;       // 2.2
  aspectRatio = Math.max(minAspectRatio, Math.min(maxAspectRatio, aspectRatio));
  
  // Calculate dimensions that fit the total pixel count while maintaining aspect ratio
  // width * height = totalPixels
  // width / height = aspectRatio
  // width = sqrt(totalPixels * aspectRatio)
  // height = sqrt(totalPixels / aspectRatio)
  const width = Math.sqrt(totalPixels * aspectRatio);
  const height = Math.sqrt(totalPixels / aspectRatio);
  
  // Round both dimensions to multiples of 16
  let finalWidth = roundToMultipleOf16(width);
  let finalHeight = roundToMultipleOf16(height);
  
  // Ensure minimum dimensions of 256 pixels
  if (finalWidth < 256) finalWidth = 256;
  if (finalHeight < 256) finalHeight = 256;
  
  return {
    width: finalWidth,
    height: finalHeight
  };
}

/**
 * Add upscale nodes to workflow for 720p generation
 * @param workflow The workflow object to modify
 * @param decodeNodeId The VAE decode node ID to connect from
 * @param videoCombineNodeId The video combine node ID to update
 * @param sourceWidth Source video width (480p)
 * @param sourceHeight Source video height (480p)
 * @param imageWidth Original image width
 * @param imageHeight Original image height
 */
export function add720pUpscaleNodes(
  workflow: any,
  decodeNodeId: string,
  videoCombineNodeId: string,
  sourceWidth: number,
  sourceHeight: number,
  imageWidth: number,
  imageHeight: number
): void {
  // Calculate 720p target dimensions using the same logic
  const { width: targetWidth, height: targetHeight } = calculateVideoDimensions(
    imageWidth,
    imageHeight,
    '720p'
  );
  
  // Add upscale model loader node
  const modelLoaderNodeId = '998:upscale_model';
  workflow.input.workflow[modelLoaderNodeId] = {
    inputs: {
      model_name: 'RealESRGAN_x2plus.pth'
    },
    class_type: 'UpscaleModelLoader',
    _meta: {
      title: 'Load Upscale Model'
    }
  };
  
  // Add upscale image node
  const upscaleNodeId = '999:upscale720p';
  workflow.input.workflow[upscaleNodeId] = {
    inputs: {
      upscale_model: [modelLoaderNodeId, 0],
      image: [decodeNodeId, 0]
    },
    class_type: 'ImageUpscaleWithModel',
    _meta: {
      title: 'Upscale to 720p'
    }
  };
  
  // Add resize node to ensure exact target dimensions
  const resizeNodeId = '997:resize_exact';
  workflow.input.workflow[resizeNodeId] = {
    inputs: {
      upscale_method: 'lanczos',
      width: targetWidth,
      height: targetHeight,
      crop: 'disabled',
      image: [upscaleNodeId, 0]
    },
    class_type: 'ImageScale',
    _meta: {
      title: 'Resize to Exact 720p'
    }
  };
  
  // Update VideoCombine to use resized images
  const videoCombineInputs = getNodeInputs(workflow, videoCombineNodeId);
  if (videoCombineInputs) {
    videoCombineInputs.images = [resizeNodeId, 0];
  }
  
  // Add node weights
  workflow.input.node_weights[modelLoaderNodeId] = 1.0;
  workflow.input.node_weights[upscaleNodeId] = 8.0;
  workflow.input.node_weights[resizeNodeId] = 2.0;
}

/**
 * Add WanMotionScale node to workflow if motion scale value is provided
 * @param workflow The workflow object
 * @param motionScale Optional motion scale value (0.5 to 2.0)
 * @param modelProducerNodeId The node ID that produces the model output (e.g., UnetLoaderGGUF)
 * @returns The motion scale node ID if created, otherwise null
 */
export function addMotionScaleNode(workflow: any, motionScale?: number, modelProducerNodeId?: string): string | null {
  if (motionScale !== undefined && modelProducerNodeId) {
    const motionScaleValue = Math.max(0.5, Math.min(2.0, motionScale));
    const motionScaleNodeId = '996:motionscale';
    
    // Ensure node_weights exists
    if (!workflow.input.node_weights) {
      workflow.input.node_weights = {};
    }
    
    // Create the WanMotionScale node that consumes the model producer's output
    workflow.input.workflow[motionScaleNodeId] = {
      inputs: {
        enabled: true,
        scale_t: motionScaleValue,
        scale_y: 1,
        scale_x: 1,
        model: [modelProducerNodeId, 0] // Connect to the model producer
      },
      class_type: 'WanMotionScale',
      _meta: {
        title: 'Wan Motion Scale (Experimental)'
      }
    };
    
    // Add node weight
    workflow.input.node_weights[motionScaleNodeId] = 1.0;
    
    return motionScaleNodeId;
  }
  return null;
}

/**
 * Add WanFreeLong node to workflow if blend strength is provided
 * @param workflow The workflow object
 * @param blendStrength Optional blend strength (0 to 1), default 0.8. 0 = off, 1 = full
 * @param totalFrames Total number of frames in the video (for calculating local_window_frames)
 * @param modelProducerNodeId The node ID that produces the model output (e.g., WanMotionScale or UnetLoaderGGUF)
 * @returns The freelong node ID if created, otherwise null
 */
export function addFreeLongNode(
  workflow: any, 
  blendStrength?: number, 
  totalFrames: number = 81,
  modelProducerNodeId?: string
): string | null {
  if (blendStrength !== undefined && modelProducerNodeId) {
    const clampedStrength = Math.max(0, Math.min(1, blendStrength));
    // Calculate local_window_frames as 40% of total frames, rounded to nearest integer
    const localWindowFrames = Math.round(totalFrames * 0.4);
    const freeLongNodeId = '995:freelong';
    
    // Ensure node_weights exists
    if (!workflow.input.node_weights) {
      workflow.input.node_weights = {};
    }
    
    // Create the WanFreeLong node that consumes the model producer's output
    workflow.input.workflow[freeLongNodeId] = {
      inputs: {
        enabled: true,
        blend_strength: clampedStrength,
        low_freq_ratio: 0.8,
        local_window_frames: localWindowFrames,
        blend_start_block: 0,
        blend_end_block: -1,
        model: [modelProducerNodeId, 0] // Connect to the model producer
      },
      class_type: 'WanFreeLong',
      _meta: {
        title: 'Wan FreeLong'
      }
    };
    
    // Add node weight
    workflow.input.node_weights[freeLongNodeId] = 1.0;
    
    return freeLongNodeId;
  }
  return null;
}

export interface PromptRelaySegment {
  prompt: string;
  frames: number;
}

export interface AddPromptRelayNodesParams {
  globalPrompt: string;
  segments: PromptRelaySegment[];
  totalFrames: number;
  fps?: number;
  width: number;
  height: number;
  encoderNodeId: string;
  samplerInputs: any;
}

/**
 * Inject PromptRelayEncodeTimeline nodes into workflow for per-segment prompt control.
 * Adds:
 *   - EmptyHunyuanLatentVideo (990:relay_latent)
 *   - PromptRelayEncodeTimeline for high noise chain (991:relay_high)
 *   - PromptRelayEncodeTimeline for low noise chain (992:relay_low)
 * Rewires sampler model_high_noise, model_low_noise, and encoder positive accordingly.
 */
export function addPromptRelayNodes(
  workflow: any,
  params: AddPromptRelayNodesParams
): void {
  const { globalPrompt, segments, totalFrames, fps = 18, width, height, encoderNodeId, samplerInputs } = params;

  if (!samplerInputs) return;

  const clipNodeId = findNode(workflow, 'CLIPLoader');
  if (!clipNodeId) {
    console.error('[PromptRelay] CLIPLoader node not found in workflow');
    return;
  }

  // Capture current end-of-chain model references before we rewire
  const prevHighSource: [string, number] = samplerInputs.model_high_noise as [string, number];
  const prevLowSource: [string, number] = samplerInputs.model_low_noise as [string, number];

  if (!prevHighSource || !prevLowSource) {
    console.error('[PromptRelay] model_high_noise or model_low_noise not found in sampler inputs');
    return;
  }

  const localPrompts = segments.map(s => s.prompt).join(' | ');
  const segmentLengths = segments.map(s => s.frames).join(', ');

  // Ensure node_weights exists
  if (!workflow.input.node_weights) {
    workflow.input.node_weights = {};
  }

  // 1. EmptyHunyuanLatentVideo — provides a compatible latent for the relay encoder
  const relayLatentId = '990:relay_latent';
  workflow.input.workflow[relayLatentId] = {
    inputs: {
      width,
      height,
      length: totalFrames,
      batch_size: 1,
    },
    class_type: 'EmptyHunyuanLatentVideo',
    _meta: { title: 'Relay Latent' },
  };
  workflow.input.node_weights[relayLatentId] = 1.0;

  const sharedRelayInputs = {
    timeline_data: "",
    global_prompt: globalPrompt,
    max_frames: totalFrames,
    local_prompts: localPrompts,
    segment_lengths: segmentLengths,
    epsilon: 0.001,
    fps,
    time_units: 'frames',
    clip: [clipNodeId, 0],
    latent: [relayLatentId, 0],
  };

  // 2. PromptRelayEncodeTimeline — high noise chain
  const relayHighId = '991:relay_high';
  workflow.input.workflow[relayHighId] = {
    inputs: {
      ...sharedRelayInputs,
      model: prevHighSource,
    },
    class_type: 'PromptRelayEncodeTimeline',
    _meta: { title: 'Prompt Relay (High Noise)' },
  };
  workflow.input.node_weights[relayHighId] = 2.0;

  // 3. PromptRelayEncodeTimeline — low noise chain
  const relayLowId = '992:relay_low';
  workflow.input.workflow[relayLowId] = {
    inputs: {
      ...sharedRelayInputs,
      model: prevLowSource,
    },
    class_type: 'PromptRelayEncodeTimeline',
    _meta: { title: 'Prompt Relay (Low Noise)' },
  };
  workflow.input.node_weights[relayLowId] = 2.0;

  // 4. Rewire sampler
  samplerInputs.model_high_noise = [relayHighId, 0];
  samplerInputs.model_low_noise = [relayLowId, 0];

  // 5. Rewire encoder positive — high relay output [1] is the conditioning
  const encoderInputs = getNodeInputs(workflow, encoderNodeId);
  if (encoderInputs) {
    encoderInputs.positive = [relayHighId, 1];
  } else {
    console.error('[PromptRelay] Encoder node inputs not found for id:', encoderNodeId);
  }
}

/**
 * Inject PathchSageAttentionKJ nodes for both high and low noise model chains.
 * Must be called after LoRA chains are fully built and before PromptRelay injection.
 * Wraps the current model_high_noise and model_low_noise inputs of the sampler.
 * @param workflow The workflow object
 * @param samplerInputs The sampler node's inputs object (mutated in place)
 */
export function addSageAttentionNodes(
  workflow: any,
  samplerInputs: any
): void {
  if (!samplerInputs) return;

  if (!workflow.input.node_weights) {
    workflow.input.node_weights = {};
  }

  if (Array.isArray(samplerInputs.model_high_noise)) {
    const sageHighId = '993:sage_high';
    workflow.input.workflow[sageHighId] = {
      inputs: {
        sage_attention: 'auto',
        force_apply: false,
        model: samplerInputs.model_high_noise,
      },
      class_type: 'PathchSageAttentionKJ',
      _meta: { title: 'Sage Attention (High Noise)' },
    };
    workflow.input.node_weights[sageHighId] = 1.0;
    samplerInputs.model_high_noise = [sageHighId, 0];
  }

  if (Array.isArray(samplerInputs.model_low_noise)) {
    const sageLowId = '994:sage_low';
    workflow.input.workflow[sageLowId] = {
      inputs: {
        sage_attention: 'auto',
        force_apply: false,
        model: samplerInputs.model_low_noise,
      },
      class_type: 'PathchSageAttentionKJ',
      _meta: { title: 'Sage Attention (Low Noise)' },
    };
    workflow.input.node_weights[sageLowId] = 1.0;
    samplerInputs.model_low_noise = [sageLowId, 0];
  }
}
