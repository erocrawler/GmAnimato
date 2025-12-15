import fs from 'fs/promises';
import path from 'path';
import probe from 'probe-image-size';
import type { LoraPreset } from './loraPresets';
import { normalizeLoraPresets } from './loraPresets';

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
  templatePath?: string;
}

/**
 * Round to nearest multiple of 16
 */
function roundToMultipleOf16(value: number): number {
  return Math.round(value / 16) * 16;
}

/**
 * Calculate video dimensions based on image aspect ratio and resolution
 * @param imageWidth Original image width
 * @param imageHeight Original image height
 * @param resolution Target resolution (480p or 720p)
 * @returns {width, height} Video dimensions (both multiples of 16)
 */
function calculateVideoDimensions(
  imageWidth: number,
  imageHeight: number,
  resolution: '480p' | '720p'
): { width: number; height: number } {
  const longSide = resolution === '720p' ? 1280 : 832;
  const squareSide = resolution === '720p' ? 960 : 640;
  const aspectRatio = imageWidth / imageHeight;
  
  // Portrait (taller than wide)
  if (aspectRatio < 0.95) {
    const width = roundToMultipleOf16(longSide * aspectRatio);
    return { width, height: longSide };
  }
  // Landscape (wider than tall)
  else if (aspectRatio > 1.05) {
    const height = roundToMultipleOf16(longSide / aspectRatio);
    return { width: longSide, height };
  }
  // Square (roughly 1:1 ratio, within 5% tolerance)
  else {
    return { width: squareSide, height: squareSide };
  }
}

export async function buildWorkflow(params: WorkflowParams): Promise<object> {
  const templatePath = params.templatePath || path.resolve('data/api_template.json.tmpl');
  let template = await fs.readFile(templatePath, 'utf-8');

  // Sanitize and replace placeholders using JSON.stringify to properly escape values
  // slice(1, -1) removes the outer quotes that JSON.stringify adds
  template = template.replace(/{image_name}/g, JSON.stringify(params.image_name).slice(1, -1));
  template = template.replace(/{image_url}/g, JSON.stringify(params.image_url).slice(1, -1));
  template = template.replace(/{input_prompt}/g, JSON.stringify(params.input_prompt).slice(1, -1));
  template = template.replace(/{seed}/g, String(Math.floor(params.seed))); // Ensure seed is a valid integer

  const workflow = JSON.parse(template);
  
  // Validate workflow structure matches our assumptions
  const validationErrors: string[] = [];
  
  if (!workflow?.input?.workflow) {
    validationErrors.push('Workflow missing input.workflow structure');
  } else {
    const wf = workflow.input.workflow;
    
    // Validate node 10 (WanImageToVideo)
    if (!wf['10']) {
      validationErrors.push('Node 10 (WanImageToVideo) not found in workflow');
    } else if (wf['10'].class_type !== 'WanImageToVideo') {
      validationErrors.push(`Node 10 expected class_type 'WanImageToVideo', got '${wf['10'].class_type}'`);
    } else if (!wf['10'].inputs || typeof wf['10'].inputs.width === 'undefined' || typeof wf['10'].inputs.height === 'undefined' || typeof wf['10'].inputs.length === 'undefined') {
      validationErrors.push('Node 10 missing required inputs (width, height, length)');
    }
    
    // Validate node 15 (ImageResize+)
    if (!wf['15']) {
      validationErrors.push('Node 15 (ImageResize+) not found in workflow');
    } else if (wf['15'].class_type !== 'ImageResize+') {
      validationErrors.push(`Node 15 expected class_type 'ImageResize+', got '${wf['15'].class_type}'`);
    } else if (!wf['15'].inputs || typeof wf['15'].inputs.width === 'undefined' || typeof wf['15'].inputs.height === 'undefined') {
      validationErrors.push('Node 15 missing required inputs (width, height)');
    }
    
    // Validate node 44 (WanMoeKSampler) - for iteration steps and node weights
    if (!wf['44']) {
      validationErrors.push('Node 44 (WanMoeKSampler) not found in workflow');
    } else if (wf['44'].class_type !== 'WanMoeKSampler') {
      validationErrors.push(`Node 44 expected class_type 'WanMoeKSampler', got '${wf['44'].class_type}'`);
    } else if (!wf['44'].inputs || typeof wf['44'].inputs.steps === 'undefined') {
      validationErrors.push('Node 44 missing required input (steps)');
    }
    
    // Validate node 4 (VAEDecode) - for node weights
    if (!wf['4']) {
      validationErrors.push('Node 4 (VAEDecode) not found in workflow');
    } else if (wf['4'].class_type !== 'VAEDecode') {
      validationErrors.push(`Node 4 expected class_type 'VAEDecode', got '${wf['4'].class_type}'`);
    }
    
    // Validate node 16 (VHS_VideoCombine) - for node weights
    if (!wf['16']) {
      validationErrors.push('Node 16 (VHS_VideoCombine) not found in workflow');
    } else if (wf['16'].class_type !== 'VHS_VideoCombine') {
      validationErrors.push(`Node 16 expected class_type 'VHS_VideoCombine', got '${wf['16'].class_type}'`);
    }
  }
  
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
    '44': 60.0,  // WanMoeKSampler - main generation (heavy)
    '4': 20.0,   // VAEDecode - decode latents (moderate)
    '16': 15.0,  // VHS_VideoCombine - video encoding (moderate)
    // Other nodes use default weight of 1.0
  };

  // Configure iteration steps (default 6)
  const steps = params.iterationSteps ?? 6;
  if (workflow?.input?.workflow?.['44']?.inputs) {
    workflow.input.workflow['44'].inputs.steps = steps;
  }

  // Configure video duration (default 4 seconds = 81 frames)
  const duration = params.videoDuration ?? 4;
  const frames = duration === 6 ? 121 : 81;
  if (workflow?.input?.workflow?.['10']?.inputs) {
    workflow.input.workflow['10'].inputs.length = frames;
  }

  // Fetch image dimensions and calculate video dimensions
  const resolution = params.videoResolution ?? '480p';
  try {
    const dimensions = await probe(params.image_url);
    const { width, height } = calculateVideoDimensions(dimensions.width, dimensions.height, resolution);
    console.log(`Image dimensions: ${dimensions.width}x${dimensions.height}, Video dimensions: ${width}x${height}`);
    
    // Set dimensions on the ImageResize node (15) and WanImageToVideo node (10)
    if (workflow?.input?.workflow?.['15']?.inputs) {
      workflow.input.workflow['15'].inputs.width = width;
      workflow.input.workflow['15'].inputs.height = height;
    }
    if (workflow?.input?.workflow?.['10']?.inputs) {
      workflow.input.workflow['10'].inputs.width = width;
      workflow.input.workflow['10'].inputs.height = height;
    }
  } catch (error) {
    console.error('Failed to probe image dimensions:', error);
    // Fallback to default landscape dimensions
    const longSide = resolution === '720p' ? 1280 : 832;
    const shortSide = resolution === '720p' ? 720 : 480;
    if (workflow?.input?.workflow?.['15']?.inputs) {
      workflow.input.workflow['15'].inputs.width = longSide;
      workflow.input.workflow['15'].inputs.height = shortSide;
    }
    if (workflow?.input?.workflow?.['10']?.inputs) {
      workflow.input.workflow['10'].inputs.width = longSide;
      workflow.input.workflow['10'].inputs.height = shortSide;
    }
  }

  // Override LoRA strengths when provided and dynamically build chains
  if (params.loraWeights && params.loraPresets) {
    const presets = normalizeLoraPresets(params.loraPresets);
    
    // Separate base (fixed) and configurable presets
    const basePresets = presets.filter((p) => !p.isConfigurable);
    const configurablePresets = presets.filter((p) => p.isConfigurable);
    
    // Apply base LoRAs (always present, just update weights if provided)
    for (const preset of basePresets) {
      const nodeInputs = workflow?.input?.workflow?.[preset.nodeId]?.inputs;
      if (!nodeInputs) continue;
      
      if (preset.id) {
        nodeInputs.lora_name = preset.id;
      }
      
      const weight = params.loraWeights[preset.id];
      if (typeof weight === 'number' && Number.isFinite(weight)) {
        nodeInputs.strength_model = weight;
      }
    }
    
    // Build dynamic chains for configurable LoRAs
    const highChain = configurablePresets.filter((p) => p.chain === 'high');
    const lowChain = configurablePresets.filter((p) => p.chain === 'low');
    console.log('Building LoRA chains:', { highChain, lowChain });
    
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
