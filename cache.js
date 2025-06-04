import AWS from 'aws-sdk';
import config from './config.json' with { type: 'json' };

const { S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = config;

const s3 = new AWS.S3({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

export async function loadCacheFor(userName) {
  const Key = `${userName}_stationOfflineCache.json`;

  try {
    const { Body } = await s3.getObject({ Bucket: S3_BUCKET, Key }).promise();
    const raw = JSON.parse(Body.toString());

    const cache = {};
    for (const [id, val] of Object.entries(raw)) {
      if (typeof val === 'object' && val !== null) {
        cache[id] = {
          offline: Boolean(val.offline),
          failures: Array.isArray(val.failures) ? val.failures : [],
        };
      }
    }
    
    return cache;
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.code === 'NotFound') {
      return {};
    }
    throw err;
  }
}

export async function saveCacheFor(userName, cache) {
  const Key = `${userName}_stationOfflineCache.json`;
  await s3.putObject({
    Bucket:      S3_BUCKET,
    Key,
    Body:        JSON.stringify(cache, null, 2),
    ContentType: 'application/json',
  }).promise();
}
