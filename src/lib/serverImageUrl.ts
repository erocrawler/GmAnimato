import { env } from '$env/dynamic/private';

/**
 * Convert a proxied /media/... URL back to the original S3 URL using S3_ENDPOINT.
 * If the input is already an absolute URL, returns it unchanged.
 */
export function toOriginalUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('/media/')) {
    const path = url.substring('/media'.length); // includes leading '/'
    const base = (env.S3_ENDPOINT || '').replace(/\/$/, '');
    if (!base) return url;
    console.log('toOriginalUrl:', url, '->', `${base}${path}`);
    return `${base}${path}`;
  }
  return url;
}

/**
 * Convert an absolute S3 URL to a proxied /media/... URL if it matches our S3_ENDPOINT.
 * This allows browser-side access without CORS issues.
 * If the URL doesn't match our endpoint, returns it unchanged.
 */
export function toProxiedUrl(url: string): string {
  if (!url) return url;
  
  const s3Endpoint = (env.S3_ENDPOINT || '').replace(/\/$/, '');
  if (!s3Endpoint) return url;
  
  // Check if the URL starts with our S3 endpoint
  if (url.startsWith(s3Endpoint + '/')) {
    const path = url.substring(s3Endpoint.length); // includes leading '/'
    console.log('toProxiedUrl:', url, '->', `/media${path}`);
    return `/media${path}`;
  }
  
  return url;
}
