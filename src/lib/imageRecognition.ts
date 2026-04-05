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
const CUSTOM_VL_MAX_IMAGE_PIXELS = Number(env.CUSTOM_VL_MAX_IMAGE_PIXELS || '1000000');
const CUSTOM_VL_ENABLE_THINKING = env.CUSTOM_VL_ENABLE_THINKING !== 'true';
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

async function fetchImageAsResizedBase64(url: string): Promise<string> {
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

  const pipeline = sharp(inputBytes, { failOn: 'none' }).rotate();

  if (currentPixels > CUSTOM_VL_MAX_IMAGE_PIXELS && width > 0 && height > 0) {
    const scale = Math.sqrt(CUSTOM_VL_MAX_IMAGE_PIXELS / currentPixels);
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

async function toInferenceImageUrl(url: string): Promise<string> {
  // Keep inference resilient: if preprocessing fails, fall back to original URL.
  try {
    return await fetchImageAsResizedBase64(url);
  } catch (error) {
    console.warn('[Custom VL] Failed to preprocess image, using source URL:', error);
    return url;
  }
}

function repairIncompleteJson(jsonStr: string): string {
  let repaired = jsonStr;
  
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
    if (['suggested_prompts', 'tags', 'is_photo_realistic', 'is_nsfw', 'prompts'].includes(potentialField)) {
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
  temperature: number
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
      max_tokens: CUSTOM_VL_MAX_TOKENS,
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
  temperature: number
): Promise<string | null> {
  const baseConfigReady = hasCustomVlConfig();
  const modalFallbackReady = hasModalFallbackConfig();

  if (!baseConfigReady && !modalFallbackReady) {
    return null;
  }

  if (!baseConfigReady && modalFallbackReady) {
    return requestModalFallback(messages, temperature);
  }

  if (await shouldRouteToModalFallback()) {
    try {
      const modalText = await requestModalFallback(messages, temperature);
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
      max_tokens: CUSTOM_VL_MAX_TOKENS,
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
        const modalText = await requestModalFallback(messages, temperature);
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
