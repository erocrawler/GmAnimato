/**
 * MiniMax H3 "768p" two-stage graph transform.
 *
 * Takes a finished SINGLE-stage H3 payload (ref2v or i2v/fl2v builders) and
 * rewrites it into the validated two-stage layout:
 *
 *   stage 1  low-res (half the edges) sampling over the first part of the sigma
 *            schedule
 *   lift     MiniMaxH3LatentUpscaleWithModel on stage 1's *denoised_output*
 *            (the x0 prediction) — a learned latent upscaler, audio untouched
 *   stage 2  high-res sampling over the rest of the schedule, starting from the
 *            lifted latent re-noised (fresh RandomNoise, same seed) at the
 *            switch sigma
 *
 * Validated on the L40S worker and on serverless (2026-10-30):
 *   - official H3 + Pika Flex (ManualSigmas, 6 steps, lcm): 3 + 3
 *   - Singularity / Dasiwa hybrids (BasicScheduler, 8 steps, euler): 6 + 2
 * Nodes are located by class_type, never by hard-coded id, so any template that
 * has the usual H3 stack works. ESRGAN (add720pUpscaleNodes) is NOT used here.
 */
import { findNode, getNodeInputs } from './workflowUtils';

/** Latent upscaler weights: baked into the worker image and present on the L40S. */
export const H3_LATENT_UPSCALER_MODEL = 'minimax_h3_latent_upscaler_3d_fp16_V2.safetensors';

/** Worker capability a worker must declare to run 768p (see api/worker/task). */
export const H3_TWO_STAGE_CAPABILITY = 'h3_latent_upscale';

export interface H3TwoStageOptions {
  highWidth: number;
  highHeight: number;
  lowWidth: number;
  lowHeight: number;
  seed: number;
}

export interface H3TwoStageResult {
  /** Number of sampling steps run at low resolution. */
  lowSteps: number;
  /** Number of sampling steps run at high resolution. */
  highSteps: number;
  /** Ids of the nodes this transform added (useful for tests/logging). */
  addedNodeIds: string[];
}

const CHAIN_CLASSES = new Set([
  'MiniMaxH3SigmaShift',
  'MiniMaxH3MemoryEfficientSageAttentionPatch'
]);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * How many of `steps` run at low resolution. 8 -> 6, 6 -> 3, 4 -> 2: the
 * validated splits (6+2 for the 8-step turbo hybrids, 3+3 for the 6-step Flex
 * schedule); always leaves at least 1 step per stage.
 */
export function chooseSplitStep(steps: number): number {
  const split = steps === 6 ? 3 : Math.round(steps * 0.75);
  return Math.max(1, Math.min(steps - 1, split));
}

function parseSigmas(raw: unknown): number[] {
  return String(raw)
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));
}

export function applyH3TwoStage(workflow: any, opts: H3TwoStageOptions): H3TwoStageResult {
  const wf = workflow.input.workflow as Record<string, any>;
  const weights = (workflow.input.node_weights ??= {}) as Record<string, number>;
  const added: string[] = [];
  const add = (id: string, node: any, weight?: number) => {
    wf[id] = node;
    if (weight !== undefined) weights[id] = weight;
    added.push(id);
    return id;
  };

  const encodeId =
    findNode(workflow, 'MiniMaxH3ReferenceToVideo') ?? findNode(workflow, 'MiniMaxH3ImageToVideo');
  const samplerId = findNode(workflow, 'SamplerCustomAdvanced');
  const guiderId = findNode(workflow, 'BasicGuider');
  const noiseId = findNode(workflow, 'RandomNoise');
  const decodeId = findNode(workflow, 'VAEDecode');
  const audioDecodeId = findNode(workflow, 'VAEDecodeAudio');
  const errors: string[] = [];
  if (!encodeId) errors.push('MiniMaxH3ReferenceToVideo/ImageToVideo node not found');
  if (!samplerId) errors.push('SamplerCustomAdvanced node not found');
  if (!guiderId) errors.push('BasicGuider node not found');
  if (!noiseId) errors.push('RandomNoise node not found');
  if (!decodeId) errors.push('VAEDecode node not found');
  if (errors.length > 0) {
    throw new Error(`H3 two-stage transform: ${errors.join('; ')}`);
  }

  const encode = wf[encodeId as string];
  const sampler = wf[samplerId as string];
  const guider = wf[guiderId as string];
  const noise = wf[noiseId as string];

  // ---- sigma schedule split -------------------------------------------------
  const sigmaSourceId = Array.isArray(sampler.inputs.sigmas) ? (sampler.inputs.sigmas[0] as string) : null;
  const sigmaSource = sigmaSourceId ? wf[sigmaSourceId] : null;
  let lowSigmasRef: [string, number];
  let highSigmasRef: [string, number];
  let lowSteps: number;
  let highSteps: number;

  if (sigmaSource?.class_type === 'BasicScheduler') {
    const steps = Number(sigmaSource.inputs.steps);
    const split = chooseSplitStep(steps);
    // SplitSigmas: output 0 = sigmas[:split+1], output 1 = sigmas[split:].
    const splitId = add('105:3000:sigma_split', {
      class_type: 'SplitSigmas',
      inputs: { sigmas: [sigmaSourceId, 0], step: split },
      _meta: { title: 'Split Sigmas (H3 two-stage)' }
    });
    lowSigmasRef = [splitId, 0];
    highSigmasRef = [splitId, 1];
    lowSteps = split;
    highSteps = steps - split;
  } else if (sigmaSource?.class_type === 'ManualSigmas') {
    const values = parseSigmas(sigmaSource.inputs.sigmas);
    const steps = values.length - 1;
    if (steps < 2) throw new Error('H3 two-stage transform: ManualSigmas needs at least 2 steps');
    const split = chooseSplitStep(steps);
    sigmaSource.inputs.sigmas = values.slice(0, split + 1).join(', ');
    const highId = add('105:3000:sigmas_high', {
      class_type: 'ManualSigmas',
      inputs: { sigmas: values.slice(split).join(', ') },
      _meta: { title: 'Manual Sigmas (high-res stage)' }
    });
    lowSigmasRef = [sigmaSourceId as string, 0];
    highSigmasRef = [highId, 0];
    lowSteps = split;
    highSteps = steps - split;
  } else {
    throw new Error('H3 two-stage transform: unsupported sigma source (need BasicScheduler or ManualSigmas)');
  }
  sampler.inputs.sigmas = lowSigmasRef;

  // ---- stage 1: low resolution ---------------------------------------------
  const encodeHighId = add('105:3001:encode_high', clone(encode));
  wf[encodeHighId].inputs.width = opts.highWidth;
  wf[encodeHighId].inputs.height = opts.highHeight;
  encode.inputs.width = opts.lowWidth;
  encode.inputs.height = opts.lowHeight;

  // ---- stage 2 model chain: independent clones of the sigma-shift/sage patch
  // chain, exactly as the validated graphs (one patch per stage) ----------------
  let highModelRef: unknown = guider.inputs.model;
  if (Array.isArray(guider.inputs.model)) {
    const chain: string[] = [];
    let cursor = guider.inputs.model[0] as string;
    while (wf[cursor] && CHAIN_CLASSES.has(wf[cursor].class_type) && !chain.includes(cursor)) {
      chain.push(cursor);
      const next = wf[cursor].inputs?.model;
      if (!Array.isArray(next)) break;
      cursor = next[0] as string;
    }
    if (chain.length > 0) {
      // chain[0] is the node feeding the guider; the last one reads the base model.
      const idMap = new Map<string, string>();
      for (const id of chain) idMap.set(id, `${id}:high`);
      for (const id of chain) {
        const copy = clone(wf[id]);
        const upstream = copy.inputs?.model;
        if (Array.isArray(upstream) && idMap.has(upstream[0] as string)) {
          copy.inputs.model = [idMap.get(upstream[0] as string), upstream[1]];
        }
        add(idMap.get(id) as string, copy, 1.0);
      }
      highModelRef = [idMap.get(chain[0]) as string, guider.inputs.model[1]];
    }
  }

  const guiderHighId = add('105:3002:guider_high', clone(guider));
  wf[guiderHighId].inputs.model = highModelRef;
  wf[guiderHighId].inputs.conditioning = [encodeHighId, 0];

  // ---- lift: learned latent upscaler on stage 1's denoised_output -------------
  const loaderId = add(
    '105:3003:latent_upscale_loader',
    {
      class_type: 'LatentUpscaleModelLoader',
      inputs: { model_name: H3_LATENT_UPSCALER_MODEL },
      _meta: { title: 'Load H3 Latent Upscaler' }
    },
    1.0
  );
  const liftId = add(
    '105:3004:latent_upscale',
    {
      class_type: 'MiniMaxH3LatentUpscaleWithModel',
      inputs: {
        model: [loaderId, 0],
        samples: [samplerId, 1],
        width: opts.highWidth,
        height: opts.highHeight
      },
      _meta: { title: 'MiniMax H3 Latent Upscale (stage lift)' }
    },
    3.0
  );

  // ---- stage 2: high resolution, fresh noise at the switch sigma ---------------
  const noiseHighId = add('105:3005:noise_high', clone(noise));
  wf[noiseHighId].inputs.noise_seed = Math.floor(opts.seed);
  const samplerHighId = add('105:3006:sampler_high', {
    ...clone(sampler),
    inputs: {
      ...clone(sampler.inputs),
      noise: [noiseHighId, 0],
      guider: [guiderHighId, 0],
      sigmas: highSigmasRef,
      latent_image: [liftId, 0]
    }
  });

  // ---- decode from stage 2 -----------------------------------------------------
  const decodeInputs = getNodeInputs(workflow, decodeId as string);
  if (decodeInputs) decodeInputs.samples = [samplerHighId, 0];
  if (audioDecodeId) {
    const audioInputs = getNodeInputs(workflow, audioDecodeId);
    if (audioInputs) audioInputs.samples = [samplerHighId, 0];
  }

  // ---- progress weights: split the sampling weight by step share ----------------
  const totalSamplingWeight = weights[samplerId as string] ?? 60.0;
  // Stage 2 runs at 4x the pixels per step, so weight it by cost, not step count.
  const lowCost = lowSteps * 1;
  const highCost = highSteps * 4;
  weights[samplerId as string] = (totalSamplingWeight * lowCost) / (lowCost + highCost);
  weights[samplerHighId] = (totalSamplingWeight * highCost) / (lowCost + highCost);

  return { lowSteps, highSteps, addedNodeIds: added };
}
