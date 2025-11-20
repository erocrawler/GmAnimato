import type { Actions } from './$types';
import path from 'path';
import { createVideoEntry } from '$lib/db';
import { annotateImage } from '$lib/imageRecognition';
import { uploadBufferToS3 } from '$lib/s3';
import { Buffer } from 'buffer';
import { validateAndConvertImage } from '$lib/imageValidation';
import { validateVideoEntry, formatValidationErrors } from '$lib/validation';

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

    // Run image recognition to get tags and suggested prompts (pass the S3 url so the recognizer can inspect basename)
    const annotation = await annotateImage(s3Url);

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
      status: 'uploaded',
      is_published: false
    });

    return { success: true, entry };
  }
};

