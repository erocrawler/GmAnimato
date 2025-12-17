import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ImageProcessResult {
  buffer: Buffer;
  format: string;
  wasConverted: boolean;
  ext: string;
  error?: string;
}

/**
 * Validates and converts an image buffer if needed.
 * - Checks size
 * - Checks if it's a valid image
 * - Converts to JPEG if not allowed format
 * Returns { buffer, format, wasConverted, filename, error }
 */
export async function validateAndConvertImage(buffer: Buffer): Promise<ImageProcessResult> {
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { buffer, format: '', wasConverted: false, ext: '', error: `file too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
  }
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch (err) {
    return { buffer, format: '', wasConverted: false, ext: '', error: 'invalid image file' };
  }
  if (!meta.format) {
    return { buffer, format: '', wasConverted: false, ext: '', error: 'unknown image format' };
  }
  if (!ALLOWED_FORMATS.has(meta.format)) {
    // Convert to JPEG
    try {
      const converted = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      if (converted.length > MAX_IMAGE_BYTES) {
        return { buffer: converted, format: 'jpeg', wasConverted: true, ext: 'jpg', error: `converted file too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
      }
      return { buffer: converted, format: 'jpeg', wasConverted: true, ext: 'jpg' };
    } catch (err) {
      return { buffer, format: '', wasConverted: false, ext: '', error: 'failed to convert image to JPEG' };
    }
  }
  const ext = meta.format;
  return { buffer, format: meta.format, wasConverted: false, ext };
}
