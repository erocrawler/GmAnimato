import { describe, expect, it } from 'vitest';
import { isSafeMediaPath, normalizeMediaRef } from '../src/lib/mediaPath';

describe('media path safety', () => {
  it('accepts in-site /media paths and absolute urls pointing at /media', () => {
    expect(isSafeMediaPath('/media/bucket/1700000000-abc.mp4')).toBe(true);
    expect(normalizeMediaRef('/media/wan/out_01.mp4')).toBe('/media/wan/out_01.mp4');
    expect(normalizeMediaRef('https://animato.gmgard.moe/media/wan/a.mp4')).toBe('/media/wan/a.mp4');
    expect(normalizeMediaRef('  /media/wan/a.mp4 ')).toBe('/media/wan/a.mp4');
  });

  it('rejects external urls, traversal, encoding, queries and odd schemes', () => {
    for (const bad of [
      'https://evil.example/video.mp4', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd',
      '//evil.example/media/x', '/media/../secret', '/media/a/../../b', '/media/%2e%2e/x', '/media/a?x=1', '/media/a#f',
      '/media/', '/media', '/medias/x', 'media/x', '/media/a b.mp4', '/media/a//b.mp4', '/media/./x', '',
      '/media/' + 'a'.repeat(400),
    ]) {
      expect(normalizeMediaRef(bad), bad).toBeNull();
    }
    expect(normalizeMediaRef(undefined)).toBeNull();
    expect(normalizeMediaRef({ a: 1 })).toBeNull();
  });
});
