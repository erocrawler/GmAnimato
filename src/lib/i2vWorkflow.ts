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
  loraWeights?: Record<string, number>;
  loraPresets?: LoraPreset[];
}

export async function buildWorkflow(params: WorkflowParams): Promise<object> {
  const templatePath = path.resolve('data/api_template.json.tmpl');
  let template = await fs.readFile(templatePath, 'utf-8');

  // Replace placeholders
  template = template.replace(/{image_name}/g, params.image_name);
  template = template.replace(/{image_url}/g, params.image_url);
  template = template.replace(/{input_prompt}/g, params.input_prompt);
  template = template.replace(/{seed}/g, String(params.seed));

  const workflow = JSON.parse(template);
  
  // Add callback_url to input if provided
  if (params.callback_url) {
    workflow.input.callback_url = params.callback_url;
  }

  // Configure iteration steps (default 6)
  const steps = params.iterationSteps ?? 6;
  if (workflow?.input?.workflow?.['44']?.inputs) {
    workflow.input.workflow['44'].inputs.steps = steps;
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
    
    // High noise chain: starts from node 67 output, feeds into node 21
    let highPrevNodeId = '67';
    let highNodeCounter = 1;
    for (const preset of highChain) {
      const nodeId = `61:dyn${highNodeCounter}`;
      highNodeCounter++;
      
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
    
    // Update node 22 to consume the last low chain node
    if (workflow.input.workflow['22'] && lowChain.length > 0) {
      workflow.input.workflow['22'].inputs.model = [lowPrevNodeId, 0];
    }
  }

  return workflow;
}
