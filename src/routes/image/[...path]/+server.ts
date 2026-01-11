import type { RequestHandler } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Image proxy that maps /image/* to S3_ENDPOINT/*
 * This bypasses CORS restrictions for browser-side image loading
 */
export const GET: RequestHandler = async ({ params }) => {
  try {
    const s3Endpoint = env.S3_ENDPOINT;
    
    if (!s3Endpoint) {
      throw error(500, 'S3_ENDPOINT not configured');
    }

    // Get the full path from the catch-all parameter
    const imagePath = params.path;
    
    if (!imagePath) {
      throw error(400, 'Missing image path');
    }

    // Construct the full S3 URL
    const s3Url = `${s3Endpoint}/${imagePath}`;

    // Fetch from S3
    const response = await fetch(s3Url);

    if (!response.ok) {
      throw error(response.status, `Failed to fetch image: ${response.statusText}`);
    }

    // Get content type and body
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();

    // Return with CORS headers
    return new Response(arrayBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET',
      }
    });
  } catch (err) {
    console.error('Image proxy error:', err);
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    throw error(500, 'Failed to proxy image');
  }
};
