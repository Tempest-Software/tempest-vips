import axios from 'axios';
import aws4 from 'aws4';
import { URL } from 'url';

const BUCKET            = process.env.S3_BUCKET;
const REGION            = process.env.AWS_REGION;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const GROUP_BASE_URL    = "https://swd.weatherflow.com/swd/rest";
const USERS             = ['KOOTENAI', 'CPI', 'MOSS'];

// — low-level signed S3 call —
async function s3Call(cacheKey, method, body) {
  const endpoint = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${cacheKey}`;
  const url      = new URL(endpoint);
  const opts     = {
    host:    url.host,
    path:    url.pathname,
    method,
    service: 's3',
    region:  REGION,
    headers: {
      'Host':         url.host,
      'Content-Type': 'application/json',
      ...(method === 'PUT' && { 'Content-Length': Buffer.byteLength(body) }),
    },
    body,
  };
  aws4.sign(opts, {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
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
    return {}; // no cache yet
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
async function processUser(user) {
  // fetch
  const apiKey = process.env[`${user}_API_Key`];
  const url    = `${GROUP_BASE_URL}/stations?api_key=${apiKey}`;
  const { data, status } = await axios.get(url);
  if (status !== 200) {
    throw new Error(`HTTP ${status} fetching ${user} stations`);
  }

  // load cache
  const cache      = await loadCacheFor(user);
  const newCache   = { ...cache };
  const newOffline = [];
  const recovered  = [];

  // detect changes
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

  // persist if changed
  if (newOffline.length || recovered.length) {
    await saveCacheFor(user, newCache);
  }

  // Slack: new offline
  for (const { id, name } of newOffline) {
    // await axios.post(SLACK_WEBHOOK_URL, {
    //   text: `:rotating_light: ${user} Station *${id}* (${name}) is *OFFLINE*!`
    // });
    console.log(`:rotating_light: ${user} Station *${id}* (${name}) is *OFFLINE*!`);
  }

  // Slack: recoveries
  for (const { id, name } of recovered) {
    // await axios.post(SLACK_WEBHOOK_URL, {
    //   text: `:white_check_mark: ${user} Station *${id}* (${name}) has *RECOVERED*!`
    // });
    console.log(`:white_check_mark: ${user} Station *${id}* (${name}) has *RECOVERED*!`);
  }

  // Slack: all-online alert
  const prevCount = Object.keys(cache).length;
  const currCount = Object.keys(newCache).length;
  if (prevCount > 0 && currCount === 0) {
    // await axios.post(SLACK_WEBHOOK_URL, {
    //   text: `:tada: All ${user} stations are now *ONLINE*!`
    // });
    console.log(`:tada: All ${user} stations are now *ONLINE*!`);
  }

  return currCount;
}

// — run for all users & fail if any still offline —
async function checkAll() {
  let anyOffline = false;
  const details  = [];

  for (const user of USERS) {
    const count = await processUser(user);
    if (count > 0) {
      anyOffline = true;
      details.push(`${user}: ${count}`);
    }
  }

  if (anyOffline) {
    throw new Error(`Stations still offline: ${details.join(', ')}`);
  }

  console.log('✅ All stations for all users are online');
}

await checkAll();
