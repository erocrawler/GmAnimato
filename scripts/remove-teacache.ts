#!/usr/bin/env tsx
/**
 * remove-teacache.ts — strip TeaCache nodes from ComfyUI workflow templates.
 *
 * TeaCache is not supported in newer ComfyUI versions. This script rewires any
 * template that references the TeaCache class so the sampler's model inputs
 * point directly at the underlying model source (UNet/LoRA loader), then deletes
 * the TeaCache nodes. It also drops the matching entries from node_weights.
 *
 * Templates are git-ignored (data/*.tmpl), so this is intended to be copied to
 * the server and run there against whatever templates exist in the deployment's
 * data dir (the DB's workflow.templatePath points at these files).
 *
 * Usage (from repo root):
 *   node_modules\.bin\tsx.cmd scripts/remove-teacache.ts [file1.tmpl ...]
 *   # no args → processes every data/*.tmpl
 *
 * Options:
 *   --backup   write <file>.bak before modifying (default: off)
 *
 * Idempotent: templates with no TeaCache nodes are left untouched.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Bare {seed} is the only placeholder that appears as a raw JSON value in our
// templates (everything else is inside a quoted string). Substitute it with a
// sentinel number so the file parses, then restore it after serializing.
const SEED_SENTINEL = 9127356481; // prime-ish, won't collide with real values

function walkInputs(obj: unknown, visit: (val: unknown) => void): void {
  if (Array.isArray(obj)) {
    visit(obj);
    for (const item of obj) walkInputs(item, visit);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) walkInputs(v, visit);
  }
}

/**
 * Remove TeaCache nodes from one template. Returns { removed: number, rewired: number }.
 * Throws if the file cannot be parsed.
 */
function removeTeaCache(filePath: string): { removed: number; rewired: number } {
  let text = readFileSync(filePath, 'utf-8');

  // Make the template parseable: swap bare {seed} for a number sentinel.
  const hadSeed = text.includes('{seed}');
  if (hadSeed) text = text.replace(/\{seed\}/g, String(SEED_SENTINEL));

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${filePath}: not valid JSON after {seed} substitution — ${err.message}`);
  }

  const workflow = parsed?.input?.workflow;
  if (!workflow || typeof workflow !== 'object') {
    throw new Error(`${filePath}: missing input.workflow — is this a workflow template?`);
  }

  // 1. Find TeaCache nodes (by id).
  const teaIds = Object.entries(workflow)
    .filter(([, n]: any) => n?.class_type === 'TeaCache')
    .map(([id]) => id);

  if (teaIds.length === 0) {
    return { removed: 0, rewired: 0 }; // nothing to do (idempotent)
  }

  // 2. Build source map: TeaCache id -> its inputs.model source (e.g. ["67", 0]).
  const sourceByTea = new Map<string, unknown>();
  for (const id of teaIds) {
    const src = workflow[id]?.inputs?.model;
    if (!Array.isArray(src) || src.length < 1) {
      throw new Error(`${filePath}: TeaCache node "${id}" has no inputs.model to bypass`);
    }
    sourceByTea.set(id, src);
  }

  // 3. Rewire every reference [teaId, 0] -> its source, across ALL node inputs
  //    (covers sampler model_high_noise / model_low_noise and any other input).
  //    Loops to resolve chained TeaCache (TeaCache -> TeaCache -> loader) in
  //    dependency order; each pass replaces one level.
  let rewired = 0;
  for (let pass = 0; pass < 10; pass++) {
    let changedInPass = false;
    for (const [nodeId, node] of Object.entries(workflow) as any[]) {
      if (teaIds.includes(nodeId)) continue; // don't rewire the TeaCache nodes themselves
      walkInputs(node?.inputs, (val) => {
        if (
          Array.isArray(val) &&
          typeof val[0] === 'string' &&
          sourceByTea.has(val[0]) &&
          (val[1] === 0 || val[1] === undefined)
        ) {
          const src = sourceByTea.get(val[0])!;
          val[0] = (src as any[])[0];
          val[1] = (src as any[])[1];
          rewired++;
          changedInPass = true;
        }
      });
    }
    if (!changedInPass) break;
  }

  // 4. Delete TeaCache nodes + their node_weights entries.
  for (const id of teaIds) delete workflow[id];
  if (parsed?.input?.node_weights) {
    for (const id of teaIds) delete parsed.input.node_weights[id];
  }

  // 5. Serialize and restore the seed placeholder.
  let out = JSON.stringify(parsed, null, 2) + '\n';
  if (hadSeed) out = out.replace(new RegExp(String(SEED_SENTINEL), 'g'), '{seed}');

  writeFileSync(filePath, out);
  return { removed: teaIds.length, rewired };
}

function main(): void {
  const args = process.argv.slice(2);
  const wantBackup = args.includes('--backup');
  const files = args.filter((a) => !a.startsWith('--'));

  const targets = files.length > 0
    ? files
    : (existsSync('data') ? readDirTmpl('data') : []);

  if (targets.length === 0) {
    console.error('No templates found. Pass file paths or run from a dir containing data/*.tmpl');
    process.exit(2);
  }

  let failed = 0;
  for (const f of targets) {
    const abs = path.isAbsolute(f) ? f : path.resolve(f);
    try {
      const { removed, rewired } = removeTeaCache(abs);
      if (removed > 0) {
        if (wantBackup) writeFileSync(`${abs}.bak`, readFileSync(abs, 'utf-8'));
        console.log(`✓ ${f}: removed ${removed} TeaCache node(s), rewired ${rewired} reference(s)`);
      } else {
        console.log(`• ${f}: no TeaCache (unchanged)`);
      }
    } catch (err: any) {
      failed++;
      console.error(`✗ ${f}: ${err.message}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} file(s) failed.`);
    process.exit(1);
  }
  console.log('\nDone.');
}

function readDirTmpl(dir: string): string[] {
  const { readdirSync } = require('node:fs');
  return readdirSync(dir).filter((f: string) => f.endsWith('.tmpl')).map((f: string) => path.join(dir, f));
}

main();
