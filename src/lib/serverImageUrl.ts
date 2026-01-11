import { env } from '$env/dynamic/private';

/**
 * Convert a proxied /image/... URL back to the original S3 URL using S3_ENDPOINT.
 * If the input is already an absolute URL, returns it unchanged.
 */
export function toOriginalUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith('/image/')) {
    const path = url.substring('/image'.length); // includes leading '/'
    const base = (env.S3_ENDPOINT || '').replace(/\/$/, '');
    if (!base) return url;
    console.log('toOriginalUrl:', url, '->', `${base}${path}`);
    return `${base}${path}`;
  }
  return url;
}
