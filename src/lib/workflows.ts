import type { Workflow } from './db';
import type { LoraPreset } from './loraPresets';
import {
  engineFromTemplatePath,
  resolveCapabilities,
  type WorkflowCapabilities,
  type WorkflowEngine,
  type WorkflowRunOn,
} from './workflowCapabilities';

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
 * Resolve a workflow's engine (DB field, falling back to the template-path
 * heuristic for legacy rows that predate the engine column).
 */
export function getWorkflowEngine(
  workflow: Pick<Workflow, 'templatePath' | 'engine'> | null | undefined,
): WorkflowEngine {
  const engine = workflow?.engine;
  return engine === 'wan' || engine === 'minimax'
    ? engine
    : engineFromTemplatePath(workflow?.templatePath);
}

/** Effective runOn for a workflow ('auto' when unset). */
export function getWorkflowRunOn(
  workflow: Pick<Workflow, 'runOn'> | null | undefined,
): WorkflowRunOn {
  return workflow?.runOn === 'serverless' ? 'serverless' : 'auto';
}

/**
 * Effective capability allowlists for a workflow: its configured lists merged
 * over the engine defaults (so legacy rows / empty lists behave like before).
 */
export function getWorkflowCapabilities(
  workflow: Pick<Workflow, 'engine' | 'capabilities' | 'templatePath'> | null | undefined,
): Required<WorkflowCapabilities> {
  const engine = getWorkflowEngine(workflow);
  const caps = workflow?.capabilities ?? {};
  return resolveCapabilities(engine, caps);
}

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
 * Identify MiniMax H3 workflows by their engine (DB) field.
 * MiniMax H3 uses a different node stack (no WAN nodes/LoRAs/negative prompt),
 * so WAN-only controls (steps, motion scale, free-long, relay, LoRAs) must be
 * hidden in the review UI and skipped in the builder. Falls back to the
 * template-path heuristic only for legacy rows without an engine value.
 */
export function isMiniMaxWorkflow(
  workflow: Pick<Workflow, 'templatePath' | 'engine'> | null | undefined,
): boolean {
  return getWorkflowEngine(workflow) === 'minimax';
}

/**
 * Check if a LoRA is compatible with a workflow
 */
export function isLoraCompatible(loraId: string, workflow: Workflow): boolean {
  return workflow.compatibleLoraIds.includes(loraId);
}

/**
 * Required LoRAs (presets with isConfigurable=false, e.g. the speed-up LoRA)
 * are not optional: the web UI always sends them, so the server enforces the
 * same for every client. A compatible required preset is always applied: an
 * omitted, zero, negative or non-numeric client value becomes the preset default
 * (without the LoRA the job would run the slow, undistilled template), and a
 * positive client value is clamped into the preset's [min, max]. A preset with
 * min == max == default is therefore a fixed strength; a wider range is the range
 * the user may pick within.
 */
export function withRequiredLoras(
  loraWeights: Record<string, number> | undefined,
  workflow: Workflow,
  presets: ReadonlyArray<{ id: string; default: number; min?: number; max?: number; isConfigurable?: boolean }>
): Record<string, number> | undefined {
  const required = presets.filter((p) => p.isConfigurable === false && isLoraCompatible(p.id, workflow));
  if (required.length === 0) return loraWeights;
  const out: Record<string, number> = { ...(loraWeights ?? {}) };
  for (const p of required) {
    const v = out[p.id];
    const lo = p.min ?? p.default;
    const hi = p.max ?? p.default;
    out[p.id] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : p.default;
  }
  return out;
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
