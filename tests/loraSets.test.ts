import { describe, expect, it } from 'vitest';
import {
  expandLoraIds,
  isLoraSetRef,
  isValidLoraSetName,
  normalizeLoraSets,
  resolveWorkflowLoraIds,
} from '../src/lib/loraSets';

describe('loraSets', () => {
  it('recognizes only set: refs', () => {
    expect(isLoraSetRef('set:wan-mid')).toBe(true);
    expect(isLoraSetRef('set:')).toBe(false);
    expect(isLoraSetRef('wan.safetensors')).toBe(false);
    expect(isLoraSetRef(42 as any)).toBe(false);
  });

  it('validates set names', () => {
    expect(isValidLoraSetName('wan-mid')).toBe(true);
    expect(isValidLoraSetName('h3_full')).toBe(true);
    expect(isValidLoraSetName('set:x')).toBe(false);
    expect(isValidLoraSetName('')).toBe(false);
    expect(isValidLoraSetName('a b')).toBe(false);
  });

  it('normalizes raw sets', () => {
    expect(normalizeLoraSets(null)).toEqual({});
    expect(normalizeLoraSets({ 'wan-mid': ['a', 'set:b', 42, ''], 'bad name!': ['x'] })).toEqual({
      'wan-mid': ['a', 'set:b'],
    });
  });

  it('expands nested sets preserving first-occurrence order', () => {
    const sets = { base: ['a', 'b'], mid: ['set:base', 'c', 'a'] };
    expect(expandLoraIds(['set:mid', 'd', 'b'], sets)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips cycles and unknown sets', () => {
    const sets = { a: ['set:b', 'x'], b: ['set:a', 'y'] };
    expect(expandLoraIds(['set:a'], sets)).toEqual(['y', 'x']);
    expect(expandLoraIds(['set:nope', 'z'], sets)).toEqual(['z']);
  });

  it('resolveWorkflowLoraIds never returns set: refs', () => {
    expect(resolveWorkflowLoraIds(['set:a', 'm.safetensors'], { a: ['set:b'] })).toEqual(['m.safetensors']);
  });
});
