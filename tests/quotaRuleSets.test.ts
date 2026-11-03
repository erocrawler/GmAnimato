import { describe, expect, it } from 'vitest';
import { computeWorkflowQuotaCost } from '../src/lib/quotaCost';
import {
  expandQuotaCostRules,
  isQuotaRuleSetRef,
  isValidQuotaRuleSetName,
  normalizeQuotaRuleSets,
} from '../src/lib/quotaRuleSets';

describe('quotaRuleSets', () => {
  it('recognizes only ruleset: refs', () => {
    expect(isQuotaRuleSetRef('ruleset:h3-768p')).toBe(true);
    expect(isQuotaRuleSetRef('ruleset:')).toBe(false);
    expect(isQuotaRuleSetRef('set:h3')).toBe(false);
    expect(isQuotaRuleSetRef(42 as any)).toBe(false);
  });

  it('validates set names', () => {
    expect(isValidQuotaRuleSetName('h3-768p')).toBe(true);
    expect(isValidQuotaRuleSetName('WAN_full')).toBe(true);
    expect(isValidQuotaRuleSetName('ruleset:x')).toBe(false);
    expect(isValidQuotaRuleSetName('')).toBe(false);
    expect(isValidQuotaRuleSetName('a b')).toBe(false);
  });

  it('normalizes raw sets, dropping invalid names and rules', () => {
    expect(normalizeQuotaRuleSets(null)).toEqual({});
    expect(
      normalizeQuotaRuleSets({
        'h3-768p': [{ id: 'res-768p', multiplier: 2, when: { exactResolution: '768p' } }, { id: 'bad' }],
        'bad name!': [{ id: 'x', multiplier: 2, when: {} }],
      }),
    ).toEqual({
      'h3-768p': [{ id: 'res-768p', multiplier: 2, label: undefined, additive: undefined, when: { minDuration: undefined, exactResolution: '768p', usingLoras: undefined } }],
    });
  });

  it('expands refs preserving order, dedupes by id, skips unknown/cycles', () => {
    const lib = {
      base: [{ id: 'a', multiplier: 2, when: {} } as any],
      mid: ['ruleset:base', { id: 'b', multiplier: 3, when: {} } as any],
    };
    expect(expandQuotaCostRules(['ruleset:mid', { id: 'a', multiplier: 2, when: {} } as any, { id: 'c', additive: 1, when: {} } as any], lib).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(expandQuotaCostRules(['ruleset:nope', { id: 'z', multiplier: 2, when: {} } as any], lib).map((r) => r.id)).toEqual(['z']);
    const cyc = { a: ['ruleset:b'] as any, b: ['ruleset:a', { id: 'x', multiplier: 2, when: {} } as any] };
    expect(expandQuotaCostRules(['ruleset:a'], cyc).map((r) => r.id)).toEqual(['x']);
  });

  it('compute uses library: same math as inline', () => {
    const inline = { quotaCost: 2, quotaCostRules: [{ id: 'res-768p', multiplier: 2, when: { exactResolution: '768p' } }] as any };
    const viaRef = { quotaCost: 2, quotaCostRules: ['ruleset:h3-768p'] as any };
    const lib = { 'h3-768p': [{ id: 'res-768p', multiplier: 2, when: { exactResolution: '768p' } } as any] };
    expect(computeWorkflowQuotaCost(viaRef, { videoResolution: '768p' }, lib)).toBe(
      computeWorkflowQuotaCost(inline, { videoResolution: '768p' }),
    );
    expect(computeWorkflowQuotaCost(viaRef, { videoResolution: '768p' }, lib)).toBe(4);
    expect(computeWorkflowQuotaCost(viaRef, { videoResolution: '480p' }, lib)).toBe(2);
    expect(computeWorkflowQuotaCost(viaRef, { videoResolution: '768p' }, {})).toBe(2);
  });

  it('hasRefVideo matches only when specified', () => {
    const wTrue = { quotaCost: 1, quotaCostRules: [{ id: 'rv', additive: 1, when: { hasRefVideo: true } }] as any };
    expect(computeWorkflowQuotaCost(wTrue, { hasRefVideo: true })).toBe(2);
    expect(computeWorkflowQuotaCost(wTrue, { hasRefVideo: false })).toBe(1);
    expect(computeWorkflowQuotaCost(wTrue, {})).toBe(1);
    const wFalse = { quotaCost: 1, quotaCostRules: [{ id: 'nrv', additive: 1, when: { hasRefVideo: false } }] as any };
    expect(computeWorkflowQuotaCost(wFalse, { hasRefVideo: false })).toBe(2);
    expect(computeWorkflowQuotaCost(wFalse, { hasRefVideo: true })).toBe(1);
    expect(computeWorkflowQuotaCost(wFalse, {})).toBe(1);
  });

  it('additives join the base before the multipliers: (base + video) x resolution x length', () => {
    const rules = [
      { id: 'video', additive: 1, when: { hasRefVideo: true } },
      { id: 'res', multiplier: 2, when: { exactResolution: '768p' } },
      { id: 'len', multiplier: 1.5, when: { minDuration: 6 } },
    ] as any;
    const w = { quotaCost: 1, quotaCostRules: rules };
    const p = { videoResolution: '768p', videoDuration: 6 } as any;
    expect(computeWorkflowQuotaCost(w, { ...p, hasRefVideo: true })).toBe(6); // (1 + 1) x 2 x 1.5
    expect(computeWorkflowQuotaCost(w, { ...p, hasRefVideo: false })).toBe(3); // 1 x 2 x 1.5
    expect(computeWorkflowQuotaCost({ quotaCost: 2, quotaCostRules: rules }, { ...p, hasRefVideo: true })).toBe(9); // (2 + 1) x 3
    // rule order does not matter
    expect(computeWorkflowQuotaCost({ quotaCost: 1, quotaCostRules: [...rules].reverse() }, { ...p, hasRefVideo: true })).toBe(6);
    // never below 1, rounded once at the end
    expect(computeWorkflowQuotaCost({ quotaCost: 1, quotaCostRules: [{ id: 'd', additive: -1, when: {} }] as any }, {})).toBe(1);
    expect(computeWorkflowQuotaCost({ quotaCost: 1, quotaCostRules: [{ id: 'm', multiplier: 1.25, when: {} }, { id: 'a', additive: 1, when: {} }] as any }, {})).toBe(3); // 2 x 1.25 = 2.5 -> 3
  });
});
