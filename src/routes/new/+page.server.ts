import type { Actions, PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { createVideoEntry } from '$lib/db';
import { annotateImage } from '$lib/imageRecognition';
import { uploadBufferToS3 } from '$lib/s3';
import { Buffer } from 'buffer';
import { validateAndConvertImage } from '$lib/imageValidation';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    throw redirect(303, '/login');
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    if (!locals.user) return { error: 'unauthenticated' };
    const form = await request.formData();
    const file = form.get('image') as File | null;
    const prompt = form.get('prompt')?.toString() || '';

    if (!file) return { error: 'no file' };

    const arrayBuffer = await file.arrayBuffer();
    let buffer: Buffer<ArrayBufferLike> = Buffer.from(arrayBuffer);

    const result = await validateAndConvertImage(buffer);
    if (result.error) {
      return { error: result.error };
    }
    buffer = result.buffer;
    const finalName = result.filename;

    // Upload to S3; helper returns a public URL
    const s3Url = await uploadBufferToS3(buffer, finalName);

    // Run image recognition to get tags and suggested prompts
    // Pass Grok API key if configured
    const grokApiKey = env.GROK_API_KEY;
    const annotation = await annotateImage(s3Url, grokApiKey);

    // Check if image recognition failed (empty tags means it failed)
    const recognitionFailed = annotation.tags.length === 0;

    // Validate field lengths before creating entry
    const validationErrors = validateVideoEntry({
      original_image_url: s3Url,
      prompt: '',
      tags: annotation.tags,
      suggested_prompts: annotation.suggested_prompts,
    });

    if (validationErrors.length > 0) {
      return { error: formatValidationErrors(validationErrors) };
    }

    const entry = await createVideoEntry({
      user_id: locals.user.id,
      original_image_url: s3Url,
      prompt: '',
      tags: annotation.tags,
      suggested_prompts: annotation.suggested_prompts,
      is_photo_realistic: annotation.is_photo_realistic,
      is_nsfw: annotation.is_nsfw,
      status: 'uploaded',
      is_published: false
    });

    return { success: true, entry, recognitionFailed };
  }
};

