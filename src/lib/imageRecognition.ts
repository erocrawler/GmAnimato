import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { env } from '$env/dynamic/private';

interface CustomVlResponse {
  suggested_prompts: [string, string]; // [normal, dramatic]
  tags: string[];
  is_photo_realistic: boolean;
  is_nsfw: boolean;
}

type CustomVlMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
};

const CUSTOM_VL_MODEL = env.CUSTOM_VL_MODEL || 'gpt-4.1-mini';
const CUSTOM_VL_URL = env.CUSTOM_VL_URL || '';
const CUSTOM_VL_API_KEY = env.CUSTOM_VL_API_KEY || '';
const CUSTOM_VL_AUTH_MODE = (env.CUSTOM_VL_AUTH_MODE || 'none').toLowerCase();
// Shared token pair, with backward-compatible env fallbacks.
const CUSTOM_VL_TOKEN_ID =
  env.CUSTOM_VL_TOKEN_ID ||
  env.CUSTOM_VL_MODAL_TOKEN_ID ||
  env.CUSTOM_VL_CF_ACCESS_CLIENT_ID ||
  '';
const CUSTOM_VL_TOKEN_SECRET =
  env.CUSTOM_VL_TOKEN_SECRET ||
  env.CUSTOM_VL_MODAL_TOKEN_SECRET ||
  env.CUSTOM_VL_CF_ACCESS_CLIENT_SECRET ||
  '';
const CUSTOM_VL_TOKEN_ID_HEADER = env.CUSTOM_VL_TOKEN_ID_HEADER || '';
const CUSTOM_VL_TOKEN_SECRET_HEADER = env.CUSTOM_VL_TOKEN_SECRET_HEADER || '';
const CUSTOM_VL_ROUTE_MODAL_WHEN_LOCAL_BUSY = env.CUSTOM_VL_ROUTE_MODAL_WHEN_LOCAL_BUSY === 'true';
const CUSTOM_VL_LOCAL_BUSY_THRESHOLD = Number(env.CUSTOM_VL_LOCAL_BUSY_THRESHOLD || '0');
const CUSTOM_VL_MODAL_FALLBACK_URL = env.CUSTOM_VL_MODAL_FALLBACK_URL || '';
const CUSTOM_VL_MODAL_FALLBACK_TOKEN_ID = env.CUSTOM_VL_MODAL_FALLBACK_TOKEN_ID || '';
const CUSTOM_VL_MODAL_FALLBACK_TOKEN_SECRET = env.CUSTOM_VL_MODAL_FALLBACK_TOKEN_SECRET || '';
const CUSTOM_VL_TIMEOUT_MS = Number(env.CUSTOM_VL_TIMEOUT_MS || '60000');
const CUSTOM_VL_MAX_TOKENS = Number(env.CUSTOM_VL_MAX_TOKENS || '1024');
// Prompt enhancement emits a long structured prompt (subject definitions, shot
// list, soundscape, music...), so it gets a dedicated, larger token budget.
// The enhancer follows the official H3 prompt-writing guide's detail
// expectations (per-shot composition/appearance/lighting/camera/sound, speaker
// IDs, retention markers...), so the output is often 4-8K tokens; 4096 truncates
// it mid-section. 8192 fits within a 16K context even with ~8.5K worst-case
// image+text input; lower via env if the local context is tighter.
const CUSTOM_VL_ENHANCE_MAX_TOKENS = Number(env.CUSTOM_VL_ENHANCE_MAX_TOKENS || '8192');
const CUSTOM_VL_MAX_IMAGE_PIXELS = Number(env.CUSTOM_VL_MAX_IMAGE_PIXELS || '1000000');
// Prompt enhancement sends up to 9 images (ref images + video screenshots); each
// image consumes vision tokens in the VL context window. Keep them much smaller
// than the general-purpose cap so the request fits in a ~3K-token context.
const CUSTOM_VL_ENHANCE_MAX_IMAGE_PIXELS = Number(env.CUSTOM_VL_ENHANCE_MAX_IMAGE_PIXELS || '160000');
const CUSTOM_VL_ENABLE_THINKING = env.CUSTOM_VL_ENABLE_THINKING === 'true';
const CUSTOM_VL_ERROR_LOG = env.CUSTOM_VL_ERROR_LOG || path.join(process.cwd(), 'logs', 'custom-vl-errors.log');

type CustomVlAuthMode = 'modal' | 'cf' | 'custom' | 'bearer' | 'none';

function isModalEndpoint(): boolean {
  return resolveCustomVlAuthMode() === 'modal';
}

function hasTokenPair(): boolean {
  return Boolean(CUSTOM_VL_TOKEN_ID && CUSTOM_VL_TOKEN_SECRET);
}

function hasCustomHeaders(): boolean {
  return Boolean(CUSTOM_VL_TOKEN_ID_HEADER && CUSTOM_VL_TOKEN_SECRET_HEADER);
}

function resolveCustomVlAuthMode(): CustomVlAuthMode {
  const mode = CUSTOM_VL_AUTH_MODE as CustomVlAuthMode;
  if (mode === 'modal' || mode === 'cf' || mode === 'custom' || mode === 'bearer' || mode === 'none') {
    return mode;
  }

  console.warn(`[Custom VL] Invalid CUSTOM_VL_AUTH_MODE='${CUSTOM_VL_AUTH_MODE}', falling back to 'none'.`);
  return 'none';
}

function resolveTokenHeaders(authMode: CustomVlAuthMode): { idHeader: string; secretHeader: string } | null {
  if (authMode === 'modal') {
    return { idHeader: 'Modal-Key', secretHeader: 'Modal-Secret' };
  }
  if (authMode === 'cf') {
    return {
      idHeader: 'CF-Access-Client-Id',
      secretHeader: 'CF-Access-Client-Secret',
    };
  }
  if (authMode === 'custom') {
    if (!hasCustomHeaders()) {
      return null;
    }
    return {
      idHeader: CUSTOM_VL_TOKEN_ID_HEADER,
      secretHeader: CUSTOM_VL_TOKEN_SECRET_HEADER,
    };
  }
  return null;
}

function logCustomVlError(context: string, error: any, details: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    context,
    error: {
      message: error?.message || String(error),
      stack: error?.stack,
      response: error?.response?.data || error?.response,
    },
    request_details: details,
  };

  const logLine = `\n${'='.repeat(80)}\n${JSON.stringify(logEntry, null, 2)}\n`;
  
  try {
    fs.appendFileSync(CUSTOM_VL_ERROR_LOG, logLine, 'utf8');
    console.error(`[Custom VL] Logged error to ${CUSTOM_VL_ERROR_LOG}`);
  } catch (logError) {
    console.error('[Custom VL] Failed to write error log:', logError);
  }
}

function hasCustomVlConfig(): boolean {
  if (!CUSTOM_VL_URL) return false;
  const authMode = resolveCustomVlAuthMode();
  if (authMode === 'none') return false;
  if (authMode === 'bearer') return Boolean(CUSTOM_VL_API_KEY && CUSTOM_VL_MODEL);
  if (authMode === 'custom') return hasTokenPair() && hasCustomHeaders();
  return hasTokenPair();
}

function hasModalFallbackConfig(): boolean {
  return Boolean(
    CUSTOM_VL_MODAL_FALLBACK_URL &&
    CUSTOM_VL_MODAL_FALLBACK_TOKEN_ID &&
    CUSTOM_VL_MODAL_FALLBACK_TOKEN_SECRET
  );
}

async function shouldRouteToModalFallback(): Promise<boolean> {
  if (!CUSTOM_VL_ROUTE_MODAL_WHEN_LOCAL_BUSY || !hasModalFallbackConfig()) {
    return false;
  }

  try {
    const { getLocalJobStats } = await import('$lib/db');
    const stats = await getLocalJobStats();
    const activeLocalJobs = (stats.inQueue || 0) + (stats.processing || 0);
    return activeLocalJobs > CUSTOM_VL_LOCAL_BUSY_THRESHOLD;
  } catch (error) {
    console.warn('[Custom VL] Failed to read local queue stats, skipping modal fallback routing:', error);
    return false;
  }
}

async function fetchImageAsResizedBase64(url: string, maxPixels?: number): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const inputBytes = new Uint8Array(await response.arrayBuffer());
  const image = sharp(inputBytes, { failOn: 'none' });
  const metadata = await image.metadata();

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const hasAlpha = Boolean(metadata.hasAlpha);
  const currentPixels = width * height;

  const cap = maxPixels ?? CUSTOM_VL_MAX_IMAGE_PIXELS;
  const pipeline = sharp(inputBytes, { failOn: 'none' }).rotate();

  if (currentPixels > cap && width > 0 && height > 0) {
    const scale = Math.sqrt(cap / currentPixels);
    const targetWidth = Math.max(1, Math.floor(width * scale));
    const targetHeight = Math.max(1, Math.floor(height * scale));

    pipeline.resize(targetWidth, targetHeight, { fit: 'inside', withoutEnlargement: true });
  }

  if (hasAlpha) {
    pipeline.flatten({ background: '#ffffff' });
  }

  const processedBytes = await pipeline
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();

  const contentType = 'image/jpeg';
  const base64 = Buffer.from(processedBytes).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

async function toInferenceImageUrl(url: string, maxPixels?: number): Promise<string> {
  // Keep inference resilient: if preprocessing fails, fall back to original URL.
  try {
    return await fetchImageAsResizedBase64(url, maxPixels);
  } catch (error) {
    console.warn('[Custom VL] Failed to preprocess image, using source URL:', error);
    return url;
  }
}

function repairIncompleteJson(jsonStr: string): string {
  let repaired = jsonStr;
  
  // Escape raw control characters inside JSON strings. The enhanced prompt is
  // inherently multi-line, and models often emit literal \n / \t / \r (or other
  // control chars) inside the string value instead of escaped sequences, which
  // JSON.parse rejects with "Bad control character in string literal". Only
  // actual control chars match — already-escaped sequences like \\n (backslash
  // + 'n') contain no control chars and are left untouched.
  repaired = repaired.replace(/[\u0000-\u001F\u007F]/g, (ch) => {
    switch (ch) {
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    }
  });

  // Remove trailing commas that break JSON parsing (e.g., ["a", "b",])
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  
  // Fix missing ] before object field (e.g., ["a", "b", "field": -> ["a", "b"], "field":)
  // Pattern: array element followed by comma, then a quoted string with colon (indicating object field)
  const missingArrayClose = /"([^"]*)",\s*"([^"]+)":/g;
  let match;
  const fixes: Array<{index: number, type: string}> = [];
  
  while ((match = missingArrayClose.exec(repaired)) !== null) {
    // Check if this looks like a field name (common field names in our response)
    const potentialField = match[2];
    if (['suggested_prompts', 'tags', 'is_photo_realistic', 'is_nsfw', 'prompts', 'enhanced_prompt'].includes(potentialField)) {
      // Find position right before the field name quote
      const fixPosition = match.index + match[1].length + 2; // after the first quoted string and comma
      fixes.push({index: fixPosition, type: 'array_close'});
    }
  }
  
  // Apply fixes from end to start (so indices remain valid)
  for (const fix of fixes.reverse()) {
    repaired = repaired.slice(0, fix.index) + '],' + repaired.slice(fix.index + 1);
  }
  
  // Count opening and closing brackets/braces
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  
  // Add missing closing brackets at the end
  if (openBrackets > closeBrackets) {
    const missing = openBrackets - closeBrackets;
    repaired += ']'.repeat(missing);
  }
  
  // Add missing closing braces at the end
  if (openBraces > closeBraces) {
    const missing = openBraces - closeBraces;
    repaired += '}'.repeat(missing);
  }
  
  return repaired;
}

function stripMarkdownFences(raw: string): string {
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```\n?/g, '');
  }
  return jsonStr;
}

function stripThinkingContent(raw: string): string {
  let cleaned = raw.trim();

  cleaned = cleaned
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  const fencedJsonMatch = cleaned.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJsonMatch?.[1]) {
    return fencedJsonMatch[1].trim();
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1).trim();
  }

  return cleaned;
}

function parseJsonWithRepair<T>(rawText: string): T | null {
  const stripped = stripMarkdownFences(rawText);
  try {
    return JSON.parse(stripped) as T;
  } catch {
    const repaired = repairIncompleteJson(stripped);
    try {
      return JSON.parse(repaired) as T;
    } catch (error) {
      console.error('[Custom VL] Failed to parse JSON:', error);
      return null;
    }
  }
}

function extractContentFromPayload(payload: any): string | null {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return stripThinkingContent(content);
  }

  if (Array.isArray(content)) {
    const merged = content
      .map((item: any) => item?.text || '')
      .filter(Boolean)
      .join('\n');
    return merged ? stripThinkingContent(merged) : null;
  }

  return null;
}

async function requestModalFallback(
  messages: CustomVlMessage[],
  temperature: number,
  maxTokens?: number
): Promise<string | null> {
  if (!hasModalFallbackConfig()) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_VL_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Modal-Key': CUSTOM_VL_MODAL_FALLBACK_TOKEN_ID,
      'Modal-Secret': CUSTOM_VL_MODAL_FALLBACK_TOKEN_SECRET,
    };

    const body: Record<string, unknown> = {
      messages,
      temperature,
      max_tokens: maxTokens ?? CUSTOM_VL_MAX_TOKENS,
      response_format: { type: 'json_object' },
    };
    if (!CUSTOM_VL_ENABLE_THINKING) {
      body['chat_template_kwargs'] = { enable_thinking: false };
    }

    const response = await fetch(CUSTOM_VL_MODAL_FALLBACK_URL.replace(/\/$/, ''), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Modal fallback request failed (${response.status}): ${errorBody}`);
    }

    const payload = await response.json();
    console.log('[Custom VL] Raw modal fallback payload:', JSON.stringify(payload));
    return extractContentFromPayload(payload);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCustomVl(
  messages: CustomVlMessage[],
  temperature: number,
  maxTokens?: number
): Promise<string | null> {
  const baseConfigReady = hasCustomVlConfig();
  const modalFallbackReady = hasModalFallbackConfig();

  if (!baseConfigReady && !modalFallbackReady) {
    return null;
  }

  if (!baseConfigReady && modalFallbackReady) {
    return requestModalFallback(messages, temperature, maxTokens);
  }

  if (await shouldRouteToModalFallback()) {
    try {
      const modalText = await requestModalFallback(messages, temperature, maxTokens);
      if (modalText) {
        return modalText;
      }
      console.warn('[Custom VL] Modal fallback returned empty content, falling back to base endpoint.');
    } catch (error) {
      console.warn('[Custom VL] Modal fallback failed, falling back to base endpoint:', error);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_VL_TIMEOUT_MS);

  try {
    const url = CUSTOM_VL_URL.replace(/\/$/, '');
    const authMode = resolveCustomVlAuthMode();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authMode === 'bearer') {
      headers['Authorization'] = `Bearer ${CUSTOM_VL_API_KEY}`;
    } else if (authMode !== 'none') {
      const tokenHeaders = resolveTokenHeaders(authMode);
      if (!tokenHeaders || !hasTokenPair()) {
        throw new Error(`Custom VL auth mode '${authMode}' is missing token credentials or header names.`);
      }
      headers[tokenHeaders.idHeader] = CUSTOM_VL_TOKEN_ID;
      headers[tokenHeaders.secretHeader] = CUSTOM_VL_TOKEN_SECRET;
    }

    const body: Record<string, unknown> = {
      messages,
      temperature,
      max_tokens: maxTokens ?? CUSTOM_VL_MAX_TOKENS,
      response_format: { type: 'json_object' },
    };
    if (authMode === 'bearer') {
      body['model'] = CUSTOM_VL_MODEL;
    }
    if (!CUSTOM_VL_ENABLE_THINKING) {
      body['chat_template_kwargs'] = { enable_thinking: false };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Custom VL request failed (${response.status}): ${errorBody}`);
    }

    const payload = await response.json();
    console.log('[Custom VL] Raw response payload:', JSON.stringify(payload));
    return extractContentFromPayload(payload);
  } catch (error) {
    if (modalFallbackReady) {
      console.warn('[Custom VL] Base endpoint failed, trying modal fallback:', error);
      try {
        const modalText = await requestModalFallback(messages, temperature, maxTokens);
        if (modalText) {
          return modalText;
        }
        console.warn('[Custom VL] Modal fallback returned empty content after base failure.');
      } catch (modalError) {
        console.warn('[Custom VL] Modal fallback also failed after base failure:', modalError);
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function annotateImage(
  filePath: string,
  lastImagePath?: string,
  userId?: string,
  videoId?: string
): Promise<{ 
  tags: string[]; 
  suggested_prompts: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
}> {
  try {
    const result = await annotateWithCustomVl(filePath, lastImagePath, userId, videoId);
    if (result) {
      return {
        tags: result.tags,
        suggested_prompts: result.suggested_prompts,
        is_photo_realistic: result.is_photo_realistic,
        is_nsfw: result.is_nsfw,
      };
    }
  } catch (error) {
    console.error('[Custom VL] annotateImage error:', error);
  }

  // Graceful fallback: keep generation flow unblocked even if recognition fails.
  return {
    tags: [],
    suggested_prompts: [],
    is_photo_realistic: undefined,
    is_nsfw: undefined,
  };
}

export async function evaluatePromptProperties(
  editedPrompt: string,
  imagePath?: string,
  lastImagePath?: string,
  userId?: string,
  videoId?: string
): Promise<{ 
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
}> {
  if (!editedPrompt) {
    return {
      is_photo_realistic: undefined,
      is_nsfw: undefined,
    };
  }

  try {
    const result = await evaluatePromptWithCustomVl(editedPrompt, imagePath, lastImagePath, userId, videoId);
    if (result) {
      return {
        is_photo_realistic: result.is_photo_realistic,
        is_nsfw: result.is_nsfw,
      };
    }
  } catch (error) {
    console.error('[Custom VL] Prompt evaluation error:', error);
  }

  return {
    is_photo_realistic: undefined,
    is_nsfw: undefined,
  };
}

export interface EnhanceMiniMaxPromptParams {
  prompt: string;
  /** 'ref2v' | 'fl2v' | 'i2v' — selects the output structure the MiniMax H3
   *  generation nodes consume. */
  workflowType: 'ref2v' | 'fl2v' | 'i2v';
  /** Labeled reference images. Each entry binds an image to its prompt tag
   *  (e.g. '<Picture 1>', '<Video 1> 截图 1/3') — the VL model cannot infer
   *  the tag↔image correspondence from a bare URL, so every image MUST carry
   *  a label that names the tag it corresponds to. */
  labeledImages?: { label: string; url: string }[];
  /** True when the job has a standalone reference audio attached (ref2v only).
   *  It is referenced as <Audio 1> — the VL model can't hear it, but it must
   *  know the tag exists (and never hallucinate it when absent). */
  hasStandaloneAudio?: boolean;
  /** Video duration in seconds — the enhanced prompt references it. */
  durationSeconds?: number;
  /** 'zh' | 'en' — the generated shot descriptions / dialogue should prefer
   *  this language. */
  locale?: string;
  userId?: string;
  videoId?: string;
}

/**
 * Enhance a simple MiniMax H3 prompt into the structured prompt format the
 * MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo nodes consume
 * (integrated_multimodal_description with subject_definitions, shot list,
 * soundscape and music sections). Uses the same CUSTOM_VL endpoint as the
 * "Analyze with AI" flow; the reference images are sent for vision grounding.
 *
 * Returns the enhanced prompt text, or null when the VL service is
 * unavailable / the model did not return a usable enhancement.
 */
export async function enhanceMiniMaxPrompt(
  params: EnhanceMiniMaxPromptParams
): Promise<string | null> {
  if (!hasCustomVlConfig() && !hasModalFallbackConfig()) {
    return null;
  }

  const lang = params.locale === 'zh' ? '中文' : 'English';
  const duration = params.durationSeconds ?? 5;

  // Build the EXACT list of references that exist in this job, so the model
  // only writes tags for what was actually uploaded. It must never invent a
  // <Picture N> or <Video 1> that isn't here — the generation node would try
  // to bind a non-existent reference.
  const availableRefTags: string[] = [];
  let hasVideoRef = false;
  for (const img of params.labeledImages ?? []) {
    const picMatch = img.label.match(/^(<Picture\s*\d+>)/);
    if (picMatch) availableRefTags.push(picMatch[1]);
    if (/^<Video\s*1>/.test(img.label)) hasVideoRef = true;
  }
  if (hasVideoRef) availableRefTags.push('<Video 1>');
  // Standalone reference audio is <Audio 1> — present only when the job has
  // one. AVAILABLE REFERENCES is the single source of truth for what the model
  // may reference, so the tag is listed purely by presence (no workflowType
  // gate). Listed last, matching the node's images → videos → audio ordering.
  if (params.hasStandaloneAudio) {
    availableRefTags.push('<Audio 1>');
  }
  const availableRefsDesc =
    availableRefTags.length > 0
      ? availableRefTags.join(', ')
      : '（无 — 纯文本转视频，没有任何参考图像或视频）';

  // Reference-to-video structure (full-reference / Ref2VA format from the
  // official H3 prompt-writing guide): subject_definitions, summary,
  // retention_analysis, detailed_description, overall_soundscape,
  // non_diegetic_music — covering all reference operations available in this
  // job: <Subject N>, <Picture N> (subject source, frame anchor, storyboard)
  // and <Video N> (editing / continuation / structure), with the full summary
  // task-type set and the visible retention markers. A standalone reference
  // audio (<Audio 1>) is listed only when the job actually has one (see
  // AVAILABLE REFERENCES); without it, audio copy/reuse/reference operations
  // are out of scope. Kept terse — the prompt itself is large and must fit
  // the VL context window alongside up to 9 images.
  // Whether a reference video exists is known at construction time, so
  // video-specific rules are built in statically instead of conditional text.
  const videoMergeRule = hasVideoRef
    ? `- <Video 1> is available. If it shows the same subject as a picture, merge it too: "<Picture 1>、<Video 1> 共同作为 <Subject N> 外观来源..." — if it shows different subjects, give it its own <Subject N>.\n`
    : '';
  const hasPictureRef = availableRefTags.some((t) => /^<Picture\s*\d+>$/i.test(t));
  const videoOnlyRule = hasVideoRef && !hasPictureRef
    ? `- <Video 1> is the only reference in this job: declare every subject as "<Video 1> 作为 <Subject N> ...".\n`
    : '';
  // <Audio 1> (standalone reference audio) is a separate node input from any
  // ref-video soundtrack. Static, list-driven rules — emitted only when the
  // tag is actually available, mirroring the videoMergeRule pattern.
  const audioRule = params.hasStandaloneAudio
    ? `- <Audio 1> (when listed) is the job's standalone reference AUDIO clip: it supplies the desired voice/singing timbre and music/ambience style, which you cannot hear but must follow. Direct generated dialogue/singing (the <d> lines) to follow <Audio 1> when the user's text implies speech or song; otherwise reflect its style in overall_soundscape / non_diegetic_music. Only the tags listed in AVAILABLE REFERENCES exist — a tag not listed there is invalid and will be stripped.\n`
    : '';
  const ref2vSystemPrompt = `MiniMax H3 reference-to-video prompt architect. Rewrite the user's simple prompt into the model's required structured prompt in ${lang}, using EXACTLY these six sections in order (each heading on its own line ending with ':'): subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. A reference label keeps the same meaning across all six sections.

AVAILABLE REFERENCES (the complete set of tags for this job):
${availableRefsDesc}

subject_definitions:
- <Subject N> = reusable visible content: people/animals/objects, scenes/backgrounds/environments, clothing/props/interfaces/effects, styles/actions/expressions/poses. Declare sources from AVAILABLE REFERENCES using the listed tags, and declare each <Subject N> and its role.
- GROUP pictures by the actual subject: if two <Picture N> show the SAME character/object (compare the attached images — same person, same outfit/features), declare ONE <Subject N> for them and list both pictures as its sources: "<Picture 1>、<Picture 2> 共同作为 <Subject 1> 人物/物体外观来源，需保持其<关键视觉特征>。" Introduce a new <Subject N> when the images show a different person or object.
${videoMergeRule}- One subject may combine multiple assets; one asset may provide multiple subjects. State what each asset contributes.
- "<Picture N> 作为 <Subject N> ..." format for each subject source (write in 中文).
- Use a standalone <Picture N> entry when the image itself is a frame anchor (first frame, keyframe, last frame, edited keyframe, composition anchor) or a storyboard for specific shots: "<Picture 2> is the first frame of [Shot 1], showing ..." / "<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order." Otherwise cite the image inside the <Subject N> it defines.
- <Video N> is reserved for whole-video relationships: editing an original video, continuing from its end, or referencing its camera movement, cuts, rhythm, or temporal structure ("<Video 1> is the source video for the target video edit."). People/objects/scenes/actions from the video belong under <Subject N>.
- Unused available tags: "<X> 不适用。"

summary:
- One short paragraph in ${lang}. Begin with a square-bracketed task-type prefix combining the actual roles of the references with " + " (each type appears at most once): [keyframe completion] an image is a concrete first-frame/keyframe/last-frame anchor / [reference generation] an image or video guides character, scene, style, action, camera or storyboard without being a concrete frame or an edited/continued source / [video editing] the source video is directly modified / [video continuation] new content continues, extends, resumes or transitions from the source video.
- Match the type to the reference's actual role: camera/cuts/rhythm-only references use [reference generation]; videos that are directly edited or continued use [video editing]/[video continuation].
- For video-editing tasks, continue after the prefix: "The target video is an edited version of <Video 1>."
- Use only labels already defined in subject_definitions; introduce no new labels here.

retention_analysis:
- One line per reference label (Subject/Picture/Video), preserving the roles defined in subject_definitions; speaker IDs stay in detailed_description.
- Visible markers (fixed English values): fully_preserved / partially_preserved (still used, some defined characteristics changed) / attribute_transfer (characteristics transferred to a different subject) / weak_reference (style, category, composition or atmosphere only).
- Formats: "<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - <retained features>." / "<Picture 2> ([Shot 1] first frame): fully_preserved - ..." / "<Video 1> (cut and pacing structure): weak_reference - ...".
- Match each marker to the role already defined for that label; rate fidelity against those roles, treating newly added actions, backgrounds, or plot events as the target video's own content.

detailed_description:
- Establish the style in one or two ${lang} sentences BEFORE [Shot 1] (e.g. "The target video is in a cinematic, literary music-video style with soft lighting and a slightly desaturated color palette."). "[Shot 1]" is timestamp-free; later shots "[Shot N] At MM:SS.mmm, ..." carry strictly increasing cut times ("[Shot 2] At 00:03.500").
- At a label's first clear appearance, describe its referenced characteristics, frame position and current action; reuse the label afterwards without redefining it. Frame anchors use natural phrasing: "the shot begins from <Picture 1>" / "the shot's keyframe corresponds to <Picture 2>" / "the shot ends on <Picture 3>". Cite <Video N> where its source state, structure or continuation relationship applies.
- Camera motion is written naturally in the sentence as type + amplitude + speed when meaningful (e.g. "镜头小幅度慢速推近" / "the camera pans right with large amplitude at fast speed").
- Speakers get stable IDs by order of actual vocal events: "<Subject 1> (S1) 说：<d>[Chinese] 对话内容。</d>" — <Subject N> is the referenced subject, (Sx) the speaker; ID sits OUTSIDE <d>; compound (S1,S2) for group speech. Off-screen: keep the same form and mark it off-screen. Non-subject speakers: stable voice description + (Sx).
- <d>[lang]...</d> wraps real spoken sentences — the character speaks those exact words in that language (lip-sync + voice). Describe sound effects (breaths, sighs, moans, footsteps, thuds) as plain text ("<Subject 1> 发出急促的呼气声") and put ambient sounds in overall_soundscape. Voiceover: "以画外音说道" and state the on-screen lips remain closed.
- Dialogue crossing a cut uses <scenetrans> at the junction and notes the audio continues across the cut; speech cut off by the video end uses <cutoff>.
- On-screen readable text (signs, banners, subtitles) goes in English double quotes, preserved verbatim.
- Make it as detailed and explicit as possible (composition, appearance, lighting, camera, sound per shot); normally 350-500 words for generation tasks; dialogue-dense content prioritizes a complete spoken timeline.

overall_soundscape:
- Ambient sound in ${lang}, 1-4 sentences in one paragraph. Dialogue/singing stays in detailed_description. "N/A" only for complete silence.

non_diegetic_music:
- Music/score in ${lang}, 1-3 sentences: instrumentation, tempo, dynamics — no abstract mood words. "N/A" when there is no audience-only music.

Rules:
- Use the tags <Picture N>, <Video 1>, <Subject N>, <Audio N>; refer to the reference video as <Video 1>, not via screenshot labels like "<Video 1> 截图 N/M". Only the tags listed in AVAILABLE REFERENCES exist — a tag not listed there is invalid and will be stripped.
${audioRule}- <d>[lang]...</d> wraps real spoken sentences — the character speaks those exact words in that language (lip-sync + voice). Describe sounds/effects (breaths, gasps, moans, knocks) as plain text, outside <d>, and put ambient sounds in overall_soundscape.
${videoOnlyRule}- Upload captions: '<Picture N>' for ref images, '<Video 1> 截图 N/M' for video frames — analysis only; video subjects source from <Video 1>.
- Study attached images for appearance details (clothing, features) and use them. When pictures show the same subject, merge them into a single <Subject N>.
- Make detailed_description as detailed and explicit as possible (composition, appearance, lighting, camera, sound per shot); dialogue-dense content prioritizes a complete spoken timeline.
- Video is ${duration}s; match shot plan.
- Output ONLY {"enhanced_prompt": "<full prompt text with real line breaks>"}.`;

  // Image-to-video (fl2v / i2v) structure: integrated_multimodal_description
  // with shot segments + audio sections. Kept terse to fit the VL context.
  const i2vSystemPrompt = `MiniMax H3 image-to-video prompt architect. Rewrite the user's simple prompt into the required structured prompt in ${lang}, using EXACTLY these sections (each heading on its own line ending with ':').

AVAILABLE REFERENCES (the complete set of tags for this job):
${availableRefsDesc}

integrated_multimodal_description:
Shot-by-shot script in ${lang}: scene setup, then "[Shot N] At MM:SS.mmm, ..." — the first shot is "[Shot 1]" with NO timestamp; later shots carry strictly increasing cut times ("[Shot 2] At 00:03.500"). Camera motion is written naturally in the sentence as type + amplitude + speed when meaningful (e.g. "镜头小幅度慢速推近" / "the camera pans right with large amplitude at fast speed"). Speakers get stable IDs: (S1), (S2)..., compound (S1,S2) for group speech, ID outside <d>: "女子 (S1) 说：<d>[Chinese] 对话内容。</d>". Voiceover: "以画外音说道" and state the on-screen lips remain closed. Dialogue crossing a cut uses <scenetrans>; speech cut off by the video end uses <cutoff>. On-screen text goes in English double quotes, verbatim. Wrap real spoken sentences in dialogue tags: "<d>[Chinese] 对话内容。</d>" or "<d>[English] dialogue.</d>". Describe sounds (breaths, sighs, moans, footsteps) as plain text, outside <d>. Use <Picture N> tags from AVAILABLE REFERENCES.

overall_soundscape:
Ambient sound in ${lang}, 1-4 sentences in one paragraph. Dialogue/singing stays in integrated_multimodal_description. "N/A" only for complete silence.

non_diegetic_music:
Music/score in ${lang}, 1-3 sentences: instrumentation, tempo, dynamics — no abstract mood words. "N/A" when there is no audience-only music.

Rules:
- Reference tags from AVAILABLE REFERENCES as listed.
- <d>[lang]...</d> wraps real spoken sentences — the character speaks those words in that language (lip-sync + voice). Describe sounds/effects as plain text and put them in overall_soundscape.
- Upload captions ('首帧'/'尾帧'/etc.) tell you which image is which.
- Make integrated_multimodal_description as detailed and explicit as possible (composition, appearance, lighting, camera, sound per shot); dialogue-dense content prioritizes a complete spoken timeline.
- Video is ${duration}s; match shot plan.
- Output ONLY {"enhanced_prompt": "<full prompt text with real line breaks>"}.`;

  const isRef2v = params.workflowType === 'ref2v';

  try {
    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: `Simple prompt: "${params.prompt}"`,
      },
    ];

    // Labeled images (preferred): alternate a caption naming the tag with the
    // image itself, so the model knows exactly which upload is <Picture 1> vs
    // <Video 1> screenshots. Fall back to the deprecated flat list when no
    // labels are provided (still sent, just without binding info).
    const labeled = params.labeledImages ?? [];
    if (labeled.length > 0) {
      for (const { label, url } of labeled) {
        // Downscale aggressively: up to 9 images must fit the VL context window.
        const processed = await toInferenceImageUrl(url, CUSTOM_VL_ENHANCE_MAX_IMAGE_PIXELS);
        messageContent.push({ type: 'text', text: `Reference image for ${label}:` });
        messageContent.push({ type: 'image_url', image_url: { url: processed } });
      }
    }

    const text = await requestCustomVl(
      [
        {
          role: 'system',
          content: isRef2v ? ref2vSystemPrompt : i2vSystemPrompt,
        },
        {
          role: 'user',
          content: messageContent,
        },
      ],
      0.7,
      CUSTOM_VL_ENHANCE_MAX_TOKENS
    );

    if (!text) {
      return null;
    }

    // Prefer the JSON envelope, but fall back to the raw text: models sometimes
    // return the structured prompt bare (no {"enhanced_prompt": ...} wrapper)
    // or with a parse-breaking envelope. The bare text is still a usable prompt.
    const parsed = parseJsonWithRepair<{ enhanced_prompt?: string }>(text);
    let enhanced = parsed?.enhanced_prompt?.trim() || stripThinkingContent(text).trim();
    if (!enhanced) {
      logCustomVlError('enhanceMiniMaxPrompt.invalidStructure', null, {
        user_id: params.userId,
        video_id: params.videoId,
        workflowType: params.workflowType,
      });
      return null;
    }
    // Safety nets:
    // 1. The generation model only sees <Video 1> (the video itself), never
    //    individual screenshots — collapse any leaked screenshot labels.
    enhanced = enhanced.replace(/<Video 1>\s*截图\s*\d+\s*\/\s*\d+/gi, '<Video 1>');
    // 2. Any reference tag the job doesn't actually have is a hallucination —
    //    the generation node would try to bind a non-existent reference. When
    //    the job has a reference video, remap hallucinated <Picture N> to
    //    <Video 1> (the model observed those subjects in the video screenshots,
    //    so the video is the correct source). Hallucinated <Audio N> tags are
    //    never remapped — always stripped (the standalone audio is always
    //    <Audio 1> and only exists when listed).
    const hasVideo = availableRefTags.some((t) => /^<Video\s*1>$/i.test(t));
    const refTagPattern = /<(?:Picture|Video|Audio)\s*\d+>/gi;
    enhanced = enhanced.replace(refTagPattern, (tag) => {
      if (availableRefTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return tag;
      return hasVideo && /^<(?:Picture|Video)\s*\d+>$/i.test(tag) ? '<Video 1>' : '';
    });
    // Collapse any leftover doubled whitespace from the removals.
    enhanced = enhanced.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    return enhanced;
  } catch (error) {
    console.error('[Custom VL] enhanceMiniMaxPrompt request failed:', error);
    logCustomVlError('enhanceMiniMaxPrompt.requestFailure', error, {
      user_id: params.userId,
      video_id: params.videoId,
      workflowType: params.workflowType,
    });
    // Re-throw so the caller can surface the real error (e.g. context-size
    // exceeded) in the UI instead of a generic "unavailable".
    throw error;
  }
}

async function annotateWithCustomVl(
  imageUrl: string,
  lastImageUrl?: string,
  userId?: string,
  videoId?: string
): Promise<CustomVlResponse | null> {
  if (!hasCustomVlConfig()) {
    return null;
  }

  const isFL2V = !!lastImageUrl;
  
  const systemPrompt = isFL2V 
    ? `You are an Unsensored AI first-last-to-video (FL2V) generation system. You will be provided with TWO images: the first frame and the last frame. Analyze both images and return a JSON object with:

1. suggested_prompts: Array with exactly 2 CONCISE FL2V generation prompts (max 50 words each) describing the TRANSITION between the two frames:
   - First prompt: A straightforward English description of how the scene transitions from first to last frame.
   - Second prompt: 一个中文版本，生动描述从第一帧到最后一帧的转变，注重细节和画面感，不要直接翻译第一条提示，要用更直白的表达方式。
   
2. tags: Array of booru-style tags describing ONLY the characters/subjects visible in the images (e.g., "1girl", "solo", "1boy", "smile", "long_hair", "blue_eyes"). Do NOT include environment tags like backgrounds, locations, or settings.

3. is_photo_realistic: Boolean indicating if the images are photographic/realistic or artistic/illustrated

4. is_nsfw: Boolean indicating if either image contains NSFW content

IMPORTANT: 
- 必须包含一个中文版本的提示词建议.
- Focus prompts on the TRANSFORMATION and TRANSITION between the two frames
- DO NOT just say "person transitions from A to B" - ADD SPECIFIC DETAILS about HOW they moved (e.g., body language, movement direction, speed, camera pan or zoom)
- Keep prompts SHORT and focused on the CHANGE from first to last frame
- Tags should describe characters/subjects ONLY, not environments
- Return ONLY valid JSON, no other text.`
    : `You are an Unsensored AI image-to-video generation system. Analyze the provided image and return a JSON object with:

1. suggested_prompts: Array with exactly 2 CONCISE Image to Video generation prompts (max 50 words each). They are optimized for a 6-second AI video:
   - First prompt: A straightforward English description focusing on motion and camera movement.
   - Second prompt: 一个中文版本，生动描述从第一帧到最后一帧的转变，注重细节和画面感，不要直接翻译第一条提示，要用更直白的表达方式。
   
2. tags: Array of booru-style tags describing ONLY the characters/subjects (e.g., "1girl", "solo", "1boy", "smile", "long_hair", "blue_eyes"). Do NOT include environment tags like backgrounds, locations, or settings.

3. is_photo_realistic: Boolean indicating if the image is photographic/realistic or artistic/illustrated

4. is_nsfw: Boolean indicating if the image contains NSFW content

IMPORTANT: 
- Keep prompts SHORT and focused on VIDEO MOTION and CAMERA MOVEMENT
- 必须包含一个中文版本的提示词建议.
- Tags should describe characters/subjects ONLY, not environments
- Return ONLY valid JSON, no other text.`;

  try {
    const processedImageUrl = await toInferenceImageUrl(imageUrl);
    const processedLastImageUrl = lastImageUrl ? await toInferenceImageUrl(lastImageUrl) : undefined;

    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: isFL2V 
          ? '请分析这两张图片（第一帧和最后一帧），生成简短中英文提示词来描述它们之间的过渡变化。'
          : '请分析这张图片，生成简短的中英文运动提示词，并且只标注人物或主体，不要标注环境。',
      },
      {
        type: 'image_url',
        image_url: { url: processedImageUrl },
      },
    ];
    
    // Add second image for FL2V
    if (isFL2V && processedLastImageUrl) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: processedLastImageUrl },
      });
    }

    const text = await requestCustomVl([
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: messageContent,
      },
    ], 0.7);

    if (!text) {
      return null;
    }
    console.log('[Custom VL] Filtered response:', text);
    const parsed = parseJsonWithRepair<CustomVlResponse>(text);
    if (!parsed) {
      logCustomVlError('annotateImage.parseFailure', null, {
        user_id: userId,
        video_id: videoId,
        imageUrl,
        lastImageUrl,
      });
      return null;
    }

    if (
      !Array.isArray(parsed.suggested_prompts) ||
      !Array.isArray(parsed.tags) ||
      typeof parsed.is_photo_realistic !== 'boolean' ||
      typeof parsed.is_nsfw !== 'boolean'
    ) {
      console.error('[Custom VL] Invalid response structure:', parsed);
      return null;
    }

    const safePrompt0 = parsed.suggested_prompts[0] || '';
    const safePrompt1 = parsed.suggested_prompts[1] || '';

    return {
      suggested_prompts: [safePrompt0, safePrompt1],
      tags: parsed.tags.filter((t) => typeof t === 'string' && t.trim().length > 0),
      is_photo_realistic: parsed.is_photo_realistic,
      is_nsfw: parsed.is_nsfw,
    };
  } catch (error) {
    console.error('[Custom VL] annotateImage request failed:', error);
    logCustomVlError('annotateImage.requestFailure', error, {
      user_id: userId,
      video_id: videoId,
      imageUrl,
      lastImageUrl,
      model: CUSTOM_VL_MODEL,
    });
    return null;
  }
}

async function evaluatePromptWithCustomVl(
  prompt: string,
  imagePath?: string,
  lastImagePath?: string,
  userId?: string,
  videoId?: string
): Promise<{ is_photo_realistic: boolean | undefined; is_nsfw: boolean } | null> {
  if (!hasCustomVlConfig()) {
    return null;
  }

  const evaluationPrompt = `请结合提供的图片和下面这段视频生成提示词，判断两个属性：

1. is_photo_realistic: 如果提示词描述的是照片感/写实场景，则为 true；如果是绘画感/二次元/插画风格，则为 false
2. is_nsfw: 如果提示词包含或描述 NSFW 内容，则为 true；否则为 false

提示词: "${prompt}"

只返回包含这两个布尔字段的 JSON 对象。例如:
{"is_photo_realistic": true, "is_nsfw": false}`;

  try {
    const [processedImagePath, processedLastImagePath] = await Promise.all([
      imagePath ? toInferenceImageUrl(imagePath) : Promise.resolve(undefined),
      lastImagePath ? toInferenceImageUrl(lastImagePath) : Promise.resolve(undefined),
    ]);

    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: evaluationPrompt,
      },
    ];

    // Add image(s) if provided
    if (processedImagePath) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: processedImagePath },
      });
    }
    if (processedLastImagePath) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: processedLastImagePath },
      });
    }

    const text = await requestCustomVl([
      {
        role: 'user',
        content: messageContent,
      },
    ], 0.2);

    if (!text) {
      return null;
    }

    const parsed = parseJsonWithRepair<{ is_photo_realistic: boolean; is_nsfw: boolean }>(text);
    if (!parsed) {
      return null;
    }

    if (
      typeof parsed.is_photo_realistic !== 'boolean' ||
      typeof parsed.is_nsfw !== 'boolean'
    ) {
      console.error('[Custom VL] Invalid response structure:', parsed);
      return null;
    }

    return parsed;
  } catch (error) {
    console.error('[Custom VL] Prompt evaluation request failed:', error);
    logCustomVlError('evaluatePromptProperties', error, {
      user_id: userId,
      video_id: videoId,
      prompt,
      imagePath,
      lastImagePath,
      model: CUSTOM_VL_MODEL,
    });
    return null;
  }
}

export interface PromptRelaySegmentResult {
  prompt: string;
  frames: number;
}

export interface PromptRelayResult {
  globalPrompt: string;
  segments: PromptRelaySegmentResult[];
}

async function generatePromptRelayWithCustomVl(
  imageUrl: string,
  lastImageUrl?: string,
  totalFrames: number = 81,
  fps: number = 18,
  userId?: string,
  videoId?: string,
  locale?: string
): Promise<PromptRelayResult | null> {
  if (!hasCustomVlConfig()) {
    return null;
  }

  const durationSecs = (totalFrames / fps).toFixed(1);
  const isFL2V = !!lastImageUrl;
  const langInstruction = locale && locale.startsWith('zh')
    ? 'Write all prompts in Chinese (Simplified).'
    : 'Write all prompts in English.';

  const systemPrompt = isFL2V
    ? `You are an AI video prompt segmentation assistant. You will receive TWO images: the first frame and the last frame of a ${durationSecs}-second (${totalFrames} frames at ${fps} fps) video.

Your task is to generate a PROMPT RELAY plan that divides the video into meaningful segments, each with its own motion description.

Return a JSON object with:
1. global_prompt: A short description (max 30 words) of the overall video subject and style.
2. segments: Array of 2-5 segment objects, each with:
   - prompt: Description (max 40 words) of motion/action during this segment
   - frames: Integer number of frames for this segment (minimum 18)

Rules:
- The segments[].frames values MUST sum exactly to ${totalFrames}
- Each segment must have at least 18 frames
- Describe HOW the scene changes within each segment (movement direction, speed, camera action)
- Segments should flow naturally from first frame to last frame
- ${langInstruction}
- Return ONLY valid JSON, no other text.`
    : `You are an AI video prompt segmentation assistant. You will receive an image that is the starting frame of a ${durationSecs}-second (${totalFrames} frames at ${fps} fps) video.

Your task is to generate a PROMPT RELAY plan that divides the video into meaningful segments, each with its own motion description.

Return a JSON object with:
1. global_prompt: A short description (max 30 words) of the subject and overall motion style.
2. segments: Array of 2-5 segment objects, each with:
   - prompt: Description (max 40 words) of motion/action during this segment
   - frames: Integer number of frames for this segment (minimum 18)

Rules:
- The segments[].frames values MUST sum exactly to ${totalFrames}
- Each segment must have at least 18 frames
- Describe motion progression naturally (e.g., slow start, peak action, gentle ease-out)
- ${langInstruction}
- Return ONLY valid JSON, no other text.`;

  try {
    const processedImageUrl = await toInferenceImageUrl(imageUrl);
    const processedLastImageUrl = lastImageUrl ? await toInferenceImageUrl(lastImageUrl) : undefined;

    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: isFL2V
          ? `Please analyze these two frames and generate a ${totalFrames}-frame prompt relay plan.`
          : `Please analyze this image and generate a ${totalFrames}-frame prompt relay plan.`,
      },
      {
        type: 'image_url',
        image_url: { url: processedImageUrl },
      },
    ];

    if (isFL2V && processedLastImageUrl) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: processedLastImageUrl },
      });
    }

    const text = await requestCustomVl([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: messageContent },
    ], 0.7);

    if (!text) return null;

    const parsed = parseJsonWithRepair<{ global_prompt: string; segments: { prompt: string; frames: number }[] }>(text);
    if (!parsed || typeof parsed.global_prompt !== 'string' || !Array.isArray(parsed.segments)) {
      console.error('[Custom VL] Invalid prompt relay response structure:', parsed);
      return null;
    }

    // Validate and clean segments
    const segments = parsed.segments
      .filter(s => typeof s.prompt === 'string' && Number.isInteger(Number(s.frames)) && Number(s.frames) >= 18)
      .map(s => ({ prompt: String(s.prompt).trim(), frames: Number(s.frames) }));

    if (segments.length === 0) return null;

    // Fix frame sum — redistribute any rounding error onto the last segment
    const rawSum = segments.reduce((sum, s) => sum + s.frames, 0);
    if (rawSum !== totalFrames) {
      segments[segments.length - 1].frames += totalFrames - rawSum;
      if (segments[segments.length - 1].frames < 9) {
        // Re-distribute evenly if adjustment causes underflow
        const evenFrames = Math.floor(totalFrames / segments.length);
        segments.forEach((s, i) => {
          s.frames = i === segments.length - 1
            ? totalFrames - evenFrames * (segments.length - 1)
            : evenFrames;
        });
      }
    }

    return {
      globalPrompt: parsed.global_prompt.trim(),
      segments,
    };
  } catch (error) {
    console.error('[Custom VL] Prompt relay generation failed:', error);
    logCustomVlError('generatePromptRelay.requestFailure', error, {
      user_id: userId,
      video_id: videoId,
      imageUrl,
      lastImageUrl,
      totalFrames,
      model: CUSTOM_VL_MODEL,
    });
    return null;
  }
}

export async function generatePromptRelaySegments(
  imageUrl: string,
  lastImageUrl?: string,
  totalFrames: number = 81,
  fps: number = 18,
  userId?: string,
  videoId?: string,
  locale?: string
): Promise<PromptRelayResult | null> {
  try {
    return await generatePromptRelayWithCustomVl(imageUrl, lastImageUrl, totalFrames, fps, userId, videoId, locale);
  } catch (error) {
    console.error('[Custom VL] generatePromptRelaySegments error:', error);
    return null;
  }
}
