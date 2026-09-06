import fs from 'node:fs/promises';
import path from 'node:path';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * POST /api/admin/template-peek
 *
 * Admin helper for the workflow editor: verify that a workflow templatePath
 * points at a real file and that the file is a structurally valid workflow
 * template. Reads the file the exact same way the workflow builders do
 * (path.resolve from the server CWD), then:
 *   - confirms existence + readable size
 *   - extracts the {placeholder} tokens the template expects
 *   - proves it is valid JSON once placeholders are substituted with dummy
 *     values (templates put bare tokens like {seed} in numeric positions, so
 *     the raw file often won't parse — substitution mirrors what the builders
 *     do before JSON.parse)
 *   - detects the structure style ('api' wrapper vs raw node-map export)
 *   - reports the node class histogram + a best-effort engine guess
 *
 * Body: { templatePath: string }
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  // Authentication + admin role
  if (!locals.user) {
    throw error(401, 'Unauthorized');
  }
  if (!locals.user.roles?.includes('admin')) {
    throw error(403, 'Forbidden: Admin access required');
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const templatePath = String(body?.templatePath ?? '').trim();
  if (!templatePath) {
    throw error(400, 'templatePath is required');
  }

  const resolved = path.resolve(templatePath);
  const cwd = process.cwd();

  // Mirror the builders' resolution but keep reads inside the project root.
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw error(400, 'templatePath must resolve inside the project directory');
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!['.json', '.tmpl', '.txt'].includes(ext)) {
    throw error(400, `Unsupported template file type "${ext || '(none)'}"`);
  }

  // Existence + size
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return json({
      exists: false,
      path: resolved,
      error: `File not found: ${templatePath}`,
    });
  }
  if (!stat.isFile()) {
    return json({
      exists: false,
      path: resolved,
      error: `Not a file: ${templatePath}`,
    });
  }
  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB sanity cap
  if (stat.size > MAX_BYTES) {
    return json({
      exists: true,
      path: resolved,
      bytes: stat.size,
      error: `File is too large to preview (${stat.size} bytes)`,
    });
  }

  const content = await fs.readFile(resolved, 'utf8');

  // ---- Placeholder tokens the template expects -----------------------------
  const tokenRe = /\{([A-Za-z0-9_]+)\}/g;
  const placeholders = Array.from(new Set(
    [...content.matchAll(tokenRe)].map((m) => m[1])
  )).sort();

  // ---- Substitute placeholders so the template can be JSON.parsed ----------
  // Templates embed most tokens inside JSON strings but a few (e.g. {seed})
  // sit in bare numeric positions, so raw JSON.parse can fail. Replace each
  // token with a context-safe dummy: 'x' for name/url/prompt-ish tokens, '1'
  // for seed/numeric tokens. (Same idea the builders do before JSON.parse.)
  function dummyFor(token: string): string {
    if (/seed/i.test(token)) return '1';
    return 'x';
  }
  let substituted = content;
  for (const token of placeholders) {
    substituted = substituted.split(`{${token}}`).join(dummyFor(token));
  }

  let jsonValid = true;
  let parseError = '';
  let parsed: any = null;
  try {
    parsed = JSON.parse(substituted);
  } catch (err: any) {
    jsonValid = false;
    parseError = String(err?.message ?? err).slice(0, 500);
  }

  // Also attempt a parse of the raw content (reports whether it's valid as-is).
  let rawValid = true;
  try {
    JSON.parse(content);
  } catch {
    rawValid = false;
  }

  // ---- Structure + node histogram ------------------------------------------
  let style: 'api' | 'raw' | 'none' = 'none';
  let workflowMap: Record<string, any> | null = null;
  if (parsed && typeof parsed === 'object') {
    const looksNode = (obj: any) =>
      obj && typeof obj === 'object' &&
      Object.values(obj).some(
        (n: any) => n && typeof n === 'object' && typeof n.class_type === 'string',
      );
    if (parsed.input && typeof parsed.input === 'object' && looksNode(parsed.input.workflow)) {
      style = 'api';
      workflowMap = parsed.input.workflow;
    } else if (looksNode(parsed)) {
      style = 'raw';
      workflowMap = parsed;
    }
  }

  const classCounts = new Map<string, number>();
  if (workflowMap) {
    for (const node of Object.values(workflowMap) as any[]) {
      const ct = node?.class_type;
      if (typeof ct === 'string') classCounts.set(ct, (classCounts.get(ct) ?? 0) + 1);
    }
  }
  const classes = Array.from(classCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  // Engine guess from node types present (useful to catch a template wired to
  // the wrong engine).
  const allTypes = classes.map((c) => c.type);
  let engineGuess: 'minimax' | 'wan' | 'unknown' = 'unknown';
  if (allTypes.some((t) => /^MiniMax/i.test(t))) engineGuess = 'minimax';
  else if (allTypes.some((t) => /^Wan/i.test(t))) engineGuess = 'wan';

  // ---- Loader references: which model/VAE/CLIP/LoRA files the template loads
  // Maps each loader class to the input key holding its filename(s). This is
  // how an admin verifies the template actually points at the intended base
  // model (e.g. after a pruned -> unpruned rename) without opening the raw JSON.
  const LOADER_KEYS: Record<string, { key: string; kind: string }> = {
    UNETLoader: { key: 'unet_name', kind: 'diffusion' },
    UnetLoaderGGUF: { key: 'unet_name', kind: 'diffusion' },
    UNETLoaderMultiGPU: { key: 'unet_name', kind: 'diffusion' },
    CheckpointLoaderSimple: { key: 'ckpt_name', kind: 'checkpoint' },
    VAELoader: { key: 'vae_name', kind: 'vae' },
    CLIPLoader: { key: 'clip_name', kind: 'clip' },
    LoraLoaderModelOnly: { key: 'lora_name', kind: 'lora' },
    LoraLoader: { key: 'lora_name', kind: 'lora' },
    ControlNetLoader: { key: 'control_net_name', kind: 'controlnet' },
    UpscaleModelLoader: { key: 'model_name', kind: 'upscale' },
  };
  const modelRefs: { kind: string; class: string; file: string }[] = [];
  if (workflowMap) {
    for (const [nodeId, node] of Object.entries(workflowMap) as [string, any][]) {
      const def = LOADER_KEYS[node?.class_type];
      if (!def || !node?.inputs) continue;
      const raw = node.inputs[def.key];
      const files = Array.isArray(raw) ? raw.filter((x: any) => typeof x === 'string') : typeof raw === 'string' ? [raw] : [];
      for (const file of files) {
        if (file) modelRefs.push({ kind: def.kind, class: node.class_type, file });
      }
    }
  }
  // Deduplicate (e.g. same VAE used by several nodes).
  const uniqueModelRefs = Array.from(
    new Map(modelRefs.map((r) => [`${r.kind}\u0000${r.file}`, r])).values(),
  );
  const baseModelNames = uniqueModelRefs
    .filter((r) => r.kind === 'diffusion' || r.kind === 'checkpoint')
    .map((r) => r.file);

  // Sentinel node-type checks that a workflow template normally needs.
  const ENCODER_TYPES = [
    'WanImageToVideo',
    'WanFirstLastFrameToVideo',
    'MiniMaxH3ImageToVideo',
    'MiniMaxH3ReferenceToVideo',
  ];
  const SAMPLER_TYPES = ['WanMoeKSampler', 'SamplerCustomAdvanced', 'KSampler'];
  const DECODE_TYPES = ['VAEDecode', 'VAEDecodeAudio'];
  const COMBINE_TYPES = ['VHS_VideoCombine', 'CreateVideo'];
  const hasType = (set: string[]) => allTypes.some((t) => set.includes(t));
  const checks = {
    encoder: hasType(ENCODER_TYPES),
    sampler: hasType(SAMPLER_TYPES),
    decoder: hasType(DECODE_TYPES),
    videoOutput: hasType(COMBINE_TYPES),
  };

  return json({
    exists: true,
    path: resolved,
    bytes: stat.size,
    // Preview (pretty JSON when parseable, else a truncated excerpt).
    preview:
      parsed && typeof parsed === 'object'
        ? JSON.stringify(parsed, null, 2)
        : content.slice(0, 20000),
    jsonValid,
    rawValid,
    parseError,
    style,
    placeholders,
    nodeCount: workflowMap ? Object.keys(workflowMap).length : 0,
    classes,
    engineGuess,
    checks,
    modelRefs: uniqueModelRefs,
    baseModelNames,
  });
};
