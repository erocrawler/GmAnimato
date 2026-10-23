import { describe, expect, it } from 'vitest';
import { isCrossSiteFormSubmission, isFormContentType } from '../src/lib/csrf';

const ORIGIN = 'https://animato.example';
const req = (method: string, headers: Record<string, string>) => ({ method, headers: new Headers(headers) });

describe('csrf origin check (replacement for SvelteKit csrf.checkOrigin)', () => {
  it('recognises the form content types SvelteKit protects', () => {
    for (const t of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', 'Multipart/Form-Data']) {
      expect(isFormContentType(t)).toBe(true);
    }
    expect(isFormContentType('application/json')).toBe(false);
    expect(isFormContentType(null)).toBe(false);
  });

  it('blocks cross-site and origin-less form posts', () => {
    expect(isCrossSiteFormSubmission(req('POST', { 'content-type': 'multipart/form-data; boundary=x', origin: 'https://evil.example' }), ORIGIN)).toBe(true);
    expect(isCrossSiteFormSubmission(req('POST', { 'content-type': 'multipart/form-data; boundary=x' }), ORIGIN)).toBe(true);
    expect(isCrossSiteFormSubmission(req('DELETE', { 'content-type': 'text/plain', origin: 'http://animato.example' }), ORIGIN)).toBe(true);
  });

  it('allows same-origin forms, JSON bodies and safe methods', () => {
    expect(isCrossSiteFormSubmission(req('POST', { 'content-type': 'multipart/form-data', origin: ORIGIN }), ORIGIN)).toBe(false);
    expect(isCrossSiteFormSubmission(req('POST', { 'content-type': 'application/json', origin: 'https://evil.example' }), ORIGIN)).toBe(false);
    expect(isCrossSiteFormSubmission(req('GET', { 'content-type': 'multipart/form-data' }), ORIGIN)).toBe(false);
  });

  it('is skipped in dev, like SvelteKit', () => {
    expect(isCrossSiteFormSubmission(req('POST', { 'content-type': 'multipart/form-data' }), ORIGIN, { dev: true })).toBe(false);
  });
});
