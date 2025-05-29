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

const functionName = 'vip-lambda-julian';

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

// ─── processUser: combine offline + sensor-failure logic ──────────────
async function processUser({ name, apiKey, alertUserIds }) {
  // 1) fetch stations
  const { data, status } = await axios.get(
    `${GROUP_BASE_URL}/stations?api_key=${apiKey}`
  );
  if (status !== 200) {
    console.warn(`HTTP ${status} fetching ${name} stations`);
    return 0;
  }

  // 2) load and prepare cache
  const cache    = await loadCacheFor(name);
  const newCache = { ...cache };
  const mention  = alertUserIds.map(u => `<@${u}>`).join(' ');

  // 3) process each station
  for (const station of data.stations) {
    const id         = String(station.station_id);
    const prevEntry  = cache[id] || { offline: false, failures: [] };
    const wasOffline = prevEntry.offline;

    // a) fetch diagnostics & compute failuresOnly
    let failuresOnly = [];
    try {
      const resp = await axios.get(
        `${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`
      );
      if (resp.status === 200 && Array.isArray(resp.data.devices)) {
        const statuses = processDevices(resp.data.devices);
        failuresOnly = statuses.filter(ds => ds.sensorStatus === 'failure');
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }

    const isOffline = station.state !== 1;
    const currentFailures = failuresOnly.flatMap(ds =>
      ds.failures.map(f => f.sensor)
    );

    // 1) ONLINE with new sensor failures
    if (!isOffline && currentFailures.length) {
      newCache[id] = { offline: false, failures: currentFailures };
      const newFailures = currentFailures.filter(
        s => !prevEntry.failures.includes(s)
      );
      for (const sensor of newFailures) {
        await axios.post(VIP_SLACK_WEBHOOK_URL, {
          text: `:warning: ${name} Station *${id}* has sensor failure: ${sensor}`
        });
      }
      continue;
    }

    // 2) RECOVERY
    if (!isOffline && wasOffline) {
      delete newCache[id];
      await axios.post(VIP_SLACK_WEBHOOK_URL, {
        text: `:white_check_mark: ${name} Station *${id}* (${station.name}) has *RECOVERED*!`,
        link_names: 1
      });
      continue;
    }

    // 3) HEALTHY ONLINE
    if (!isOffline) {
      newCache[id] = { offline: false, failures: [] };
      continue;
    }

    // 4) OFFLINE
    newCache[id] = { offline: true, failures: currentFailures };
    if (!wasOffline) {
      const base = `${mention} :rotating_light: ${name} Station *${id}* (${station.name}) is *OFFLINE*`;
      if (currentFailures.length) {
        await axios.post(VIP_SLACK_WEBHOOK_URL, {
          text: `${base} and has sensor failures: ${currentFailures.join(', ')}`
        });
      } else {
        await axios.post(VIP_SLACK_WEBHOOK_URL, {
          text: base + '!'
        });
      }
    }
  }

  // 4) persist cache
  await saveCacheFor(name, newCache);

  // 5) send metrics
  const totalStations = data.stations.length;
  const offlineCount  = Object.values(newCache).filter(e => e.offline).length;
  const onlineCount   = totalStations - offlineCount;
  const timestamp     = Math.floor(Date.now() / 1000);
  const metricLines   = buildMetricLines(
    name,
    functionName,
    timestamp,
    onlineCount,
    offlineCount
  );
  await sendMetricsBatch(metricLines);

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

// // Immediately run (for testing) and export Lambda handler
// await checkAll();
// export { processUser };
export const handler = async () => { await checkAll(); };
