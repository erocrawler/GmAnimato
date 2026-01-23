import path from 'path';
import { createXai } from '@ai-sdk/xai';
import { generateText } from 'ai';

interface GrokVisionResponse {
  suggested_prompts: [string, string]; // [normal, dramatic]
  tags: string[];
  is_photo_realistic: boolean;
  is_nsfw: boolean;
}

const GROK_VERSION = 'grok-4-1-fast-non-reasoning';

export async function annotateImage(
  filePath: string,
  grokApiKey?: string,
  lastImagePath?: string
): Promise<{ 
  tags: string[]; 
  suggested_prompts: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
}> {
  // Try Grok Vision API if API key is provided
  if (grokApiKey) {
    try {
      const grokResult = await annotateWithGrok(filePath, grokApiKey, lastImagePath);
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
  originalPrompts?: string[]
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
    const result = await evaluatePromptWithGrok(editedPrompt, grokApiKey, imagePath);
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
  lastImageUrl?: string
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
    console.log(`[Grok Vision] Sending ${isFL2V ? 'FL2V (two images)' : 'I2V (single image)'} for analysis:`, imageUrl);
    
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
    
    // Remove trailing commas that break JSON parsing (e.g., ["a", "b",])
    jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');

    let parsed: GrokVisionResponse;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('[Grok Vision] JSON parse error:', parseError);
      console.error('[Grok Vision] Failed to parse:', jsonStr);
      return null;
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
    return null;
  }
}

async function evaluatePromptWithGrok(
  prompt: string,
  apiKey: string,
  imagePath?: string
): Promise<{ is_photo_realistic: boolean; is_nsfw: boolean } | null> {
  const evaluationPrompt = `Analyze the following video generation prompt in context with the provided image and determine two properties:

1. is_photo_realistic: Whether the prompt describes a photographic/realistic scene (true) or artistic/illustrated scene (false)
2. is_nsfw: Whether the prompt contains or describes NSFW content (true) or is safe (false)

Prompt: "${prompt}"

Return ONLY a JSON object with these two boolean properties. Example:
{"is_photo_realistic": true, "is_nsfw": false}`;

  try {
    const xaiProvider = createXai({ apiKey });
    const model = xaiProvider(GROK_VERSION);
    console.log('[Grok Vision] Re-evaluating prompt properties for edited prompt');

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
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error('[Grok Vision] JSON parse error in prompt evaluation:', parseError);
      console.error('[Grok Vision] Failed to parse:', jsonStr);
      return null;
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
