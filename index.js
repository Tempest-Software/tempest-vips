import axios from 'axios';
import aws4 from 'aws4';
import { URL } from 'url';

import config from './config.json' with { type: 'json' };
const {
  S3_BUCKET,
  AWS_REGION,
  SLACK_WEBHOOK_URL,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  KOOTENAI_API_Key,
  CPI_API_Key,
  MOSS_API_Key,
} = config;
const GROUP_BASE_URL     = "https://swd.weatherflow.com/swd/rest";

const USERS = [
  { name: 'KOOTENAI', apiKey: KOOTENAI_API_Key },
  { name: 'CPI',      apiKey: CPI_API_Key      },
  { name: 'MOSS',     apiKey: MOSS_API_Key     },
];

async function s3Call(cacheKey, method, body) {
  const endpoint = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${cacheKey}`;
  const url      = new URL(endpoint);
  const opts     = {
    host:    url.host,
    path:    url.pathname,
    method,
    service: 's3',
    region:  AWS_REGION,
    headers: {
      'Host':         url.host,
      'Content-Type': 'application/json',
      ...(method === 'PUT' && { 'Content-Length': Buffer.byteLength(body) }),
    },
    body,
  };
  aws4.sign(opts, {
    accessKeyId:     AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  });
  return axios({
    url:            endpoint,
    method:         method.toLowerCase(),
    headers:        opts.headers,
    data:           body,
    validateStatus: null,
  });
}

// — load per-user cache —
async function loadCacheFor(user) {
  const key = `${user}_stationOfflineCache.json`;
  const res = await s3Call(key, 'GET');
  if (res.status === 200) {
    const raw = res.data;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  if (res.status === 404) {
    return {};
  }
  throw new Error(`${user} cache GET failed: ${res.status}`);
}

// — save per-user cache —
async function saveCacheFor(user, cache) {
  const key = `${user}_stationOfflineCache.json`;
  const res = await s3Call(key, 'PUT', JSON.stringify(cache));
  if (res.status !== 200) {
    throw new Error(`${user} cache PUT failed: ${res.status}`);
  }
}

// — process one user’s stations —
async function processUser({ name, apiKey }) {
  if (!apiKey) {
    throw new Error(`Missing API key for user ${name}`);
  }

  // 1) fetch
  const url    = `${GROUP_BASE_URL}/stations?api_key=${apiKey}`;
  const { data, status } = await axios.get(url);
  if (status !== 200) {
    throw new Error(`HTTP ${status} fetching ${name} stations`);
  }

  // 2) load cache
  const cache      = await loadCacheFor(name);
  const newCache   = { ...cache };
  const newOffline = [];
  const recovered  = [];

  // 3) detect changes
  for (const s of data.stations) {
    const id = String(s.station_id);
    if (s.state !== 1) {
      if (cache[id] !== 'offline') {
        newOffline.push({ id, name: s.name });
      }
      newCache[id] = 'offline';
    } else if (cache[id] === 'offline') {
      recovered.push({ id, name: s.name });
      delete newCache[id];
    }
  }

  // 4) persist cache if anything changed
  if (newOffline.length || recovered.length) {
    await saveCacheFor(name, newCache);
  }

  // 5) send Slack alerts for new offline stations
  for (const { id, name: stationName } of newOffline) {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `:rotating_light: ${name} Station *${id}* (${stationName}) is *OFFLINE*!`
    });
  }

  // 6) send Slack alerts for recoveries
  for (const { id, name: stationName } of recovered) {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `:white_check_mark: ${name} Station *${id}* (${stationName}) has *RECOVERED*!`
    });
  }

  // 7) send “all online” alert when flipping from any offline → zero offline
  const prevCount = Object.keys(cache).length;
  const currCount = Object.keys(newCache).length;
  if (prevCount > 0 && currCount === 0) {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: `:tada: All ${name} stations are now *ONLINE*!`
    });
  }

  return currCount;
}

// — run all users & throw if any still offline —
async function checkAll() {
  let anyOffline = false;
  const details  = [];

  for (const userObj of USERS) {
    const offlineCount = await processUser(userObj);
    if (offlineCount > 0) {
      anyOffline = true;
      details.push(`${userObj.name}: ${offlineCount}`);
    }
  }

  if (anyOffline) {
    throw new Error(`Stations still offline: ${details.join(', ')}`);
  }

  console.log('✅ All stations for all users are online');
}

await checkAll();
