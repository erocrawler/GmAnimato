import path from 'path';
import fs from 'fs';
import { createXai } from '@ai-sdk/xai';
import { generateText } from 'ai';
import { env } from '$env/dynamic/private';

interface GrokVisionResponse {
  suggested_prompts: [string, string]; // [normal, dramatic]
  tags: string[];
  is_photo_realistic: boolean;
  is_nsfw: boolean;
}

const GROK_VERSION = 'grok-4-1-fast-non-reasoning';
const POLICY_VIOLATION_LOG = env.GROK_POLICY_VIOLATION_LOG || path.join(process.cwd(), 'logs', 'grok-policy-violations.log');

function logPolicyViolation(context: string, error: any, details: Record<string, any>) {
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
    fs.appendFileSync(POLICY_VIOLATION_LOG, logLine, 'utf8');
    console.error(`[Grok Policy Violation] Logged to ${POLICY_VIOLATION_LOG}`);
  } catch (logError) {
    console.error('[Grok Policy Violation] Failed to write log:', logError);
  }
}

function isPolicyViolationError(error: any): boolean {
  const errorStr = String(error?.message || error).toLowerCase();
  const responseStr = String(error?.response?.data || error?.responseBody || '').toLowerCase();
  
  // Check for 403 status code
  return (error?.response?.status === 403 || error?.statusCode === 403);
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

export async function annotateImage(
  filePath: string,
  grokApiKey?: string,
  lastImagePath?: string,
  userId?: string,
  videoId?: string
): Promise<{ 
  tags: string[]; 
  suggested_prompts: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
}> {
  // Try Grok Vision API if API key is provided
  if (grokApiKey) {
    try {
      const grokResult = await annotateWithGrok(filePath, grokApiKey, lastImagePath, userId, videoId);
      if (grokResult) {
        return {
          tags: grokResult.tags,
          suggested_prompts: grokResult.suggested_prompts,
          is_photo_realistic: grokResult.is_photo_realistic,
          is_nsfw: grokResult.is_nsfw,
        };
      }
    } catch (error) {
      console.error('[Grok Vision] Error:', error);
    }
  } else {
    return mockAnnotateImage(filePath, lastImagePath);
  }

  // Return empty result if Grok fails or no API key
  // This will prevent gallery publishing for unanalyzed images
  return {
    tags: [],
    suggested_prompts: [],
    is_photo_realistic: undefined,
    is_nsfw: undefined,
  };
}

export async function evaluatePromptProperties(
  editedPrompt: string,
  grokApiKey?: string,
  imagePath?: string,
  originalPrompts?: string[],
  userId?: string,
  videoId?: string
): Promise<{ 
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
}> {
  // If no API key or the prompt hasn't changed, skip re-evaluation
  if (!grokApiKey || !editedPrompt) {
    return {
      is_photo_realistic: undefined,
      is_nsfw: undefined,
    };
  }

  // Check if prompt was actually edited (different from suggestions)
  if (originalPrompts && originalPrompts.some(p => p === editedPrompt)) {
    return {
      is_photo_realistic: undefined,
      is_nsfw: undefined,
    };
  }

  try {
    const result = await evaluatePromptWithGrok(editedPrompt, grokApiKey, imagePath, userId, videoId);
    if (result) {
      return {
        is_photo_realistic: result.is_photo_realistic,
        is_nsfw: result.is_nsfw,
      };
    }
  } catch (error) {
    console.error('[Grok Vision] Prompt evaluation error:', error);
  }

  return {
    is_photo_realistic: undefined,
    is_nsfw: undefined,
  };
}

async function annotateWithGrok(
  imageUrl: string,
  apiKey: string,
  lastImageUrl?: string,
  userId?: string,
  videoId?: string
): Promise<GrokVisionResponse | null> {
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
    const xaiProvider = createXai({ apiKey });
    const model = xaiProvider(GROK_VERSION);
    
    const messageContent: Array<{ type: 'text' | 'image'; text?: string; image?: string }> = [
      {
        type: 'text',
        text: isFL2V 
          ? 'Analyze these two images (first frame and last frame). Generate SHORT prompts describing the TRANSITION between them and tag only the characters/subjects, not the environment.'
          : 'Analyze this image. Generate SHORT motion prompts and tag only the characters/subjects, not the environment.',
      },
      {
        type: 'image',
        image: imageUrl,
      },
    ];
    
    // Add second image for FL2V
    if (isFL2V && lastImageUrl) {
      messageContent.push({
        type: 'image',
        image: lastImageUrl,
      });
    }
    
    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: messageContent,
        },
      ],
      temperature: 0.7,
    });

    // Parse JSON response
    // Remove markdown code blocks if present
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '');
    }

    let parsed: GrokVisionResponse;
    try {
      // Try parsing as-is first
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      // If parsing fails, try repairing the JSON
      const repairedStr = repairIncompleteJson(jsonStr);
      try {
        parsed = JSON.parse(repairedStr);
      } catch (repairError) {
        console.error('[Grok Vision] JSON parse error:', repairError);
        console.error('[Grok Vision] Failed to parse:', repairedStr);
        return null;
      }
    }

    // Validate response structure
    if (
      !Array.isArray(parsed.suggested_prompts) ||
      !Array.isArray(parsed.tags) ||
      typeof parsed.is_photo_realistic !== 'boolean' ||
      typeof parsed.is_nsfw !== 'boolean'
    ) {
      console.error('[Grok Vision] Invalid response structure:', parsed);
      return null;
    }

    // Ensure exactly 2 prompts (take first 2 if more are provided)
    const result: GrokVisionResponse = {
      suggested_prompts: [parsed.suggested_prompts[0], parsed.suggested_prompts[1]],
      tags: parsed.tags,
      is_photo_realistic: parsed.is_photo_realistic,
      is_nsfw: parsed.is_nsfw,
    };

    return result;
  } catch (error) {
    console.error('[Grok Vision] Request failed:', error);
    
    // Log policy violations for audit
    if (isPolicyViolationError(error)) {
      logPolicyViolation('annotateImage', error, {
        user_id: userId,
        video_id: videoId,
        imageUrl,
        lastImageUrl,
        mode: isFL2V ? 'FL2V (first-last-to-video)' : 'I2V (image-to-video)',
        grok_version: GROK_VERSION,
      });
    }
    
    return null;
  }
}

async function evaluatePromptWithGrok(
  prompt: string,
  apiKey: string,
  imagePath?: string,
  userId?: string,
  videoId?: string
): Promise<{ is_photo_realistic: boolean | undefined; is_nsfw: boolean } | null> {
  const evaluationPrompt = `Analyze the following video generation prompt in context with the provided image and determine two properties:

1. is_photo_realistic: Whether the prompt describes a photographic/realistic scene (true) or artistic/illustrated scene (false)
2. is_nsfw: Whether the prompt contains or describes NSFW content (true) or is safe (false)

Prompt: "${prompt}"

Return ONLY a JSON object with these two boolean properties. Example:
{"is_photo_realistic": true, "is_nsfw": false}`;

  try {
    const xaiProvider = createXai({ apiKey });
    const model = xaiProvider(GROK_VERSION);

    const messageContent: Array<{ type: 'text' | 'image'; text?: string; image?: string }> = [
      {
        type: 'text',
        text: evaluationPrompt,
      },
    ];

    // Add image if provided
    if (imagePath) {
      messageContent.push({
        type: 'image',
        image: imagePath,
      });
    }

    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: messageContent,
        },
      ],
      temperature: 0.5,
    });

    // Parse JSON response
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```\n?/g, '');
    }

    let parsed: { is_photo_realistic: boolean; is_nsfw: boolean };
    try {
      // Try parsing as-is first
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      // If parsing fails, try repairing the JSON
      const repairedStr = repairIncompleteJson(jsonStr);
      try {
        parsed = JSON.parse(repairedStr);
      } catch (repairError) {
        console.error('[Grok Vision] JSON parse error in prompt evaluation:', repairError);
        console.error('[Grok Vision] Failed to parse:', repairedStr);
        return null;
      }
    }

    // Validate response structure
    if (
      typeof parsed.is_photo_realistic !== 'boolean' ||
      typeof parsed.is_nsfw !== 'boolean'
    ) {
      console.error('[Grok Vision] Invalid response structure:', parsed);
      return null;
    }

    return parsed;
  } catch (error) {
    console.error('[Grok Vision] Prompt evaluation request failed:', error);
    
    // Log policy violations for audit
    if (isPolicyViolationError(error)) {
      logPolicyViolation('evaluatePromptProperties', error, {        user_id: userId,
        video_id: videoId,        prompt,
        imagePath,
        grok_version: GROK_VERSION,
      });
      
      // If content violates policy, assume it's NSFW
      return {
        is_photo_realistic: undefined,
        is_nsfw: true,
      };
    }
    
    return null;
  }
}

function mockAnnotateImage(
  filePath: string,
  lastImagePath?: string
): { 
  tags: string[]; 
  suggested_prompts: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
} {
  const isFL2V = !!lastImagePath;
  // Very small local stub for image recognition.
  const name = path.basename(filePath).toLowerCase();
  const tags: string[] = [];

  if (name.includes('dog') || name.includes('puppy')) tags.push('dog', 'pet', 'animal');
  if (name.includes('cat') || name.includes('kitten')) tags.push('cat', 'pet', 'animal');
  if (name.includes('beach') || name.includes('sea')) tags.push('beach', 'ocean', 'coast');
  if (name.includes('city') || name.includes('street')) tags.push('city', 'urban');

  if (tags.length === 0) {
    tags.push('photo', 'scene');
  }

  const suggested_prompts = isFL2V
    ? [
        `Smooth transition from first frame to last frame with ${tags.slice(0, 3).join(', ')}`,
        `Cinematic transformation sequence between two frames`
      ]
    : [
        `A cinematic video of ${tags.slice(0, 3).join(', ')}`,
        `Slow-motion close-up of ${tags[0]}`
      ];

  return { tags, suggested_prompts };
}
