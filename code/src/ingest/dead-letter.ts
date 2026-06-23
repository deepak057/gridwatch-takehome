import { pool } from '../db/pool';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

function buildS3Client(endpoint: string): S3Client {
  return new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
}

function makeKey(reason: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = reason.replace(/[^a-z0-9]/gi, '-').slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dead-letter/${ts}-${slug}-${rand}.json`;
}

async function writeToTable(payload: any, reason: string): Promise<void> {
  await pool.query(
    `INSERT INTO dead_letter (payload, reason) VALUES ($1, $2)`,
    [JSON.stringify(payload), reason],
  );
}

export async function deadLetter(payload: any, reason: string): Promise<void> {
  const bucket = process.env.S3_DEAD_LETTER_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;

  if (bucket && endpoint) {
    try {
      const client = buildS3Client(endpoint);
      const key = makeKey(reason);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify({ payload, reason, ts: new Date().toISOString() }),
          ContentType: 'application/json',
        }),
      );
      return;
    } catch {
      // S3 unavailable — fall through to table
    }
  }

  await writeToTable(payload, reason);
}
