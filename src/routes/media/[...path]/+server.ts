import type { RequestHandler } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Media proxy that maps /media/* to S3_ENDPOINT/*
 * This bypasses CORS restrictions for browser-side media loading (images and videos)
 * Supports HTTP Range requests for video streaming
 */
export const GET: RequestHandler = async ({ params, request }) => {
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

    // Forward Range header if present (for video streaming)
    const rangeHeader = request.headers.get('range');
    const fetchHeaders: HeadersInit = {};
    if (rangeHeader) {
      fetchHeaders['Range'] = rangeHeader;
    }

    // Fetch from S3
    const response = await fetch(s3Url, {
      headers: fetchHeaders
    });

    if (!response.ok && response.status !== 206) {
      throw error(response.status, `Failed to fetch image: ${response.statusText}`);
    }

    // Get content type and body
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();

    // Build response headers
    const responseHeaders: HeadersInit = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    };

    // Forward range-related headers for video streaming
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const acceptRanges = response.headers.get('accept-ranges');

    if (contentLength) {
      responseHeaders['Content-Length'] = contentLength;
    }
    if (contentRange) {
      responseHeaders['Content-Range'] = contentRange;
    }
    if (acceptRanges) {
      responseHeaders['Accept-Ranges'] = acceptRanges;
    } else {
      // Default to supporting byte ranges for video streaming
      responseHeaders['Accept-Ranges'] = 'bytes';
    }

    // Return with appropriate status code (206 for partial content, 200 otherwise)
    return new Response(arrayBuffer, {
      status: response.status === 206 ? 206 : 200,
      headers: responseHeaders
    });
  } catch (err) {
    console.error('Media proxy error:', err);
    if (err && typeof err === 'object' && 'status' in err) {
      throw err;
    }
    throw error(500, 'Failed to proxy media');
  }
};
