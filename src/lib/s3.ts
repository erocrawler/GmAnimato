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
  if (S3_ENDPOINT) {
    const base = S3_ENDPOINT.replace(/\/$/, '');
    return `${base}/${S3_BUCKET}/${key}`;
  }
  // default AWS URL
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

export async function uploadBufferToS3(buf: Buffer, filename?: string) {
  // Fallback to local storage if S3 is not configured
  if (!S3_BUCKET) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const uploadDir = path.resolve('static', 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    const name = (filename || `${Date.now()}-${randomUUID()}`).replace(/[^A-Za-z0-9._-]/g, '_');
    const filepath = path.join(uploadDir, name);
    await fs.writeFile(filepath, buf);

    return `/uploads/${name}`;
  }

  const client = makeClient();
  const key = (filename || `${Date.now()}-${randomUUID()}`).replace(/[^A-Za-z0-9._-]/g, '_');

  console.log('S3 Config:', {
    bucket: S3_BUCKET,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    hasAccessKey: !!S3_ACCESS_KEY,
    hasSecretKey: !!S3_SECRET_KEY
  });

  const cmd = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buf,
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
