import fs from 'fs/promises';
import path from 'path';
import probe from 'probe-image-size';
import type { LoraPreset } from './loraPresets';
import type { Workflow } from './IDatabase';
import { normalizeLoraPresets } from './loraPresets';
import { findNode, getNodeInputs, calculateVideoDimensions, DEFAULT_NEGATIVE_PROMPT } from './workflowUtils';
import { json } from 'stream/consumers';

interface FL2VWorkflowParams {
  first_image_name: string;
  first_image_url: string;
  last_image_name: string;
  last_image_url: string;
  input_prompt: string;
  seed: number;
  callback_url?: string;
  iterationSteps?: 4 | 6 | 8;
  videoDuration?: 4 | 6;
  videoResolution?: '480p' | '720p';
  loraWeights?: Record<string, number>;
  loraPresets?: LoraPreset[];
  workflow?: Workflow;
}

export async function buildFL2VWorkflow(params: FL2VWorkflowParams): Promise<object> {
  // Resolve template path from workflow object or use default
  const resolvedTemplatePath = params.workflow?.templatePath || path.resolve('data/api_flf2v.json.tmpl');
  let template = await fs.readFile(resolvedTemplatePath, 'utf-8');

  // Sanitize and replace placeholders using JSON.stringify to properly escape values
  // slice(1, -1) removes the outer quotes that JSON.stringify adds
  template = template.replace(/{first_image_name}/g, JSON.stringify(params.first_image_name).slice(1, -1));
  template = template.replace(/{first_image_url}/g, JSON.stringify(params.first_image_url).slice(1, -1));
  template = template.replace(/{last_image_name}/g, JSON.stringify(params.last_image_name).slice(1, -1));
  template = template.replace(/{last_image_url}/g, JSON.stringify(params.last_image_url).slice(1, -1));
  template = template.replace(/{input_prompt}/g, JSON.stringify(params.input_prompt).slice(1, -1));
  template = template.replace(/{negative_prompt}/g, JSON.stringify(DEFAULT_NEGATIVE_PROMPT).slice(1, -1));
  template = template.replace(/{seed}/g, String(Math.floor(params.seed))); // Ensure seed is a valid integer

  const workflow = JSON.parse(template);
  
  // Find all required nodes dynamically
  const encodeNode = findNode(workflow, 'WanFirstLastFrameToVideo');
  const resizeFirstNode = findNode(workflow, 'ImageResizeKJv2', 'First');
  const resizeLastNode = findNode(workflow, 'ImageResizeKJv2', 'Last');
  const samplerNode = findNode(workflow, 'WanMoeKSampler');
  const decodeNode = findNode(workflow, 'VAEDecode');
  const videoCombineNode = findNode(workflow, 'VHS_VideoCombine');
  
  // Validate workflow structure matches our assumptions
  const validationErrors: string[] = [];
  
  if (!encodeNode) validationErrors.push('WanFirstLastFrameToVideo node not found');
  if (!resizeFirstNode) validationErrors.push('ImageResizeKJv2 (First) node not found');
  if (!resizeLastNode) validationErrors.push('ImageResizeKJv2 (Last) node not found');
  if (!samplerNode) validationErrors.push('WanMoeKSampler node not found');
  if (!decodeNode) validationErrors.push('VAEDecode node not found');
  if (!videoCombineNode) validationErrors.push('VHS_VideoCombine node not found');
  
  if (validationErrors.length > 0) {
    console.error('FL2V workflow validation errors:', validationErrors);
    throw new Error(`FL2V workflow template validation failed:\n${validationErrors.join('\n')}`);
  }
  
  // Add callback_url to input if provided
  if (params.callback_url) {
    workflow.input.callback_url = params.callback_url;
  }
  
  // Add node weights for accurate progress calculation
  // These weights reflect the actual compute cost of each node
  workflow.input.node_weights = {
    [samplerNode as string]: 60.0,  // WanMoeKSampler - main generation (heavy)
    [decodeNode as string]: 20.0,   // VAEDecode - decode latents (moderate)
    [videoCombineNode as string]: 15.0,  // VHS_VideoCombine - video encoding (moderate)
    // Other nodes use default weight of 1.0
  };

  // Configure iteration steps (default 6)
  const steps = params.iterationSteps ?? 6;
  const samplerInputs = getNodeInputs(workflow, samplerNode);
  if (samplerInputs) {
    samplerInputs.steps = steps;
  }

  // Configure video duration (default 4 seconds = 81 frames)
  const duration = params.videoDuration ?? 4;
  const frames = duration === 6 ? 121 : 81;
  const encodeInputs = getNodeInputs(workflow, encodeNode);
  if (encodeInputs) {
    encodeInputs.length = frames;
  }

  // Fetch image dimensions and calculate video dimensions
  const resolution = params.videoResolution ?? '480p';
  try {
    const dimensions = await probe(params.first_image_url);
    const { width, height } = calculateVideoDimensions(dimensions.width, dimensions.height, resolution);
    console.log(`First image dimensions: ${dimensions.width}x${dimensions.height}, Video dimensions: ${width}x${height}`);
    
    // Set dimensions on both ImageResize nodes and WanFirstLastFrameToVideo node
    const resizeFirstInputs = getNodeInputs(workflow, resizeFirstNode);
    if (resizeFirstInputs) {
      resizeFirstInputs.width = width;
      resizeFirstInputs.height = height;
    }
    
    const resizeLastInputs = getNodeInputs(workflow, resizeLastNode);
    if (resizeLastInputs) {
      resizeLastInputs.width = width;
      resizeLastInputs.height = height;
    }
    
    if (encodeInputs) {
      encodeInputs.width = width;
      encodeInputs.height = height;
    }
  } catch (error) {
    console.error('Failed to probe first image dimensions:', error);
    // Fallback to default landscape dimensions
    const longSide = resolution === '720p' ? 1280 : 832;
    const shortSide = resolution === '720p' ? 720 : 480;
    
    const resizeFirstInputs = getNodeInputs(workflow, resizeFirstNode);
    if (resizeFirstInputs) {
      resizeFirstInputs.width = longSide;
      resizeFirstInputs.height = shortSide;
    }
    
    const resizeLastInputs = getNodeInputs(workflow, resizeLastNode);
    if (resizeLastInputs) {
      resizeLastInputs.width = longSide;
      resizeLastInputs.height = shortSide;
    }
    
    if (encodeInputs) {
      encodeInputs.width = longSide;
      encodeInputs.height = shortSide;
    }
  }

  // Override LoRA strengths when provided and dynamically build chains
  if (params.loraWeights && params.loraPresets) {
    const presets = normalizeLoraPresets(params.loraPresets);
    
    // Build dynamic chains for all LoRAs (both base and configurable)
    const highChain = presets.filter((p) => p.chain === 'high');
    const lowChain = presets.filter((p) => p.chain === 'low');
    console.log('Building FL2V LoRA chains:', { highChain, lowChain });
    
    // High noise chain: starts from node 67 output, feeds into node 21
    let highPrevNodeId = '67';
    let highNodeCounter = 1;
    for (const preset of highChain) {
      const nodeId = `61:dyn${highNodeCounter}`;
      highNodeCounter++;
      
      // Only add if present in loraWeights (enabled)
      if (Object.prototype.hasOwnProperty.call(params.loraWeights, preset.id)) {
        const weight = params.loraWeights[preset.id];
        const strength = typeof weight === 'number' && Number.isFinite(weight) ? weight : preset.default;
        workflow.input.workflow[nodeId] = {
          inputs: {
            lora_name: preset.id,
            strength_model: strength,
            model: [highPrevNodeId, 0],
          },
          class_type: 'LoraLoaderModelOnly',
          _meta: {
            title: preset.label || preset.id,
          },
        };
        highPrevNodeId = nodeId;
      }
    }
    
    // Update node 21 to consume the last high chain node
    if (workflow.input.workflow['21'] && highChain.length > 0) {
      workflow.input.workflow['21'].inputs.model = [highPrevNodeId, 0];
    }
    
    // Low noise chain: starts from node 68 output, feeds into node 22
    let lowPrevNodeId = '68';
    let lowNodeCounter = 1;
    for (const preset of lowChain) {
      const nodeId = `60:dyn${lowNodeCounter}`;
      lowNodeCounter++;
      
      // Only add if present in loraWeights (enabled)
      if (Object.prototype.hasOwnProperty.call(params.loraWeights, preset.id)) {
        const weight = params.loraWeights[preset.id];
        const strength = typeof weight === 'number' && Number.isFinite(weight) ? weight : preset.default;
        workflow.input.workflow[nodeId] = {
          inputs: {
            lora_name: preset.id,
            strength_model: strength,
            model: [lowPrevNodeId, 0],
          },
          class_type: 'LoraLoaderModelOnly',
          _meta: {
            title: preset.label || preset.id,
          },
        };
        lowPrevNodeId = nodeId;
      }
    }
    
    // Update node 22 to consume the last low chain node
    if (workflow.input.workflow['22'] && lowChain.length > 0) {
      workflow.input.workflow['22'].inputs.model = [lowPrevNodeId, 0];
    }
  }

  return workflow;
}
