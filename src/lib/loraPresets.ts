export type LoraPreset = {
  id: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  chain?: 'high' | 'low'; // which model chain this LoRA belongs to
  isConfigurable?: boolean; // false for base LoRAs that must always be present
  enabled?: boolean; // whether this LoRA is enabled by default (for review page)
};

export const DEFAULT_LORA_PRESETS: LoraPreset[] = [
  { id: 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors', label: 'Light X2V (High Noise)', default: 0.4, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: false },
  { id: 'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors', label: 'Light X2V (Low Noise)', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'low', isConfigurable: false },
  { id: 'wan22-video10-arcshot-16-sel-7-high.safetensors', label: 'Arcshot High', default: 0.8, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: true },
  { id: 'DR34ML4Y_I2V_14B_HIGH.safetensors', label: 'DR34ML4Y High', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: true },
  { id: 'NSFW-22-H-e8.safetensors', label: 'NSFW-22 High', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'high', isConfigurable: true },
  { id: 'DR34ML4Y_I2V_14B_LOW.safetensors', label: 'DR34ML4Y Low', default: 1, min: 0, max: 1.5, step: 0.05, chain: 'low', isConfigurable: true },
  { id: 'NSFW-22-L-e8.safetensors', label: 'NSFW-22 Low', default: 0.8, min: 0, max: 1.5, step: 0.05, chain: 'low', isConfigurable: true },
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
      chain: item.chain || 'high',
      isConfigurable: item.isConfigurable !== false,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
    }));
}
