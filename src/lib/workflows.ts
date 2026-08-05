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
 * Identify MiniMax H3 workflows by their template path.
 * MiniMax H3 uses a different node stack (no WAN nodes/LoRAs/negative prompt),
 * so WAN-only controls (steps, motion scale, free-long, relay, LoRAs) must be
 * hidden in the review UI and skipped in the builder.
 */
export function isMiniMaxWorkflow(workflow: Pick<Workflow, 'templatePath'>): boolean {
  return (workflow?.templatePath || '').toLowerCase().includes('minimax');
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
