/**
 * LoRA Preset model
 * 
 * Conceptually (for your setup):
 * - presetGroup = MODEL FAMILY / your 2-3 main presets. This is the PRIMARY grouping.
 *   Fully free-form and configurable: you can name them whatever you want, e.g.
 *   "wan22", "dasiwa-v1", "dasiwa-v2" or "my-model-1". No hard-coded list.
 *   Used for UI grouping AND for auto-compatibility (group == group).
 * 
 * - tags = OPTIONAL secondary refinement inside a group.
 *   e.g. "nsfw", "concept", "camera". You can ignore tags entirely if you only have 2-3 groups.
 *   Used for finer filtering / optional extra auto-match.
 */
export type LoraPreset = {
  id: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  chain?: 'high' | 'low';
  isConfigurable?: boolean; // if false: required LoRA (e.g. lightx2v on base wan22) — cannot be disabled in UI
  enabled?: boolean; // legacy: use defaultEnabled
  defaultEnabled?: boolean; // "default on" — whether checked by default in review page
  presetGroup?: string; // model family — free-form, fully configurable
  tags?: string[]; // optional style — free-form
  autoAddToWorkflows?: boolean;
  steps?: number; // target sampler steps when this LoRA is applied (e.g. speed-up LoRAs: 8 instead of 20)
};

// Suggestions only - not enforced. User can type any name. You mentioned 2-3 presets like wan22 / dasiwa-old / dasiwa-new - use whatever you want.
export const PRESET_GROUPS: string[] = []; // intentionally empty - fully configurable, derived from DB + user input
export type PresetGroup = string; // free-form

// Optional style tags - also fully free-form, these are just quick suggestions
export const COMMON_LORA_TAGS = ['nsfw', 'realistic', 'anime', 'arcshot', 'lightx2v', 'custom'] as const;

export const DEFAULT_LORA_PRESETS: LoraPreset[] = [
  // LightX2V is REQUIRED for base wan22 (distilled models like Dasiwa don't need it)
  // Group = wan22 so it only auto-applies to wan22 workflows, isConfigurable=false forces it ON
  { id: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', label: 'Light X2V (High Noise)', default: 0.4, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: false, defaultEnabled: true, tags: ['lightx2v'], presetGroup: 'wan22', autoAddToWorkflows: false },
  { id: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', label: 'Light X2V (Low Noise)', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'low', isConfigurable: false, defaultEnabled: true, tags: ['lightx2v'], presetGroup: 'wan22', autoAddToWorkflows: false },
  { id: 'wan22-video10-arcshot-16-sel-7-high.safetensors', label: 'Arcshot High', default: 0.8, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: true, tags: ['realistic'], presetGroup: 'wan22', autoAddToWorkflows: false },
  { id: 'DR34ML4Y_I2V_14B_HIGH.safetensors', label: 'DR34ML4Y High', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: true, tags: ['realistic'], presetGroup: 'wan22', autoAddToWorkflows: false },
  { id: 'NSFW-22-H-e8.safetensors', label: 'NSFW-22 High', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: true, tags: ['nsfw'], presetGroup: 'wan22', autoAddToWorkflows: false },
  { id: 'DR34ML4Y_I2V_14B_LOW.safetensors', label: 'DR34ML4Y Low', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'low', isConfigurable: true, tags: ['realistic'], presetGroup: 'wan22', autoAddToWorkflows: false },
  { id: 'NSFW-22-L-e8.safetensors', label: 'NSFW-22 Low', default: 0.8, min: 0, max: 1.5, step: 0.05, chain: 'low', isConfigurable: true, tags: ['nsfw'], presetGroup: 'wan22', autoAddToWorkflows: false },
];

export function normalizeLoraPresets(list?: LoraPreset[]): LoraPreset[] {
  if (!Array.isArray(list)) return DEFAULT_LORA_PRESETS;
  return list
    .filter((item) => item && item.id)
    .map((item) => ({
      ...item,
      label: item.label || item.id,
      default: typeof item.default === 'number' ? item.default : 1,
      min: typeof item.min === 'number' ? item.min : 0,
      max: typeof item.max === 'number' ? item.max : 1.5,
      step: typeof item.step === 'number' ? item.step : 0.05,
      chain: (item.chain === 'low' ? 'low' : 'high') as 'high' | 'low',
      isConfigurable: typeof (item as any).isConfigurable === 'boolean' ? (item as any).isConfigurable : true,
      enabled: typeof (item as any).enabled === 'boolean' ? (item as any).enabled : true,
      defaultEnabled: typeof (item as any).defaultEnabled === 'boolean' ? (item as any).defaultEnabled : (typeof (item as any).enabled === 'boolean' ? (item as any).enabled : true),
      presetGroup: typeof item.presetGroup === 'string' && item.presetGroup.trim() ? item.presetGroup.trim() : 'Custom',
      tags: Array.isArray(item.tags) ? item.tags.map((t: string) => String(t).toLowerCase().trim()).filter(Boolean) : [],
      autoAddToWorkflows: typeof item.autoAddToWorkflows === 'boolean' ? item.autoAddToWorkflows : false,
      steps: typeof (item as any).steps === 'number' && (item as any).steps >= 1 ? (item as any).steps : undefined,
    }));
}

export function doesLoraMatchWorkflow(lora: LoraPreset, workflow: { tags?: string[]; presetGroup?: string }): boolean {
  if ((lora as any).autoAddToWorkflows) return true;
  // Primary: group must match if both sides have a group defined
  if (lora.presetGroup && workflow.presetGroup) {
    if (lora.presetGroup.toLowerCase() !== workflow.presetGroup.toLowerCase()) return false;
  }
  // Secondary: if both have tags, require at least one overlap (tags are refinement)
  if (lora.tags?.length && workflow.tags?.length) {
    return lora.tags.some(t => workflow.tags!.map(x=>x.toLowerCase()).includes(t.toLowerCase()));
  }
  // If group matched (or one side has no group), allow
  return true;
}

/** Suggest compatible LoRAs for a new workflow based on its group/tags - i2v/fl2v agnostic */
export function suggestLorasForWorkflow(allPresets: LoraPreset[], workflow: { tags?: string[]; presetGroup?: string }): LoraPreset[] {
  return allPresets.filter(p => {
    if (p.autoAddToWorkflows) return true;
    if (p.presetGroup && workflow.presetGroup) {
      if (p.presetGroup.toLowerCase() !== workflow.presetGroup.toLowerCase()) return false;
      if (p.tags?.length && workflow.tags?.length) {
        return p.tags.some(tag => workflow.tags!.map(x=>x.toLowerCase()).includes(tag.toLowerCase()));
      }
      return true;
    }
    if (p.tags?.length && workflow.tags?.length) {
      return p.tags.some(tag => workflow.tags!.map(x=>x.toLowerCase()).includes(tag.toLowerCase()));
    }
    return false;
  });
}
