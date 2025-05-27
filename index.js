import axios from 'axios';
import AWS   from 'aws-sdk';
import config from './config.json' with { type: 'json' };
import { buildMetricLines, sendMetricsBatch } from './metrics.js';

const {
  S3_BUCKET,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  VIP_SLACK_WEBHOOK_URL,
  KOOTENAI_API_Key,
  CPI_API_Key,
  MOSS_API_Key,
} = config;

const GROUP_BASE_URL = 'https://swd.weatherflow.com/swd/rest';

const s3 = new AWS.S3({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const USERS = [
  { name: 'KOOTENAI', apiKey: KOOTENAI_API_Key, alertUserIds: ['UQJLHM6LV'] },
  { name: 'CPI',     apiKey: CPI_API_Key,     alertUserIds: ['UQJLHM6LV'] },
  { name: 'MOSS',    apiKey: MOSS_API_Key,    alertUserIds: ['U10DNQSBV'] },
];

const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME || 'vip-lambda-julian';

async function loadCacheFor(user) {
  const Key = `${user}_stationOfflineCache.json`;
  try {
    const { Body } = await s3.getObject({ Bucket: S3_BUCKET, Key }).promise();
    return JSON.parse(Body.toString());
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.code === 'NotFound') return {};
    throw err;
  }
}

async function saveCacheFor(user, cache) {
  const Key = `${user}_stationOfflineCache.json`;
  await s3.putObject({
    Bucket:      S3_BUCKET,
    Key,
    Body:        JSON.stringify(cache),
    ContentType: 'application/json',
  }).promise();
}

async function processUser({ name, apiKey, alertUserIds }) {
  const url = `${GROUP_BASE_URL}/stations?api_key=${apiKey}`;
  const { data, status } = await axios.get(url);
  if (status !== 200) {
    console.warn(`HTTP ${status} fetching ${name} stations`);
    return 0;
  }

  const cache      = await loadCacheFor(name);
  const newCache   = { ...cache };
  const newOffline = [];
  const recovered  = [];

  // diff
  for (const station of data.stations) {
    const id = String(station.station_id);
    if (station.state !== 1) {
      if (cache[id] !== 'offline') newOffline.push({ id, name: station.name });
      newCache[id] = 'offline';
    } else if (cache[id] === 'offline') {
      recovered.push({ id, name: station.name });
      delete newCache[id];
    }
  }

  if (newOffline.length || recovered.length) {
    await saveCacheFor(name, newCache);
  }

  // Slack alerts
  const mention = alertUserIds.map(u => `<@${u}>`).join(' ');
  for (const { id, name: stationName } of newOffline) {
    await axios.post(VIP_SLACK_WEBHOOK_URL, {
      text: `${mention} :rotating_light: ${name} Station *${id}* (${stationName}) is *OFFLINE*!`,
      link_names: 1,
    });
  }
  for (const { id, name: stationName } of recovered) {
    await axios.post(VIP_SLACK_WEBHOOK_URL, {
      text: `:white_check_mark: ${name} Station *${id}* (${stationName}) has *RECOVERED*!`,
      link_names: 1,
    });
  }
  const prevCount = Object.keys(cache).length;
  const currCount = Object.keys(newCache).length;
  if (prevCount > 0 && currCount === 0) {
    await axios.post(VIP_SLACK_WEBHOOK_URL, {
      text: `:tada: All ${name} stations are now *ONLINE*!`,
      link_names: 1,
    });
  }

  // metrics
  const totalStations = data.stations.length;
  const offlineCount  = currCount;
  const onlineCount   = totalStations - offlineCount;
  const timestamp     = Math.floor(Date.now() / 1000);

  const metricLines = buildMetricLines(
    name,
    functionName,
    timestamp,
    onlineCount,
    offlineCount
  );
  await sendMetricsBatch(metricLines);

  return offlineCount;
}

async function checkAll() {
  let anyOffline = false;
  const details  = [];
  for (const u of USERS) {
    const cnt = await processUser(u);
    if (cnt > 0) {
      anyOffline = true;
      details.push(`${u.name}: ${cnt}`);
    }
  }
  if (anyOffline) {
    console.error(`Stations still offline: ${details.join(', ')}`);
  } else {
    console.log('✅ All stations for all users are online');
  }
}

export const handler = async () => {
  await checkAll();
};
