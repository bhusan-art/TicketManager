import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import type { Config } from '../config.js';

export async function connectMongo(url: string) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(url, { serverSelectionTimeoutMS: 10_000 });
  return mongoose.connection;
}

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

export function createS3(config: Config) {
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  });
}

/** Creates the uploads bucket on first start so a fresh machine needs no manual step. */
export async function ensureBucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) throw err;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export const checks = {
  mongo: () => async () => {
    const db = mongoose.connection.db;
    if (!db) return false;
    await db.admin().ping();
    return true;
  },
  redis: (redis: Redis) => async () => (await redis.ping()) === 'PONG',
  storage: (s3: S3Client, bucket: string) => async () => {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  },
};
