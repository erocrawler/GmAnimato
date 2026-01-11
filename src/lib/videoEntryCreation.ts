import { createVideoEntry, getDefaultWorkflow } from '$lib/db';
import { annotateImage } from '$lib/imageRecognition';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';
import { toOriginalUrl } from '$lib/serverImageUrl';
import { env } from '$env/dynamic/private';

export interface CreateVideoEntryParams {
  userId: string;
  mode: 'i2v' | 'fl2v';
  originalImageUrl: string;
  lastImageUrl?: string;
}

export interface CreateVideoEntryResult {
  success: boolean;
  entry?: any;
  recognitionFailed?: boolean;
  error?: string;
}

/**
 * Shared logic for creating video entries with image recognition.
 * Handles both new uploads and reused images.
 */
export async function createVideoEntryWithRecognition(
  params: CreateVideoEntryParams
): Promise<CreateVideoEntryResult> {
  const { userId, mode, originalImageUrl, lastImageUrl } = params;

  try {
    const grokApiKey = env.GROK_API_KEY;
    
    // Convert proxy URLs to original S3 URLs for Grok
    const originalForGrok = toOriginalUrl(originalImageUrl);
    const lastForGrok = lastImageUrl ? toOriginalUrl(lastImageUrl) : undefined;

    // Run image recognition
    const annotation = mode === 'fl2v'
      ? await annotateImage(originalForGrok, grokApiKey, lastForGrok)
      : await annotateImage(originalForGrok, grokApiKey);

    const recognitionFailed = annotation.tags.length === 0;

    // Validate field lengths
    const validationData = mode === 'fl2v'
      ? {
          original_image_url: originalImageUrl,
          last_image_url: lastImageUrl,
          prompt: '',
          tags: annotation.tags,
          suggested_prompts: annotation.suggested_prompts,
        }
      : {
          original_image_url: originalImageUrl,
          prompt: '',
          tags: annotation.tags,
          suggested_prompts: annotation.suggested_prompts,
        };

    const validationErrors = validateVideoEntry(validationData);
    if (validationErrors.length > 0) {
      return {
        success: false,
        error: formatValidationErrors(validationErrors)
      };
    }

    // Get default workflow for the mode
    const defaultWorkflow = await getDefaultWorkflow(mode);
    console.log(`[Video Entry] ${mode.toUpperCase()} - Using workflow:`, defaultWorkflow?.id, defaultWorkflow?.name);

    // Create video entry
    const entry = await createVideoEntry({
      user_id: userId,
      workflow_id: defaultWorkflow?.id,
      original_image_url: originalImageUrl,
      last_image_url: mode === 'fl2v' ? lastImageUrl : undefined,
      prompt: '',
      tags: annotation.tags,
      suggested_prompts: annotation.suggested_prompts,
      is_photo_realistic: annotation.is_photo_realistic,
      is_nsfw: annotation.is_nsfw,
      status: 'uploaded',
      is_published: false
    });

    return {
      success: true,
      entry,
      recognitionFailed
    };
  } catch (error) {
    console.error('Create video entry error:', error);
    return {
      success: false,
      error: 'Failed to create video entry'
    };
  }
}
