import axios from 'axios';
import AWS   from 'aws-sdk';
import config from './config.json' with { type: 'json' };
import DeviceStatus from './DeviceStatus.js';
import { buildMetricLines, sendMetricsBatch } from './metrics.js';

const {
  S3_BUCKET,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  TEST_SLACK_WEBHOOK_URL,
  VIP_SLACK_WEBHOOK_URL,
  KOOTENAI_API_Key,
  CPI_API_Key,
  MOSS_API_Key,
} = config;

const GROUP_BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const functionName = 'vip-lambda-julian';

const s3 = new AWS.S3({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const USERS = [
  { name: 'KOOTENAI', apiKey: KOOTENAI_API_Key, alertUserIds: ['UQJLHM6LV'] },
  { name: 'CPI',      apiKey: CPI_API_Key,     alertUserIds: ['UQJLHM6LV'] },
  { name: 'MOSS',     apiKey: MOSS_API_Key,    alertUserIds: ['U10DNQSBV'] },
];

function processDevices(devices, settings = {}, target = null) {
  return devices
    .filter(d => !d.serial_number.includes('HB'))
    .map(device => {
      const { device_id, serial_number: serial, sensor_status: rawStatus } = device;
      const deviceType = serial.split('-')[0];
      const ds = new DeviceStatus(settings, target);

      const sensorStatus = ds.findStatus(rawStatus, deviceType);

      const failures = [];
      if (sensorStatus === 'failure') {
        const defs = ds.sensors[deviceType] || [];
        for (const def of defs) {
          for (const f of def.flags) {
            if (f.type === 'error' && ds._hasSensorError(rawStatus, f.flag)) {
              failures.push({ sensor: def.label, reason: f.failedText || def.label });
            }
          }
        }
      }

      return { device_id, serial, deviceType, rawStatus, sensorStatus, failures };
    });
}

async function loadCacheFor(user) {
  const Key = `${user}_stationOfflineCache.json`;
  try {
    const { Body } = await s3.getObject({ Bucket: S3_BUCKET, Key }).promise();
    const raw = JSON.parse(Body.toString());
    const cache = {};
    for (const [id, val] of Object.entries(raw)) {
      if (typeof val === 'object' && val !== null) {
        cache[id] = {
          offline: Boolean(val.offline),
          failures: Array.isArray(val.failures) ? val.failures : []
        };
      } else {
        cache[id] = { offline: val === 'offline', failures: [] };
      }
    }
    return cache;
  } catch (err) {
    if (err.code === 'NoSuchKey' || err.code === 'NotFound') return {};
    throw err;
  }
}

// ─── saveCacheFor: write updated cache back to S3 ──────────────────────
async function saveCacheFor(user, cache) {
  const Key = `${user}_stationOfflineCache.json`;
  await s3.putObject({
    Bucket:      S3_BUCKET,
    Key,
    Body:        JSON.stringify(cache, null, 2),
    ContentType: 'application/json',
  }).promise();
}

async function processUser({ name, apiKey, alertUserIds }) {
  let cache = {};
  let newCache = {};
  let stationsData;
  const mention = alertUserIds.map(u => `<@${u}>`).join(' ');

  try {
    const response = await axios.get(`${GROUP_BASE_URL}/stations?api_key=${apiKey}`);
    if (response.status !== 200) {
      console.warn(`HTTP ${response.status} fetching ${name} stations`);
      return 0;
    }
    stationsData = response.data.stations;
  } catch (err) {
    console.warn(`Network error fetching stations for ${name}:`, err.message);
    return 0;
  }

  // 2) Load existing cache from S3 (if any)
  try {
    cache = await loadCacheFor(name);
  } catch (err) {
    console.warn(`Could not load cache for ${name}, starting with empty.`, err.message);
    cache = {};
  }
  newCache = { ...cache };

  // 3) Process each station; wrap Slack posts in try/catch, but always set newCache entry
  for (const station of stationsData) {
    const id = String(station.station_id);
    const prevEntry = cache[id] || { offline: false, failures: [] };
    const wasOffline = prevEntry.offline;

    // 3a) Fetch diagnostics for sensor failures (if any)
    let failuresOnly = [];
    try {
      const response = await axios.get(`${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`);
      if (response.status === 200 && Array.isArray(response.data.devices)) {
        const statuses = processDevices(response.data.devices);
        failuresOnly = statuses.filter(ds => ds.sensorStatus === 'failure');
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }
    const currentFailures = failuresOnly.flatMap(ds => ds.failures.map(f => f.sensor));

    const isOffline = station.state !== 1;

    // 3b) ONLINE with new sensor failures
    if (!isOffline && currentFailures.length) {
      newCache[id] = {
        offline: false,
        failures: currentFailures
      };

      // Find newly failed sensors
      const newFailures = currentFailures.filter(s => !prevEntry.failures.includes(s));
      for (const sensor of newFailures) {
        try {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: `:warning: ${name} Station *${id}* has sensor failure: ${sensor}`
          });
        } catch (slackErr) {
          console.warn(`Slack sensor-failure post failed for station ${id}:`, slackErr.message);
        }
      }
      continue;
    }

    // 3c) RECOVERY (station went from offline → online)
    if (!isOffline && wasOffline) {
      delete newCache[id];
      try {
        await axios.post(VIP_SLACK_WEBHOOK_URL, {
          text: `:white_check_mark: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) has *RECOVERED*!`,
          link_names: 1
        });
      } catch (slackErr) {
        console.warn(`Slack recovery post failed for station ${id}:`, slackErr.message);
      }
      continue;
    }

    // 3d) HEALTHY ONLINE (no offline, no new failures)
    if (!isOffline) {
      newCache[id] = { offline: false, failures: [] };
      continue;
    }

    // 3e) OFFLINE
    // If station just went offline (wasOffline === false), send Slack alert.
    if (!wasOffline) {
      const baseText = `${mention} :rotating_light: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) is *OFFLINE*`;
      try {
        if (currentFailures.length) {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: `${baseText} and has sensor failures: ${currentFailures.join(', ')}`
          });
        } else {
          await axios.post(VIP_SLACK_WEBHOOK_URL, { text: baseText + '!' });
        }
      } catch (slackErr) {
        console.warn(`Slack offline post failed for station ${id}:`, slackErr.message);
      }
    }

    newCache[id] = { offline: true, failures: currentFailures };
  }

  // 4) Persist updated cache in S3 (always run, even if earlier code threw)
  try {
    await saveCacheFor(name, newCache);
    console.log(`Saved updated cache for ${name} (entries: ${Object.keys(newCache).length})`);
  } catch (writeErr) {
    console.error(`Failed to save cache for ${name}:`, writeErr.message);
  }

  // 5) Send metrics
  const totalStations = stationsData.length;
  const offlineCount = stationsData.filter(s => newCache[String(s.station_id)]?.offline).length;
  const onlineCount = totalStations - offlineCount;
  const timestamp = Math.floor(Date.now() / 1000);
  const metricLines = buildMetricLines(name, functionName, timestamp, onlineCount, offlineCount);

  try {
    await sendMetricsBatch(metricLines);
  } catch (metricErr) {
    console.warn(`Could not send metrics for ${name}:`, metricErr.message);
  }

  return offlineCount;
}

// ─── checkAll & handler ─────────────────────────────────────────────
async function checkAll() {
  let anyOffline = false;
  const details = [];
  for (const user of USERS) {
    const cnt = await processUser(user);
    if (cnt > 0) {
      anyOffline = true;
      details.push(`${user.name}: ${cnt}`);
    }
  }
  if (anyOffline) {
    console.error(`Stations still offline: ${details.join(', ')}`);
  } else {
    console.log('✅ All stations for all users are online');
  }
}

// Immediately run (for testing) and export Lambda handler
// await checkAll();
// export { processUser };
export const handler = async () => { await checkAll(); };
