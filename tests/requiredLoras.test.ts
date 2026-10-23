import { describe, expect, it } from 'vitest';
import { withRequiredLoras } from '../src/lib/workflows';
import type { Workflow } from '../src/lib/IDatabase';

const presets = [
  { id: 'speedup.safetensors', default: 1, isConfigurable: false },
  { id: 'other-workflow-speedup.safetensors', default: 1, isConfigurable: false },
  { id: 'style.safetensors', default: 0.8, isConfigurable: true },
];
const wf = { compatibleLoraIds: ['speedup.safetensors', 'style.safetensors'] } as unknown as Workflow;

describe('withRequiredLoras', () => {
  it('adds a compatible required LoRA that the client omitted', () => {
    expect(withRequiredLoras(undefined, wf, presets)).toEqual({ 'speedup.safetensors': 1 });
    expect(withRequiredLoras({ 'style.safetensors': 0.5 }, wf, presets)).toEqual({
      'style.safetensors': 0.5,
      'speedup.safetensors': 1,
    });
  });

  it('resets a client-supplied weight of a required LoRA to its default (e.g. 0 cannot disable it)', () => {
    expect(withRequiredLoras({ 'speedup.safetensors': 0 }, wf, presets)).toEqual({ 'speedup.safetensors': 1 });
  });

  it('never adds LoRAs of other workflows, and leaves optional ones alone', () => {
    const out = withRequiredLoras({}, wf, presets)!;
    expect(out).not.toHaveProperty('other-workflow-speedup.safetensors');
    expect(out).not.toHaveProperty('style.safetensors');
  });

  it('returns the input unchanged when the workflow has no required LoRA', () => {
    const none = { compatibleLoraIds: ['style.safetensors'] } as unknown as Workflow;
    expect(withRequiredLoras(undefined, none, presets)).toBeUndefined();
    const w = { 'style.safetensors': 0.3 };
    expect(withRequiredLoras(w, none, presets)).toBe(w);
  });
});
