/**
 * User-selected ("style") LoRAs for the MiniMax H3 graphs.
 *
 * The Wan builders chain every enabled preset onto their high/low model before
 * the graph is sent; the H3 builders only handled the required speed-up LoRA, so
 * LoRAs picked in the UI never reached the graph. The worker does not touch the
 * workflow (it only declares capabilities) — the site must send the chain fully
 * wired.
 *
 * Enabled = present in `loraWeights` (kickoff already filtered them to the
 * workflow's compatible LoRAs). They are chained in preset order AFTER the
 * required LoRA (turbo speed-up, or the Flex LoRA wired in the template), and
 * BEFORE the sigma-shift / sage patch, so both sampling stages of the 768p
 * two-stage graph share them.
 */
import { findNode, getNodeInputs } from './workflowUtils';
import { normalizeLoraPresets, type LoraPreset } from './loraPresets';

export const H3_STYLE_LORA_NODE_PREFIX = '105:1100:style';

export function applyH3StyleLoras(
  workflow: any,
  loraPresets: LoraPreset[] | undefined,
  loraWeights: Record<string, number> | undefined
): string[] {
  if (!loraPresets || !loraWeights) return [];
  const styles = normalizeLoraPresets(loraPresets).filter(
    (p) => p.isConfigurable !== false && Object.prototype.hasOwnProperty.call(loraWeights, p.id)
  );
  if (styles.length === 0) return [];

  const sigmaShiftNode = findNode(workflow, 'MiniMaxH3SigmaShift');
  const schedulerNode = findNode(workflow, 'BasicScheduler');
  const guiderNode = findNode(workflow, 'BasicGuider');
  const consumers = [sigmaShiftNode, schedulerNode, guiderNode]
    .filter((id): id is string => !!id)
    .map((id) => ({ id, inputs: getNodeInputs(workflow, id) }))
    .filter((c) => c.inputs && Array.isArray(c.inputs.model));
  if (consumers.length === 0) {
    throw new Error('H3 style LoRAs: no node consuming the model was found in the template');
  }

  // Current head of the model chain: what the sigma-shift (or, without it, the
  // scheduler/guider) reads today — the speed-up/template LoRA or the UNETLoader.
  const head = (consumers[0].inputs as any).model as [string, number];
  const original = head[0];

  const added: string[] = [];
  let prev: [string, number] = [head[0], head[1]];
  styles.forEach((preset, i) => {
    const weight = loraWeights[preset.id];
    const strength = typeof weight === 'number' && Number.isFinite(weight) ? weight : preset.default;
    const id = `${H3_STYLE_LORA_NODE_PREFIX}${i + 1}`;
    workflow.input.workflow[id] = {
      inputs: { lora_name: preset.id, strength_model: strength, model: prev },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: preset.label || preset.id }
    };
    (workflow.input.node_weights ??= {})[id] = 1.0;
    added.push(id);
    prev = [id, 0];
  });

  for (const c of consumers) {
    const m = (c.inputs as any).model;
    if (Array.isArray(m) && m[0] === original) (c.inputs as any).model = [prev[0], 0];
  }
  return added;
}
