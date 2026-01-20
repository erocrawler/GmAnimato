import fs from 'fs/promises';
import path from 'path';
import probe from 'probe-image-size';
import type { LoraPreset } from './loraPresets';
import type { Workflow } from './IDatabase';
import { normalizeLoraPresets } from './loraPresets';
import { findNode, getNodeInputs, calculateVideoDimensions, add720pUpscaleNodes, addMotionScaleNode, addFreeLongNode, DEFAULT_NEGATIVE_PROMPT } from './workflowUtils';

interface WorkflowParams {
  image_name: string;
  image_url: string;
  input_prompt: string;
  seed: number;
  callback_url?: string;
  iterationSteps?: 4 | 6 | 8;
  videoDuration?: 4 | 6;
  videoResolution?: '480p' | '720p';
  loraWeights?: Record<string, number>;
  loraPresets?: LoraPreset[];
  motionScale?: number; // 0.5 to 2.0, optional
  freeLongBlendStrength?: number; // 0 to 1, optional (0 = off, 1 = full)
  workflow?: Workflow;
}

export async function buildWorkflow(params: WorkflowParams): Promise<object> {
  // Resolve template path from workflow object or use default
  const resolvedTemplatePath = params.workflow?.templatePath || path.resolve('data/api_template.json.tmpl');
  let template = await fs.readFile(resolvedTemplatePath, 'utf-8');

  // Sanitize and replace placeholders using JSON.stringify to properly escape values
  // slice(1, -1) removes the outer quotes that JSON.stringify adds
  template = template.replace(/{image_name}/g, JSON.stringify(params.image_name).slice(1, -1));
  template = template.replace(/{image_url}/g, JSON.stringify(params.image_url).slice(1, -1));
  template = template.replace(/{input_prompt}/g, JSON.stringify(params.input_prompt).slice(1, -1));
  template = template.replace(/{negative_prompt}/g, JSON.stringify(DEFAULT_NEGATIVE_PROMPT).slice(1, -1));
  template = template.replace(/{seed}/g, String(Math.floor(params.seed))); // Ensure seed is a valid integer

  const workflow = JSON.parse(template);
  
  // Find all required nodes dynamically
  const encodeNode = findNode(workflow, 'WanImageToVideo');
  const resizeNode = findNode(workflow, 'ImageResizeKJ');
  const samplerNode = findNode(workflow, 'WanMoeKSampler');
  const decodeNode = findNode(workflow, 'VAEDecode');
  const videoCombineNode = findNode(workflow, 'VHS_VideoCombine');
  
  // Validate all required nodes are present
  const validationErrors: string[] = [];
  
  if (!encodeNode) validationErrors.push('WanImageToVideo node not found');
  if (!resizeNode) validationErrors.push('ImageResizeKJ node not found');
  if (!samplerNode) validationErrors.push('WanMoeKSampler node not found');
  if (!decodeNode) validationErrors.push('VAEDecode node not found');
  if (!videoCombineNode) validationErrors.push('VHS_VideoCombine node not found');
  
  if (validationErrors.length > 0) {
    console.error('Workflow validation errors:', validationErrors);
    throw new Error(`Workflow template validation failed:\n${validationErrors.join('\n')}`);
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

  // Always generate at 480p for efficiency, then upscale to 720p if needed
  const resolution = params.videoResolution ?? '480p';
  let gen480pWidth: number;
  let gen480pHeight: number;
  let originalImageWidth: number;
  let originalImageHeight: number;
  
  try {
    const dimensions = await probe(params.image_url);
    originalImageWidth = dimensions.width;
    originalImageHeight = dimensions.height;
    
    // Always calculate for 480p generation
    const { width, height } = calculateVideoDimensions(dimensions.width, dimensions.height, '480p');
    gen480pWidth = width;
    gen480pHeight = height;
    
    // Set dimensions on the ImageResize node and WanImageToVideo node
    const resizeInputs = getNodeInputs(workflow, resizeNode);
    if (resizeInputs) {
      resizeInputs.width = width;
      resizeInputs.height = height;
    }
    
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
    
    const resizeInputs = getNodeInputs(workflow, resizeNode);
    if (resizeInputs) {
      resizeInputs.width = gen480pWidth;
      resizeInputs.height = gen480pHeight;
    }
    
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

  // Find the high UNet node to insert motion scale and freelong
  const highUnetNode = findNode(workflow, 'UnetLoaderGGUF', (node: any) => 
    node.inputs?.unet_name?.toLowerCase().includes('high') || 
    node._meta?.title?.toLowerCase().includes('high')
  );
  
  // Insert WanMotionScale and WanFreeLong right after high UNet, before LoRAs
  // This creates: High UNet → MotionScale → FreeLong → LoRAs → TeaCache
  let highChainStart = highUnetNode as string;
  if (highUnetNode) {
    const motionScaleNodeId = addMotionScaleNode(workflow, params.motionScale, highUnetNode as string);
    highChainStart = motionScaleNodeId 
      ? (addFreeLongNode(workflow, params.freeLongBlendStrength, frames, motionScaleNodeId) || motionScaleNodeId)
      : (addFreeLongNode(workflow, params.freeLongBlendStrength, frames, highUnetNode as string) || highUnetNode);
  }

  // Override LoRA strengths when provided and dynamically build chains
  if (params.loraWeights && params.loraPresets) {
    const presets = normalizeLoraPresets(params.loraPresets);
    
    // Build dynamic chains for all LoRAs (both base and configurable)
    const highChain = presets.filter((p) => p.chain === 'high');
    const lowChain = presets.filter((p) => p.chain === 'low');
    console.log('Building LoRA chains:', { highChain, lowChain });
    
    // Find the UnetLoader and TeaCache nodes for high and low chains
    const lowUnetNode = findNode(workflow, 'UnetLoaderGGUF', (node: any) => 
      node.inputs?.unet_name?.toLowerCase().includes('low') || 
      node._meta?.title?.toLowerCase().includes('low')
    );
    const highTeaCacheNode = findNode(workflow, 'TeaCache', (node: any) => 
      Array.isArray(node.inputs?.model) && node.inputs.model[0] === highUnetNode
    );
    const lowTeaCacheNode = findNode(workflow, 'TeaCache', (node: any) => 
      Array.isArray(node.inputs?.model) && node.inputs.model[0] === lowUnetNode
    );
    
    if (!highUnetNode || !lowUnetNode || !highTeaCacheNode || !lowTeaCacheNode) {
      console.error('LoRA chain nodes not found:', { highUnetNode, lowUnetNode, highTeaCacheNode, lowTeaCacheNode });
      throw new Error('Required LoRA chain nodes not found in template');
    }
    
    // High noise chain: starts from motionScale/freeLong output (or UNet if neither enabled)
    let highPrevNodeId = highChainStart;
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
    
    // Update highTeaCacheNode to consume the last high chain node
    const highTeaCacheInputs = getNodeInputs(workflow, highTeaCacheNode);
    if (highTeaCacheInputs && highChain.length > 0) {
      highTeaCacheInputs.model = [highPrevNodeId, 0];
    }
    
    // Low noise chain: starts from lowUnetNode output, feeds into lowTeaCacheNode
    let lowPrevNodeId = lowUnetNode as string;
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
    
    // Update lowTeaCacheNode to consume the last low chain node
    const lowTeaCacheInputs = getNodeInputs(workflow, lowTeaCacheNode);
    if (lowTeaCacheInputs && lowChain.length > 0) {
      lowTeaCacheInputs.model = [lowPrevNodeId, 0];
    }
  }

  return workflow;
}
