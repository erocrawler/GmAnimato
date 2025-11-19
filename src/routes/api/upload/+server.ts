import type { RequestHandler } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';
import { validateAndConvertImage } from '$lib/imageValidation';

const UPLOAD_DIR = path.resolve('static', 'uploads');

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

export const POST: RequestHandler = async ({ request }) => {
  const form = await request.formData();
  const file = form.get('file') as File | null;
  if (!file) {
    return new Response(JSON.stringify({ error: 'no file' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  await ensureUploadDir();

  const arrayBuffer = await file.arrayBuffer();
  let buffer: Buffer<ArrayBufferLike> = Buffer.from(arrayBuffer);
  const result = await validateAndConvertImage(buffer);
  if (result.error) {
    const status = result.error.includes('too large') ? 413 : 400;
    return new Response(JSON.stringify({ error: result.error }), { status, headers: { 'Content-Type': 'application/json' } });
  }
  buffer = result.buffer;
  const filename = result.filename;
  const filepath = path.join(UPLOAD_DIR, filename);
  await fs.writeFile(filepath, buffer);

  const urlPath = `/uploads/${filename}`;

  return new Response(JSON.stringify({ url: urlPath }), { headers: { 'Content-Type': 'application/json' } });
};
