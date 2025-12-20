import type { Actions, PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { createVideoEntry, getDefaultWorkflow } from '$lib/db';
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
    const mode = form.get('mode')?.toString() || 'i2v';
    
    if (mode === 'fl2v') {
      // Handle FL2V mode with two images
      const firstFile = form.get('first_image') as File | null;
      const lastFile = form.get('last_image') as File | null;

      if (!firstFile || !lastFile) return { error: 'missing files' };

      // Process first image
      const firstArrayBuffer = await firstFile.arrayBuffer();
      let firstBuffer: Buffer<ArrayBufferLike> = Buffer.from(firstArrayBuffer);
      const firstResult = await validateAndConvertImage(firstBuffer);
      if (firstResult.error) {
        return { error: `First image: ${firstResult.error}` };
      }
      firstBuffer = firstResult.buffer;
      const firstExt = firstResult.ext || undefined;

      // Process last image
      const lastArrayBuffer = await lastFile.arrayBuffer();
      let lastBuffer: Buffer<ArrayBufferLike> = Buffer.from(lastArrayBuffer);
      const lastResult = await validateAndConvertImage(lastBuffer);
      if (lastResult.error) {
        return { error: `Last image: ${lastResult.error}` };
      }
      lastBuffer = lastResult.buffer;
      const lastExt = lastResult.ext || undefined;

      // Upload both images to S3
      const firstS3Url = await uploadBufferToS3(firstBuffer, firstExt);
      const lastS3Url = await uploadBufferToS3(lastBuffer, lastExt);

      // Run image recognition on both images (FL2V mode)
      const grokApiKey = env.GROK_API_KEY;
      const annotation = await annotateImage(firstS3Url, grokApiKey, lastS3Url);
      const recognitionFailed = annotation.tags.length === 0;

      // Validate field lengths before creating entry
      const validationErrors = validateVideoEntry({
        original_image_url: firstS3Url,
        last_image_url: lastS3Url,
        prompt: '',
        tags: annotation.tags,
        suggested_prompts: annotation.suggested_prompts,
      });

      if (validationErrors.length > 0) {
        return { error: formatValidationErrors(validationErrors) };
      }

      // Get default FL2V workflow
      const defaultWorkflow = await getDefaultWorkflow('fl2v');
      console.log('[New Video] FL2V - Using workflow:', defaultWorkflow?.id, defaultWorkflow?.name);

      const entry = await createVideoEntry({
        user_id: locals.user.id,
        workflow_id: defaultWorkflow?.id,
        original_image_url: firstS3Url,
        last_image_url: lastS3Url,
        prompt: '',
        tags: annotation.tags,
        suggested_prompts: annotation.suggested_prompts,
        is_photo_realistic: annotation.is_photo_realistic,
        is_nsfw: annotation.is_nsfw,
        status: 'uploaded',
        is_published: false
      });

      return { success: true, entry, recognitionFailed };
    } else {
      // Handle I2V mode with single image
      const file = form.get('image') as File | null;

      if (!file) return { error: 'no file' };

      const arrayBuffer = await file.arrayBuffer();
      let buffer: Buffer<ArrayBufferLike> = Buffer.from(arrayBuffer);

      const result = await validateAndConvertImage(buffer);
      if (result.error) {
        return { error: result.error };
      }
      buffer = result.buffer;
      const ext = result.ext || undefined;

      // Upload to S3; helper returns a public URL
      const s3Url = await uploadBufferToS3(buffer, ext);

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

      // Get default I2V workflow
      const defaultWorkflow = await getDefaultWorkflow('i2v');
      console.log('[New Video] I2V - Using workflow:', defaultWorkflow?.id, defaultWorkflow?.name);

      const entry = await createVideoEntry({
        user_id: locals.user.id,
        workflow_id: defaultWorkflow?.id,
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
  }
};

