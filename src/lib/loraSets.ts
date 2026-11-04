/**
 * LoRA sets: named, reusable groups of LoRA ids (and other sets).
 *
 * A workflow's `compatibleLoraIds` may contain plain LoRA ids plus set
 * references of the form `set:<name>`. Only the `set:` prefix is treated as
 * a set; everything else is a LoRA id. Sets live in
 * `admin_settings.lora_sets` (see `normalizeLoraSets`) and are expanded at
 * read time — the workflow row keeps the `set:` refs, never the expansion.
 */

export const LORA_SET_PREFIX = 'set:';
export const LORA_SET_MAX_DEPTH = 10;
export const LORA_SET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export type LoraSets = Record<string, string[]>;

export function isLoraSetRef(id: unknown): boolean {
  return typeof id === 'string' && (id as string).startsWith(LORA_SET_PREFIX) && (id as string).length > LORA_SET_PREFIX.length;
}

export function setNameFromRef(ref: string): string {
  return ref.slice(LORA_SET_PREFIX.length);
}

export function isValidLoraSetName(name: unknown): boolean {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64 && LORA_SET_NAME_RE.test(name);
}

/** Normalize raw DB/JSON input into a clean name -> id-list map. */
export function normalizeLoraSets(raw: unknown): LoraSets {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: LoraSets = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidLoraSetName(k)) continue;
    if (!Array.isArray(v)) continue;
    const ids = (v as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
      .filter((x) => x.length <= 255);
    out[k] = ids;
  }
  return out;
}

/**
 * Expand a mixed list of LoRA ids + `set:` refs into a flat LoRA id list.
 * - Order: first occurrence wins, kept as written (never sorted). It does not affect inference or the list users see:
 *   the chain order and that list follow the LoRA preset list; a set only decides WHICH LoRAs are available.
 * - Nested sets recurse; cycles are skipped via the active path set.
 * - Depth is capped at LORA_SET_MAX_DEPTH; unknown sets expand to nothing.
 * - Returned list never contains `set:` refs.
 */
export function expandLoraIds(ids: readonly string[] | undefined | null, sets: LoraSets | undefined | null): string[] {
  const src = Array.isArray(ids) ? ids : [];
  const table = sets && typeof sets === 'object' ? sets : {};
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (list: readonly string[], path: string[], depth: number) => {
    if (depth > LORA_SET_MAX_DEPTH) return;
    for (const item of list) {
      if (typeof item !== 'string' || item.length === 0) continue;
      if (isLoraSetRef(item)) {
        const name = setNameFromRef(item);
        if (path.includes(name)) continue; // cycle: A contains B contains A
        const inner = table[name];
        if (!Array.isArray(inner)) continue; // unknown set -> nothing
        visit(inner, [...path, name], depth + 1);
      } else {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
      }
    }
  };
  visit(src, [], 0);
  return out;
}

/** Expanded effective LoRA ids for a workflow row. */
export function resolveWorkflowLoraIds(
  compatibleLoraIds: readonly string[] | undefined | null,
  sets: LoraSets | undefined | null,
): string[] {
  return expandLoraIds(compatibleLoraIds, sets);
}

/** Which defined sets reference a given set (directly), for rename/delete warnings. */
export function findDirectSetReferrers(sets: LoraSets, targetName: string): string[] {
  const want = `${LORA_SET_PREFIX}${targetName}`;
  return Object.entries(sets)
    .filter(([, v]) => Array.isArray(v) && (v as string[]).includes(want))
    .map(([k]) => k);
}

/** Which workflows reference a given set (directly in compatibleLoraIds). */
export function findWorkflowSetUsages(
  workflows: ReadonlyArray<{ id: string; compatibleLoraIds?: readonly string[] | null }>,
  targetName: string,
): string[] {
  const want = `${LORA_SET_PREFIX}${targetName}`;
  return workflows
    .filter((w) => Array.isArray(w.compatibleLoraIds) && (w.compatibleLoraIds as readonly string[]).includes(want))
    .map((w) => w.id);
}
