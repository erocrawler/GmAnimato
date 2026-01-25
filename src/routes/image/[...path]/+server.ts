import type { RequestHandler } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import sharp from 'sharp';

// Allowed image widths for resizing (prevents abuse and limits cache variations)
const ALLOWED_WIDTHS = [320, 480, 640, 800, 1024, 1200, 1440, 1600, 1920, 2560];

/**
 * Image resize handler for responsive image serving
 * GET /image/[...path]?w=800
 * 
 * Fetches image from S3, resizes to specified width while preserving aspect ratio,
 * and returns the resized image. Supports JPEG, PNG, WebP, AVIF with auto-format selection.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
  try {
    const s3Endpoint = env.S3_ENDPOINT;
    
    if (!s3Endpoint) {
      throw error(500, 'S3_ENDPOINT not configured');
    }

    // Get the image path from the catch-all parameter
    const imagePath = params.path;
    
    if (!imagePath) {
      throw error(400, 'Missing image path');
    }

    // Get resize width from query parameter
    const width = url.searchParams.get('w');
    
    if (!width || isNaN(Number(width))) {
      throw error(400, 'Missing or invalid width parameter');
    }

    const widthNum = parseInt(width, 10);
    
    // Validate against allowlist
    if (!ALLOWED_WIDTHS.includes(widthNum)) {
      throw error(400, `Width must be one of: ${ALLOWED_WIDTHS.join(', ')}`);
    }

    // Construct the full S3 URL
    const s3Url = `${s3Endpoint}/${imagePath}`;

    // Fetch original image from S3
    const s3Response = await fetch(s3Url);

    if (!s3Response.ok) {
      throw error(s3Response.status, `Failed to fetch image from S3: ${s3Response.statusText}`);
    }

    const contentType = s3Response.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = await s3Response.arrayBuffer();

    // Determine output format based on Accept header or content-type
    let outputFormat: 'jpeg' | 'png' | 'webp' | 'avif' = 'jpeg';
    const acceptHeader = request.headers.get('accept') || '';

    if (acceptHeader.includes('image/avif')) {
      outputFormat = 'avif';
    } else if (acceptHeader.includes('image/webp')) {
      outputFormat = 'webp';
    } else if (contentType.includes('png')) {
      outputFormat = 'png';
    } else if (contentType.includes('webp')) {
      outputFormat = 'webp';
    }

    // Resize image using sharp
    let resizedImage = sharp(new Uint8Array(imageBuffer))
      .resize(widthNum, undefined, {
        fit: 'inside', // Preserve aspect ratio
        withoutEnlargement: true, // Don't upscale small images
      });

    // Apply format-specific options
    switch (outputFormat) {
      case 'avif':
        resizedImage = resizedImage.avif({ quality: 80 });
        break;
      case 'webp':
        resizedImage = resizedImage.webp({ quality: 80 });
        break;
      case 'png':
        resizedImage = resizedImage.png({ compressionLevel: 9 });
        break;
      case 'jpeg':
      default:
        resizedImage = resizedImage.jpeg({ quality: 80 });
        break;
    }

    const resizedBuffer = await resizedImage.toBuffer();

    // Map format to content-type
    const contentTypeMap: Record<string, string> = {
      avif: 'image/avif',
      webp: 'image/webp',
      png: 'image/png',
      jpeg: 'image/jpeg',
    };

    return new Response(new Uint8Array(resizedBuffer), {
      status: 200,
      headers: {
        'Content-Type': contentTypeMap[outputFormat],
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Accept-Ranges': 'none',
      },
    });
  } catch (err) {
    console.error('Image resize error:', err);
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    throw error(500, 'Failed to resize image');
  }
};
