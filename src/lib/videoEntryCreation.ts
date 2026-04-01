import { createVideoEntry, getDefaultWorkflow } from '$lib/db';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';

export interface CreateVideoEntryParams {
  userId: string;
  mode: 'i2v' | 'fl2v';
  originalImageUrl: string;
  lastImageUrl?: string;
}

export interface CreateVideoEntryResult {
  success: boolean;
  entry?: any;
  error?: string;
}

/**
 * Shared logic for creating review-ready video entries.
 * Handles both new uploads and reused images.
 */
export async function createVideoEntryForReview(
  params: CreateVideoEntryParams
): Promise<CreateVideoEntryResult> {
  const { userId, mode, originalImageUrl, lastImageUrl } = params;

  try {
    // Validate field lengths
    const validationData = {
      original_image_url: originalImageUrl,
      last_image_url: lastImageUrl,
      prompt: '',
      tags: [],
      suggested_prompts: [],
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
      last_image_url: lastImageUrl,
      prompt: '',
      tags: [],
      suggested_prompts: [],
      is_photo_realistic: undefined,
      is_nsfw: undefined,
      status: 'uploaded',
      is_published: false,
      validation_metadata: {
        manual_recognition_done: false,
        revalidation_status: 'idle'
      }
    });

    return {
      success: true,
      entry
    };
  } catch (error) {
    console.error('Create video entry error:', error);
    return {
      success: false,
      error: 'Failed to create video entry'
    };
  }
}
