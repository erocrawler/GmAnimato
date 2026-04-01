import path from 'path';
import fs from 'fs';
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
// Modal Proxy Auth (takes precedence over CUSTOM_VL_API_KEY when both Token ID and Secret are set)
const CUSTOM_VL_MODAL_TOKEN_ID = env.CUSTOM_VL_MODAL_TOKEN_ID || '';
const CUSTOM_VL_MODAL_TOKEN_SECRET = env.CUSTOM_VL_MODAL_TOKEN_SECRET || '';
const CUSTOM_VL_TIMEOUT_MS = Number(env.CUSTOM_VL_TIMEOUT_MS || '60000');
const CUSTOM_VL_ERROR_LOG = env.CUSTOM_VL_ERROR_LOG || path.join(process.cwd(), 'logs', 'custom-vl-errors.log');

// True when using a Modal direct endpoint (identified by Modal Proxy Auth tokens being configured)
function isModalEndpoint(): boolean {
  return Boolean(CUSTOM_VL_MODAL_TOKEN_ID && CUSTOM_VL_MODAL_TOKEN_SECRET);
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
  if (isModalEndpoint()) return true;          // Modal: token ID + secret
  return Boolean(CUSTOM_VL_API_KEY && CUSTOM_VL_MODEL); // OpenAI-compatible: bearer key + model
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

async function requestCustomVl(
  messages: CustomVlMessage[],
  temperature: number
): Promise<string | null> {
  if (!hasCustomVlConfig()) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_VL_TIMEOUT_MS);

  try {
    const url = CUSTOM_VL_URL.replace(/\/$/, '');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isModalEndpoint()) {
      headers['Modal-Key'] = CUSTOM_VL_MODAL_TOKEN_ID;
      headers['Modal-Secret'] = CUSTOM_VL_MODAL_TOKEN_SECRET;
    } else {
      headers['Authorization'] = `Bearer ${CUSTOM_VL_API_KEY}`;
    }

    const body: Record<string, unknown> = { messages, temperature };
    if (!isModalEndpoint()) {
      body['model'] = CUSTOM_VL_MODEL; // Modal doesn't use a model field
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
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const merged = content
        .map((item: any) => item?.text || '')
        .filter(Boolean)
        .join('\n');
      return merged || null;
    }

    return null;
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
    ? `You are an expert image analyzer for an AI first-last-to-video (FL2V) generation system. You will be provided with TWO images: the first frame and the last frame. Analyze both images and return a JSON object with:

1. suggested_prompts: Array with exactly 2 CONCISE FL2V generation prompts (max 50 words each) describing the TRANSITION between the two frames:
   - First prompt: A straightforward English description of how the scene transitions from first to last frame.
   - Second prompt: A Chinese (中文) version describing the same transition in a more cinematic way.
   
2. tags: Array of booru-style tags describing ONLY the characters/subjects visible in the images (e.g., "1girl", "solo", "1boy", "smile", "long_hair", "blue_eyes"). Do NOT include environment tags like backgrounds, locations, or settings.

3. is_photo_realistic: Boolean indicating if the images are photographic/realistic or artistic/illustrated

4. is_nsfw: Boolean indicating if either image contains NSFW content

IMPORTANT: 
- Focus prompts on the TRANSFORMATION and TRANSITION between the two frames
- DO NOT just say "person transitions from A to B" - ADD SPECIFIC DETAILS about HOW they moved (e.g., body language, movement direction, speed, camera pan or zoom)
- Describe the MOTION, GESTURE, POSTURE CHANGES, and any VISUAL TRANSFORMATION in detail
- Keep prompts SHORT and focused on the CHANGE from first to last frame
- Second prompt MUST be in Chinese (中文) and should not be a literal translation of the first prompt.
- Tags should describe characters/subjects ONLY, not environments
- Return ONLY valid JSON, no other text.`
    : `You are an expert image analyzer for an AI image-to-video generation system. Analyze the provided image and return a JSON object with:

1. suggested_prompts: Array with exactly 2 CONCISE Image to Video generation prompts (max 50 words each). They are optimized for a 6-second AI video:
   - First prompt: A straightforward English description focusing on motion and camera movement.
   - Second prompt: A Chinese (中文) version describing the same motion in a natural and cinematic way.
   
2. tags: Array of booru-style tags describing ONLY the characters/subjects (e.g., "1girl", "solo", "1boy", "smile", "long_hair", "blue_eyes"). Do NOT include environment tags like backgrounds, locations, or settings.

3. is_photo_realistic: Boolean indicating if the image is photographic/realistic or artistic/illustrated

4. is_nsfw: Boolean indicating if the image contains NSFW content

IMPORTANT: 
- Keep prompts SHORT and focused on VIDEO MOTION and CAMERA MOVEMENT
- Second prompt MUST be in Chinese (中文) and should not be a literal translation of the first prompt.
- Tags should describe characters/subjects ONLY, not environments
- Return ONLY valid JSON, no other text.`;

  try {
    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: isFL2V 
          ? 'Analyze these two images (first frame and last frame). Generate SHORT prompts describing the TRANSITION between them and tag only the characters/subjects, not the environment.'
          : 'Analyze this image. Generate SHORT motion prompts and tag only the characters/subjects, not the environment.',
      },
      {
        type: 'image_url',
        image_url: { url: imageUrl },
      },
    ];
    
    // Add second image for FL2V
    if (isFL2V && lastImageUrl) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: lastImageUrl },
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

  const evaluationPrompt = `Analyze the following video generation prompt in context with the provided image(s) and determine two properties:

1. is_photo_realistic: Whether the prompt describes a photographic/realistic scene (true) or artistic/illustrated scene (false)
2. is_nsfw: Whether the prompt contains or describes NSFW content (true) or is safe (false)

Prompt: "${prompt}"

Return ONLY a JSON object with these two boolean properties. Example:
{"is_photo_realistic": true, "is_nsfw": false}`;

  try {
    const messageContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      {
        type: 'text',
        text: evaluationPrompt,
      },
    ];

    // Add image(s) if provided
    if (imagePath) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: imagePath },
      });
    }
    if (lastImagePath) {
      messageContent.push({
        type: 'image_url',
        image_url: { url: lastImagePath },
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
