import fs from 'fs/promises';
import path from 'path';
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

  // Configure video resolution (default 480p)
  const resolution = params.videoResolution ?? '480p';
  const longSide = resolution === '720p' ? 1280 : 832;
  const shortSide = resolution === '720p' ? 720 : 480;
  if (workflow?.input?.workflow?.['26']?.inputs) {
    workflow.input.workflow['26'].inputs.value = longSide;
  }
  if (workflow?.input?.workflow?.['27']?.inputs) {
    workflow.input.workflow['27'].inputs.value = shortSide;
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
