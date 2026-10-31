import { describe, expect, it, vi } from 'vitest';

// The builders probe image/video sizes over the network — pin the probe result.
vi.mock('probe-image-size', () => ({ default: async () => ({ width: 832, height: 1480 }) }));

import { buildRef2VWorkflow } from '../src/lib/ref2vWorkflow';
import { buildMiniMaxWorkflow } from '../src/lib/minimaxWorkflow';
import { calculateH3TwoStageDimensions, calculateVideoDimensions } from '../src/lib/workflowUtils';
import { chooseSplitStep } from '../src/lib/h3TwoStage';
import { computeWorkflowQuotaCost, isQuotaCostRule } from '../src/lib/quotaCost';
import { normalizeWorkflowCapabilities, resolveCapabilities } from '../src/lib/workflowCapabilities';

type Graph = Record<string, any>;
const nodesOf = (wf: any, cls: string): [string, any][] =>
  Object.entries(wf.input.workflow as Graph).filter(([, n]) => n.class_type === cls);
const one = (wf: any, cls: string) => {
  const found = nodesOf(wf, cls);
  expect(found, `exactly one ${cls}`).toHaveLength(1);
  return found[0];
};

const turboPreset = {
  id: 'turbo8.safetensors',
  label: 'turbo',
  default: 1,
  min: 0,
  max: 1.5,
  step: 0.05,
  isConfigurable: false,
};

const r2vBase = {
  ref_video_name: '',
  ref_video_url: '',
  input_prompt: 'a test prompt',
  seed: 42,
  ref2vAspect: '16:9' as const,
  videoDuration: 6 as const,
};

describe('768p dimensions', () => {
  it('is 1344x768 at 16:9 (low stage = half the edges) — floor rounding would give 736', () => {
    expect(calculateH3TwoStageDimensions(1920, 1080)).toEqual({
      highWidth: 1344,
      highHeight: 768,
      lowWidth: 672,
      lowHeight: 384,
    });
    expect(calculateH3TwoStageDimensions(854, 480)).toMatchObject({ highWidth: 1344, highHeight: 768 });
  });

  it('flips for portrait and keeps every edge a multiple of 32 (high) / 16 (low)', () => {
    const p = calculateH3TwoStageDimensions(480, 832);
    expect(p).toMatchObject({ highWidth: 768, highHeight: 1344, lowWidth: 384, lowHeight: 672 });
    for (const [w, h] of [[1920, 1080], [1000, 1000], [1200, 900], [900, 1600], [2000, 1000]]) {
      const d = calculateH3TwoStageDimensions(w, h);
      expect(d.highWidth % 32).toBe(0);
      expect(d.highHeight % 32).toBe(0);
      expect(d.lowWidth % 16).toBe(0);
      expect(d.lowHeight % 16).toBe(0);
    }
  });

  it('leaves the 480p / 720p numbers unchanged', () => {
    expect(calculateVideoDimensions(1920, 1080, '480p', { roundToMultiple: 32, rounding: 'floor' })).toEqual({
      width: 832,
      height: 480,
    });
    expect(calculateVideoDimensions(1920, 1080, '720p')).toEqual({ width: 1280, height: 720 });
  });
});

describe('chooseSplitStep', () => {
  it('matches the validated splits: 8 -> 6+2, 6 -> 3+3', () => {
    expect(chooseSplitStep(8)).toBe(6);
    expect(chooseSplitStep(6)).toBe(3);
  });
  it('always leaves at least one step per stage', () => {
    for (const n of [2, 3, 4, 5, 20]) {
      const s = chooseSplitStep(n);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(n - s).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('ref2v 768p — Flex recipe (ManualSigmas 3+3, lcm, no turbo)', () => {
  const build = (extra: Record<string, unknown> = {}) =>
    buildRef2VWorkflow({
      ...r2vBase,
      videoResolution: '768p',
      workflow: { templatePath: 'data/minimax_ref2v_flex.json.tmpl' } as any,
      // the workflow's required LoRA (admin preset) is what fills the template LoRA node
      loraPresets: [turboPreset as any],
      loraWeights: { [turboPreset.id]: 1 },
      ...extra,
    }) as Promise<any>;

  it('builds a two-stage graph with the validated shape', async () => {
    const wf = await build();
    const encodes = nodesOf(wf, 'MiniMaxH3ReferenceToVideo');
    expect(encodes).toHaveLength(2);
    const dims = encodes.map(([, n]) => `${n.inputs.width}x${n.inputs.height}`).sort();
    expect(dims).toEqual(['1344x768', '672x384']);

    expect(nodesOf(wf, 'SamplerCustomAdvanced')).toHaveLength(2);
    expect(nodesOf(wf, 'BasicGuider')).toHaveLength(2);
    expect(nodesOf(wf, 'RandomNoise')).toHaveLength(2);
    const [, lift] = one(wf, 'MiniMaxH3LatentUpscaleWithModel');
    expect(lift.inputs.width).toBe(1344);
    expect(lift.inputs.height).toBe(768);
    const [, loader] = one(wf, 'LatentUpscaleModelLoader');
    expect(loader.inputs.model_name).toBe('minimax_h3_latent_upscaler_3d_fp16_V2.safetensors');
    // ESRGAN is for the 720p option only
    expect(nodesOf(wf, 'ImageUpscaleWithModel')).toHaveLength(0);
    expect(nodesOf(wf, 'UpscaleModelLoader')).toHaveLength(0);
  });

  it('splits the Flex sigmas 3+3 and uses lcm', async () => {
    const wf = await build();
    const sigmas = nodesOf(wf, 'ManualSigmas').map(([, n]) => n.inputs.sigmas as string);
    expect(sigmas).toHaveLength(2);
    const parsed = sigmas.map((s) => s.split(',').map((v) => Number(v)));
    expect(parsed[0]).toEqual([1, 0.972973, 0.923077, 0.8]);
    expect(parsed[1]).toEqual([0.8, 0.571429, 0.333333, 0]);
    expect(one(wf, 'KSamplerSelect')[1].inputs.sampler_name).toBe('lcm');
  });

  it('lifts stage 1 denoised_output and decodes stage 2 (video and audio)', async () => {
    const wf = await build();
    const g: Graph = wf.input.workflow;
    const [lowSamplerId] = nodesOf(wf, 'SamplerCustomAdvanced').find(
      ([, n]) => g[n.inputs.latent_image[0]].class_type === 'MiniMaxH3ReferenceToVideo',
    )!;
    const [highSamplerId, highSampler] = nodesOf(wf, 'SamplerCustomAdvanced').find(
      ([, n]) => g[n.inputs.latent_image[0]].class_type === 'MiniMaxH3LatentUpscaleWithModel',
    )!;
    const [, lift] = one(wf, 'MiniMaxH3LatentUpscaleWithModel');
    expect(lift.inputs.samples).toEqual([lowSamplerId, 1]); // denoised_output
    expect(highSampler.inputs.noise[0]).not.toBe(g[lowSamplerId].inputs.noise[0]); // fresh noise
    expect(one(wf, 'VAEDecode')[1].inputs.samples).toEqual([highSamplerId, 0]);
    expect(one(wf, 'VAEDecodeAudio')[1].inputs.samples).toEqual([highSamplerId, 0]);
    // each guider is conditioned by its own resolution's encoder
    const encodeIds = nodesOf(wf, 'MiniMaxH3ReferenceToVideo').map(([id]) => id);
    const conds = nodesOf(wf, 'BasicGuider').map(([, n]) => n.inputs.conditioning[0]).sort();
    expect(conds).toEqual([...encodeIds].sort());
  });

  it('injects the workflow\'s required LoRA like the turbo recipe does (single LoRA node, no recipe special case)', async () => {
    const wf = await build();
    const loras = nodesOf(wf, 'LoraLoaderModelOnly');
    expect(loras).toHaveLength(1);
    // the required preset (here the turbo test preset) fills the template LoRA node
    expect(loras[0][1].inputs.lora_name).toBe(turboPreset.id);
    expect(loras[0][1].inputs.strength_model).toBe(1);
    expect(nodesOf(wf, 'MiniMaxH3SigmaShift')).toHaveLength(0);
  });

  it('injects no LoRA when the workflow has no required LoRA configured (a mis-configured row is not defended in code)', async () => {
    const wf = await build({ loraPresets: [], loraWeights: undefined });
    expect(nodesOf(wf, 'LoraLoaderModelOnly')).toHaveLength(0);
  });

  it('honours the configured strength of the required LoRA', async () => {
    const flexPreset = { ...turboPreset, id: 'pika_h3_flex_ref2va_v1_bf16.safetensors' };
    const wf = await build({ loraPresets: [flexPreset], loraWeights: { [flexPreset.id]: 0.8 } });
    const [, lora] = one(wf, 'LoraLoaderModelOnly');
    expect(lora.inputs).toMatchObject({ lora_name: flexPreset.id, strength_model: 0.8 });
  });

  it('adds one sage patch per stage, both chained off the Flex LoRA, only when asked', async () => {
    const wf = await build({ useSageAttention: true });
    const g: Graph = wf.input.workflow;
    const patches = nodesOf(wf, 'MiniMaxH3MemoryEfficientSageAttentionPatch');
    expect(patches).toHaveLength(2);
    const [loraId] = one(wf, 'LoraLoaderModelOnly');
    for (const [, p] of patches) expect(p.inputs.model[0]).toBe(loraId);
    for (const [, guider] of nodesOf(wf, 'BasicGuider')) {
      expect(g[guider.inputs.model[0]].class_type).toBe('MiniMaxH3MemoryEfficientSageAttentionPatch');
    }
    expect(guidersUseDifferentModels(wf)).toBe(true);

    const noSage = await build({ useSageAttention: false });
    expect(nodesOf(noSage, 'MiniMaxH3MemoryEfficientSageAttentionPatch')).toHaveLength(0);
  });

  it('keeps node weights positive and puts more of the sampling weight on the costlier stage', async () => {
    const wf = await build();
    const w = wf.input.node_weights as Record<string, number>;
    const ids = nodesOf(wf, 'SamplerCustomAdvanced').map(([id]) => id);
    for (const id of ids) expect(w[id]).toBeGreaterThan(0);
    expect(w[ids[0]] + w[ids[1]]).toBeCloseTo(60, 5);
  });

  it('is the plain single-stage Flex graph at 480p', async () => {
    const wf = await build({ videoResolution: '480p' });
    expect(nodesOf(wf, 'SamplerCustomAdvanced')).toHaveLength(1);
    expect(nodesOf(wf, 'MiniMaxH3LatentUpscaleWithModel')).toHaveLength(0);
    expect(nodesOf(wf, 'ManualSigmas')).toHaveLength(1);
    expect(one(wf, 'ManualSigmas')[1].inputs.sigmas).toBe('1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0');
  });

  it('keeps ESRGAN for the 720p option', async () => {
    const wf = await build({ videoResolution: '720p' });
    expect(nodesOf(wf, 'ImageUpscaleWithModel')).toHaveLength(1);
    expect(nodesOf(wf, 'MiniMaxH3LatentUpscaleWithModel')).toHaveLength(0);
  });
});

function guidersUseDifferentModels(wf: any): boolean {
  const models = nodesOf(wf, 'BasicGuider').map(([, n]) => n.inputs.model[0]);
  return new Set(models).size === models.length;
}

describe('ref2v 768p — scheduler recipe (turbo hybrid, 8 steps -> 6+2)', () => {
  const build = (extra: Record<string, unknown> = {}) =>
    buildRef2VWorkflow({
      ...r2vBase,
      videoResolution: '768p',
      iterationSteps: 8,
      workflow: { templatePath: 'data/minimax_ref2v_template.json.tmpl', engine: 'minimax' } as any,
      loraPresets: [turboPreset as any],
      loraWeights: { [turboPreset.id]: 1 },
      ...extra,
    }) as Promise<any>;

  it('splits an 8-step BasicScheduler with SplitSigmas at step 6', async () => {
    const wf = await build();
    const [splitId, split] = one(wf, 'SplitSigmas');
    expect(split.inputs.step).toBe(6);
    const [schedId, sched] = one(wf, 'BasicScheduler');
    expect(sched.inputs.steps).toBe(8);
    expect(split.inputs.sigmas).toEqual([schedId, 0]);
    const g: Graph = wf.input.workflow;
    const samplers = nodesOf(wf, 'SamplerCustomAdvanced').map(([, n]) => n.inputs.sigmas);
    expect(samplers).toContainEqual([splitId, 0]);
    expect(samplers).toContainEqual([splitId, 1]);
    expect(g[splitId].class_type).toBe('SplitSigmas');
    expect(one(wf, 'KSamplerSelect')[1].inputs.sampler_name).toBe('euler');
  });

  it('applies the turbo LoRA once and clones the sigma-shift + sage chain for stage 2', async () => {
    const wf = await build({ useSageAttention: true });
    const g: Graph = wf.input.workflow;
    expect(nodesOf(wf, 'LoraLoaderModelOnly')).toHaveLength(1);
    expect(nodesOf(wf, 'MiniMaxH3SigmaShift')).toHaveLength(2);
    expect(nodesOf(wf, 'MiniMaxH3MemoryEfficientSageAttentionPatch')).toHaveLength(2);
    const [loraId] = one(wf, 'LoraLoaderModelOnly');
    // every guider: shift -> sage -> lora
    for (const [, guider] of nodesOf(wf, 'BasicGuider')) {
      const shift = g[guider.inputs.model[0]];
      expect(shift.class_type).toBe('MiniMaxH3SigmaShift');
      const sage = g[shift.inputs.model[0]];
      expect(sage.class_type).toBe('MiniMaxH3MemoryEfficientSageAttentionPatch');
      expect(sage.inputs.model[0]).toBe(loraId);
    }
    expect(guidersUseDifferentModels(wf)).toBe(true);
  });

  it('only wires references into encoders that exist (no dangling links)', async () => {
    const wf = await build({ useSageAttention: true });
    const g: Graph = wf.input.workflow;
    for (const [id, n] of Object.entries(g)) {
      for (const [key, v] of Object.entries(n.inputs ?? {})) {
        if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number') {
          expect(g[v[0]], `${id}.${key} -> ${v[0]}`).toBeDefined();
        }
      }
    }
  });
});

describe('i2v/fl2v 768p (MiniMax builder)', () => {
  const build = (extra: Record<string, unknown> = {}) =>
    buildMiniMaxWorkflow({
      first_image_name: 'first.jpg',
      first_image_url: 'http://example.invalid/first.jpg',
      input_prompt: 'camera tilts up',
      seed: 7,
      videoDuration: 6,
      videoResolution: '768p',
      workflow: { templatePath: 'data/minimax_h3_flex.json.tmpl' } as any,
      ...extra,
    }) as Promise<any>;

  it('builds the portrait Flex fl2va 3+3 graph validated on the L40S (384x672 -> 768x1344)', async () => {
    const wf = await build({ useSageAttention: true });
    const encodes = nodesOf(wf, 'MiniMaxH3ImageToVideo');
    expect(encodes).toHaveLength(2);
    expect(encodes.map(([, n]) => `${n.inputs.width}x${n.inputs.height}`).sort()).toEqual(['384x672', '768x1344']);
    for (const [, n] of encodes) expect(n.inputs.first_frame).toBeDefined();
    expect(one(wf, 'MiniMaxH3LatentUpscaleWithModel')[1].inputs).toMatchObject({ width: 768, height: 1344 });
    expect(nodesOf(wf, 'MiniMaxH3MemoryEfficientSageAttentionPatch')).toHaveLength(2);
    expect(nodesOf(wf, 'ManualSigmas')).toHaveLength(2);
  });

  it('drops the last_frame input in i2v mode on both encoders', async () => {
    const wf = await build();
    for (const [, n] of nodesOf(wf, 'MiniMaxH3ImageToVideo')) {
      expect(n.inputs.last_frame).toBeUndefined();
    }
  });
});

describe('both official flavours x every resolution build a valid graph (turbo and Pika Flex rows side by side)', () => {
  const dangling = (wf: any) => {
    const g: Graph = wf.input.workflow;
    const bad: string[] = [];
    for (const [id, n] of Object.entries(g)) {
      for (const [key, v] of Object.entries((n as any).inputs ?? {})) {
        if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number' && !g[v[0]]) bad.push(`${id}.${key}->${v[0]}`);
      }
    }
    return bad;
  };
  const flexPresets = {
    r2v: { ...turboPreset, id: 'pika_h3_flex_ref2va_v1_bf16.safetensors' },
    i2v: { ...turboPreset, id: 'pika_h3_flex_fl2va_v1_bf16.safetensors' },
  };
  const rows = [
    { name: 'r2v turbo', kind: 'r2v', tmpl: 'data/minimax_ref2v_template.json.tmpl', preset: turboPreset, steps: 8 },
    { name: 'r2v flex', kind: 'r2v', tmpl: 'data/minimax_ref2v_flex.json.tmpl', preset: flexPresets.r2v, steps: 6 },
    { name: 'i2v/fl2v turbo', kind: 'i2v', tmpl: 'data/minimax_h3.json.tmpl', preset: turboPreset, steps: 8 },
    { name: 'i2v/fl2v flex', kind: 'i2v', tmpl: 'data/minimax_h3_flex.json.tmpl', preset: flexPresets.i2v, steps: 6 },
  ] as const;

  for (const row of rows) {
    for (const res of ['480p', '720p', '768p'] as const) {
      for (const sage of [false, true]) {
        it(`${row.name} @ ${res}${sage ? ' + sage' : ''}`, async () => {
          const common = {
            videoResolution: res,
            useSageAttention: sage,
            iterationSteps: row.steps as any,
            loraPresets: [row.preset as any],
            loraWeights: { [row.preset.id]: 1 },
            workflow: { templatePath: row.tmpl, engine: 'minimax' } as any,
          };
          const wf: any =
            row.kind === 'r2v'
              ? await buildRef2VWorkflow({ ...r2vBase, ...common })
              : await buildMiniMaxWorkflow({
                  first_image_name: 'first.jpg',
                  first_image_url: 'http://example.invalid/first.jpg',
                  input_prompt: 'x',
                  seed: 3,
                  videoDuration: 6,
                  ...common,
                });
          expect(dangling(wf)).toEqual([]);
          const samplers = nodesOf(wf, 'SamplerCustomAdvanced').length;
          expect(samplers).toBe(res === '768p' ? 2 : 1);
          expect(nodesOf(wf, 'MiniMaxH3LatentUpscaleWithModel')).toHaveLength(res === '768p' ? 1 : 0);
          expect(nodesOf(wf, 'ImageUpscaleWithModel')).toHaveLength(res === '720p' ? 1 : 0);
          // exactly one LoRA, the row's own preset
          const loras = nodesOf(wf, 'LoraLoaderModelOnly');
          expect(loras).toHaveLength(1);
          expect(loras[0][1].inputs.lora_name).toBe(row.preset.id);
          // sage: one patch per sampling stage, none without sage
          expect(nodesOf(wf, 'MiniMaxH3MemoryEfficientSageAttentionPatch')).toHaveLength(sage ? samplers : 0);
        });
      }
    }
  }
});

describe('style LoRAs reach the H3 graph (chained like the Wan builders do)', () => {
  const styleA = { id: 'styleA.safetensors', label: 'A', default: 1, min: 0, max: 1.5, step: 0.05, isConfigurable: true };
  const styleB = { id: 'styleB.safetensors', label: 'B', default: 1, min: 0, max: 1.5, step: 0.05, isConfigurable: true };
  const styleOff = { id: 'styleOff.safetensors', label: 'Off', default: 1, min: 0, max: 1.5, step: 0.05, isConfigurable: true };
  const flexR2v = { ...turboPreset, id: 'pika_h3_flex_ref2va_v1_bf16.safetensors' };

  // model chain feeding a guider, head first: [node classes/ids ...] down to the UNETLoader
  const walk = (wf: any, startRef: [string, number]) => {
    const g: Graph = wf.input.workflow;
    const out: string[] = [];
    let cur = startRef[0];
    while (g[cur]) {
      out.push(cur);
      const next = g[cur].inputs?.model;
      if (!Array.isArray(next)) break;
      cur = next[0];
    }
    return out;
  };

  const buildR2v = (tmpl: string, req: any, extra: Record<string, unknown> = {}) =>
    buildRef2VWorkflow({
      ...r2vBase,
      videoResolution: '480p',
      iterationSteps: 8,
      workflow: { templatePath: tmpl, engine: 'minimax' } as any,
      loraPresets: [req, styleA, styleB, styleOff] as any[],
      loraWeights: { [req.id]: 1, [styleA.id]: 0.7, [styleB.id]: 0.4 },
      ...extra,
    }) as Promise<any>;

  it('turbo recipe: required LoRA -> style A -> style B -> sage -> shift -> guider, strengths honoured, disabled one absent', async () => {
    const wf = await buildR2v('data/minimax_ref2v_template.json.tmpl', turboPreset, { useSageAttention: true });
    const g: Graph = wf.input.workflow;
    const names = nodesOf(wf, 'LoraLoaderModelOnly').map(([, n]) => n.inputs.lora_name).sort();
    expect(names).toEqual([styleA.id, styleB.id, turboPreset.id].sort());
    const [, guider] = one(wf, 'BasicGuider');
    const chain = walk(wf, guider.inputs.model).map((id) => g[id].class_type + (g[id].inputs?.lora_name ? ':' + g[id].inputs.lora_name : ''));
    expect(chain).toEqual([
      'MiniMaxH3SigmaShift',
      'MiniMaxH3MemoryEfficientSageAttentionPatch',
      'LoraLoaderModelOnly:styleB.safetensors',
      'LoraLoaderModelOnly:styleA.safetensors',
      'LoraLoaderModelOnly:' + turboPreset.id,
      'UNETLoader',
    ]);
    const strength = (name: string) => nodesOf(wf, 'LoraLoaderModelOnly').find(([, n]) => n.inputs.lora_name === name)![1].inputs.strength_model;
    expect(strength(styleA.id)).toBe(0.7);
    expect(strength(styleB.id)).toBe(0.4);
    expect(names).not.toContain(styleOff.id);
  });

  it('Flex recipe: the style LoRAs chain after the Flex LoRA that the template wires (no sigma shift there)', async () => {
    const wf = await buildR2v('data/minimax_ref2v_flex.json.tmpl', flexR2v, { useSageAttention: true });
    const g: Graph = wf.input.workflow;
    const [, guider] = one(wf, 'BasicGuider');
    const chain = walk(wf, guider.inputs.model).map((id) => g[id].class_type + (g[id].inputs?.lora_name ? ':' + g[id].inputs.lora_name : ''));
    expect(chain).toEqual([
      'MiniMaxH3MemoryEfficientSageAttentionPatch',
      'LoraLoaderModelOnly:styleB.safetensors',
      'LoraLoaderModelOnly:styleA.safetensors',
      'LoraLoaderModelOnly:' + flexR2v.id,
      'UNETLoader',
    ]);
  });

  it('768p: both stages sit on the same style LoRAs (they are upstream of the per-stage shift/sage clones)', async () => {
    const wf = await buildR2v('data/minimax_ref2v_template.json.tmpl', turboPreset, { videoResolution: '768p', useSageAttention: true });
    const g: Graph = wf.input.workflow;
    expect(nodesOf(wf, 'LoraLoaderModelOnly')).toHaveLength(3);
    const heads = nodesOf(wf, 'BasicGuider').map(([, gd]) => {
      const chain = walk(wf, gd.inputs.model);
      // drop the cloned shift/sage nodes, keep what is shared
      return chain.filter((id) => g[id].class_type === 'LoraLoaderModelOnly').join(',');
    });
    expect(new Set(heads).size).toBe(1);
  });

  it('i2v/fl2v builders chain them too, and nothing changes when no style LoRA is enabled', async () => {
    const build = (weights: Record<string, number>) =>
      buildMiniMaxWorkflow({
        first_image_name: 'first.jpg',
        first_image_url: 'http://example.invalid/first.jpg',
        input_prompt: 'x',
        seed: 1,
        videoDuration: 6,
        videoResolution: '480p',
        iterationSteps: 8,
        workflow: { templatePath: 'data/minimax_h3.json.tmpl', engine: 'minimax' } as any,
        loraPresets: [turboPreset, styleA] as any[],
        loraWeights: weights,
      }) as Promise<any>;
    const withStyle = await build({ [turboPreset.id]: 1, [styleA.id]: 0.5 });
    expect(nodesOf(withStyle, 'LoraLoaderModelOnly').map(([, n]) => n.inputs.lora_name).sort()).toEqual([styleA.id, turboPreset.id].sort());
    const without = await build({ [turboPreset.id]: 1 });
    expect(nodesOf(without, 'LoraLoaderModelOnly').map(([, n]) => n.inputs.lora_name)).toEqual([turboPreset.id]);
  });

  it('never leaves a dangling model link', async () => {
    for (const tmpl of ['data/minimax_ref2v_template.json.tmpl', 'data/minimax_ref2v_flex.json.tmpl']) {
      const wf = await buildR2v(tmpl, tmpl.includes('flex') ? flexR2v : turboPreset, { videoResolution: '768p', useSageAttention: true });
      const g: Graph = wf.input.workflow;
      for (const [id, n] of Object.entries(g)) {
        for (const [key, v] of Object.entries(n.inputs ?? {})) {
          if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number') expect(g[v[0]], `${id}.${key}`).toBeDefined();
        }
      }
    }
  });
});

describe('capabilities, quota rules and workers', () => {
  it('lets a workflow opt in to 768p and keeps the engine defaults unchanged', () => {
    expect(normalizeWorkflowCapabilities({ resolutions: ['480p', '720p', '768p', '1080p'] }).resolutions).toEqual([
      '480p',
      '720p',
      '768p',
    ]);
    expect(resolveCapabilities('minimax', {}).resolutions).toEqual(['480p', '720p']);
  });

  it('prices 768p with an exactResolution rule (x2 of the base cost)', () => {
    const rule = { id: '768p', label: '768p x2', multiplier: 2, when: { exactResolution: '768p' as const } };
    expect(isQuotaCostRule(rule)).toBe(true);
    const wf = { quotaCost: 2, quotaCostRules: [rule] };
    expect(computeWorkflowQuotaCost(wf, { videoResolution: '480p' })).toBe(2);
    expect(computeWorkflowQuotaCost(wf, { videoResolution: '720p' })).toBe(2);
    expect(computeWorkflowQuotaCost(wf, { videoResolution: '768p' })).toBe(4);
    expect(isQuotaCostRule({ ...rule, when: { exactResolution: '1080p' } })).toBe(false);
  });
});
