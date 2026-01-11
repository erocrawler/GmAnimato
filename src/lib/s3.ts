import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { env } from '$env/dynamic/private';

const S3_ENDPOINT = env.S3_ENDPOINT || '';
const S3_ACCESS_KEY = env.S3_ACCESS_KEY || '';
const S3_SECRET_KEY = env.S3_SECRET_KEY || '';
const S3_BUCKET = env.S3_BUCKET || '';
const S3_REGION = env.S3_REGION || 'us-east-1';

function makeClient() {
  const opts: any = {};
  if (S3_ENDPOINT) {
    opts.endpoint = S3_ENDPOINT;
    // useful for local S3-compatible endpoints like MinIO
    opts.forcePathStyle = true;
  }
  if (S3_ACCESS_KEY && S3_SECRET_KEY) {
    opts.credentials = { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY };
  }
  if (S3_REGION) {
    opts.region = S3_REGION;
  }
  return new S3Client(opts);
}

function makeUrl(key: string) {
  // Return proxy URL format: /media/{bucket}/{key}
  // This bypasses CORS issues by serving through our API
  if (S3_BUCKET) {
    return `/media/${S3_BUCKET}/${key}`;
  }
  // Fallback to relative path for local storage
  return `/uploads/${key}`;
}

function normalizeExt(ext?: string) {
  if (!ext) return '';
  return ext.replace(/^\./, '').toLowerCase();
}

export async function uploadBufferToS3(buf: Buffer, ext?: string) {
  // Fallback to local storage if S3 is not configured
  if (!S3_BUCKET) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const uploadDir = path.resolve('static', 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    const cleanExt = normalizeExt(ext);
    const name = cleanExt
      ? `${Date.now()}-${randomUUID()}.${cleanExt}`
      : `${Date.now()}-${randomUUID()}`;
    const filepath = path.join(uploadDir, name);
    await fs.writeFile(filepath, buf);

    return `/uploads/${name}`;
  }

  const client = makeClient();
  const cleanExt = normalizeExt(ext);
  const baseName = `${Date.now()}-${randomUUID()}`;
  const key = cleanExt ? `${baseName}.${cleanExt}` : baseName;

  // Detect content type from filename extension
  const detectedExt = cleanExt || key.toLowerCase().split('.').pop();
  let contentType = 'application/octet-stream';
  
  if (detectedExt === 'jpg' || detectedExt === 'jpeg') contentType = 'image/jpeg';
  else if (detectedExt === 'png') contentType = 'image/png';
  else if (detectedExt === 'webp') contentType = 'image/webp';
  else if (detectedExt === 'gif') contentType = 'image/gif';
  else if (detectedExt === 'mp4') contentType = 'video/mp4';
  else if (detectedExt === 'webm') contentType = 'video/webm';

  console.log('S3 Config:', {
    bucket: S3_BUCKET,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    contentType
  });

  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType,
  });

  try {
    const response = await client.send(cmd);
    console.log('S3 Upload Response:', response);
  } catch (err) {
    console.error('S3 Upload Error:', err);
    throw err;
  }

  return makeUrl(key);
}
