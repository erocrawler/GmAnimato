import type { Actions, PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { uploadBufferToS3 } from '$lib/s3';
import { Buffer } from 'buffer';
import { validateAndConvertImage } from '$lib/imageValidation';
import { createVideoEntryWithRecognition } from '$lib/videoEntryCreation';

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

      // Create video entry with image recognition
      const result = await createVideoEntryWithRecognition({
        userId: locals.user.id,
        mode: 'fl2v',
        originalImageUrl: firstS3Url,
        lastImageUrl: lastS3Url
      });

      if (!result.success) {
        return { error: result.error };
      }

      return { success: true, entry: result.entry, recognitionFailed: result.recognitionFailed };
    } else {
      // Handle I2V mode with single image
      const file = form.get('image') as File | null;

      if (!file) return { error: 'no file' };

      const arrayBuffer = await file.arrayBuffer();
      let buffer: Buffer<ArrayBufferLike> = Buffer.from(arrayBuffer);

      const validationResult = await validateAndConvertImage(buffer);
      if (validationResult.error) {
        return { error: validationResult.error };
      }
      buffer = validationResult.buffer;
      const ext = validationResult.ext || undefined;

      // Upload to S3; helper returns a public URL
      const s3Url = await uploadBufferToS3(buffer, ext);

      // Create video entry with image recognition
      const result = await createVideoEntryWithRecognition({
        userId: locals.user.id,
        mode: 'i2v',
        originalImageUrl: s3Url
      });

      if (!result.success) {
        return { error: result.error };
      }

      return { success: true, entry: result.entry, recognitionFailed: result.recognitionFailed };
    }
  }
};

