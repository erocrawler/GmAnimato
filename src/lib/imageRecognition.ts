import path from 'path';
import { createXai } from '@ai-sdk/xai';
import { generateText } from 'ai';

interface GrokVisionResponse {
  suggested_prompts: [string, string]; // [normal, dramatic]
  tags: string[];
  is_photo_realistic: boolean;
  is_nsfw: boolean;
}

export async function annotateImage(
  filePath: string,
  grokApiKey?: string
): Promise<{ 
  tags: string[]; 
  suggested_prompts: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
}> {
  // Try Grok Vision API if API key is provided
  if (grokApiKey) {
    try {
      const grokResult = await annotateWithGrok(filePath, grokApiKey);
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
    return mockAnnotateImage(filePath);
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

async function annotateWithGrok(
  imageUrl: string,
  apiKey: string
): Promise<GrokVisionResponse | null> {
  const systemPrompt = `You are an expert image analyzer for an AI image-to-video generation system. Analyze the provided image and return a JSON object with:

1. suggested_prompts: Array with exactly 2 Image to Video generation prompts. They are concise and optimized for a 6-second AI video. They should start with the exact scene in the image:
   - First prompt: A straightforward description focusing on motion, camera movement, and what should happen in the video.
   - Second prompt: A more cinematic/dramatic version intensifying the motion but still fit the short duration.
   
2. tags: Array of booru-style tags describing the visual elements (e.g., "1girl", "solo", "outdoors", "blue_sky", "smile", "nature", "landscape", etc.)

3. is_photo_realistic: Boolean indicating if the image is photographic/realistic or artistic/illustrated

4. is_nsfw: Boolean indicating if the image contains NSFW content

IMPORTANT: The prompts should describe VIDEO MOTION and CAMERA MOVEMENT, not just describe what's in the static image. Think about how to bring this image to life with motion, camera work, and atmosphere.

Return ONLY valid JSON, no other text.`;

  try {
    const xaiProvider = createXai({ apiKey });
    const model = xaiProvider('grok-4-1-fast-non-reasoning');
    console.log('[Grok Vision] Sending image for analysis:', imageUrl);
    const { text } = await generateText({
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this image and generate video motion prompts that will bring it to life. Focus on camera movement, motion, and cinematic effects.',
            },
            {
              type: 'image',
              image: imageUrl,
            },
          ],
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

    const parsed: GrokVisionResponse = JSON.parse(jsonStr);

    // Validate response structure
    if (
      !Array.isArray(parsed.suggested_prompts) ||
      parsed.suggested_prompts.length !== 2 ||
      !Array.isArray(parsed.tags) ||
      typeof parsed.is_photo_realistic !== 'boolean' ||
      typeof parsed.is_nsfw !== 'boolean'
    ) {
      console.error('[Grok Vision] Invalid response structure:', parsed);
      return null;
    }

    console.log('[Grok Vision] Successfully analyzed image');
    return parsed;
  } catch (error) {
    console.error('[Grok Vision] Request failed:', error);
    return null;
  }
}

function mockAnnotateImage(filePath: string): { 
  tags: string[]; 
  suggested_prompts: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
} {
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

  const suggested_prompts = [
    `A cinematic video of ${tags.slice(0, 3).join(', ')}`,
    `Slow-motion close-up of ${tags[0]}`
  ];

  return { tags, suggested_prompts };
}
