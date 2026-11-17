/**
 * Whitelisted fps / scale values for the converted-download endpoint. Every distinct
 * (format, fps, scale) is a separate cache entry and a separate ffmpeg run, so free-form
 * values would let anyone multiply CPU work and disk usage at will.
 */
export const FPS_PRESETS = [8, 10, 12, 15, 24] as const;
export const SCALE_PRESETS = [320, 480, 640, 720, 960] as const;

export type ParamResult = { ok: true; value: number } | { ok: false; error: string };

function parsePreset(raw: string | null, allowed: readonly number[], def: number, name: string): ParamResult {
  if (raw === null || raw === '') return { ok: true, value: def };
  const n = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!allowed.includes(n)) {
    return { ok: false, error: `${name} must be one of: ${allowed.join(', ')}` };
  }
  return { ok: true, value: n };
}

export function parseFps(raw: string | null, def: number): ParamResult {
  return parsePreset(raw, FPS_PRESETS, def, 'fps');
}
export function parseScale(raw: string | null, def: number): ParamResult {
  return parsePreset(raw, SCALE_PRESETS, def, 'scale');
}
