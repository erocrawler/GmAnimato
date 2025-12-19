import type { Workflow } from './db';
import type { LoraPreset } from './loraPresets';

export type WorkflowMetadata = {
  id: string;
  name: string;
  description?: string;
  templatePath: string;
  compatibleLoraIds: string[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Get compatible LoRA presets for a given workflow
 */
export function filterLorasForWorkflow(
  allLoraPresets: LoraPreset[],
  workflow: Workflow
): LoraPreset[] {
  return allLoraPresets.filter((lora) => workflow.compatibleLoraIds.includes(lora.id));
}

/**
 * Check if a LoRA is compatible with a workflow
 */
export function isLoraCompatible(loraId: string, workflow: Workflow): boolean {
  return workflow.compatibleLoraIds.includes(loraId);
}

/**
 * Filter LoRA weights to only include compatible ones for a workflow
 */
export function filterLoraWeights(
  loraWeights: Record<string, number>,
  workflow: Workflow
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(loraWeights).filter(([loraId]) => isLoraCompatible(loraId, workflow))
  );
}
