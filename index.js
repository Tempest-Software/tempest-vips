import axios from 'axios';
import config from './config.json' with { type: 'json' };

import DeviceStatus from './DeviceStatus.js';
import { loadCacheFor, saveCacheFor, buildStationCacheEntry } from './cache.js';
import { buildMetricLines, sendMetricsBatch } from './metrics.js';

const {
  VIP_SLACK_WEBHOOK_URL,
  KOOTENAI_API_Key,
  CPI_API_Key,
  MOSS_API_Key,
  CALPINE_API_Key
} = config;

const GROUP_BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const functionName = 'vip-lambda-julian';

const USERS = [
  { name: 'KOOTENAI', apiKey: KOOTENAI_API_Key, alertUserIds: ['UQJLHM6LV'] },
  { name: 'CPI',      apiKey: CPI_API_Key,     alertUserIds: ['UQJLHM6LV'] },
  { name: 'MOSS',     apiKey: MOSS_API_Key,    alertUserIds: ['U10DNQSBV'] },
  { name: 'CALPINE',  apiKey: CALPINE_API_Key, alertUserIds: ['U06DYM1QMNK'] }
];

const SENSOR_KEYS = [
  'air_temperature',
  'rh',
  'lightning',
  'wind',
  'precip',
  'light_uv',
  'pressure'
];

async function processUser({ name, apiKey, alertUserIds }) {
  const serialFailureCounts = {};
  const sensorFailureCounts = {};
  let cache = {};
  let newCache = {};
  let stationsData;

  const mention = alertUserIds.map(u => `<@${u}>`).join(' ');

  // Seed sensor counts
  for (const key of SENSOR_KEYS) {
    sensorFailureCounts[key] = 0;
  }

  // 1) Fetch stations list
  try {
    const resp = await axios.get(`${GROUP_BASE_URL}/stations?api_key=${apiKey}`);
    if (resp.status !== 200) {
      console.warn(`HTTP ${resp.status} fetching ${name} stations`);
      return 0;
    }
    stationsData = resp.data.stations;
  } catch (err) {
    console.warn(`Network error fetching stations for ${name}:`, err.message);
    return 0;
  }

  // 2) Load existing cache
  try {
    cache = await loadCacheFor(name);
  } catch (err) {
    console.warn(`Could not load cache for ${name}; starting empty:`, err.message);
    cache = {};
  }
  newCache = { ...cache };

  // 3) Process each station
  for (const station of stationsData) {
    const id = String(station.station_id);
    const prevEntry = cache[id] || {};
    const wasOffline = prevEntry.offline;

    // Fetch diagnostics
    let statuses = [];
    try {
      const dResp = await axios.get(
        `${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`
      );
      if (dResp.status === 200 && Array.isArray(dResp.data.devices)) {
        statuses = DeviceStatus.processDevices(dResp.data.devices);
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }

    // Determine failed devices and sensors
    const failuresOnly = statuses.filter(ds => ds.sensorStatus === 'failure');
    const currentFailures = failuresOnly.flatMap(ds => ds.failures.map(f => f.sensor));
    const failedSerials = new Set(failuresOnly.map(ds => ds.serial));

    // Count one per serial for serial metrics
    for (const serial of failedSerials) {
      serialFailureCounts[serial] = (serialFailureCounts[serial] || 0) + 1;
    }

    // NEW: Count every sensor failure for per-sensor metrics
    for (const ds of failuresOnly) {
      for (const f of ds.failures) {
        sensorFailureCounts[f.sensor] = (sensorFailureCounts[f.sensor] || 0) + 1;
      }
    }

    const isOffline = station.state !== 1;

    // A: online with new failures
    if (!isOffline && currentFailures.length) {
      newCache[id] = buildStationCacheEntry(statuses, isOffline);
      const oldFailures = Array.isArray(prevEntry.failures)
        ? prevEntry.failures
        : Object.values(prevEntry)
            .filter(v => v.failures)
            .flatMap(v => v.failures);
      const newFailures = currentFailures.filter(s => !oldFailures.includes(s));
      for (const sensorKey of newFailures) {
        try {
          // await axios.post(VIP_SLACK_WEBHOOK_URL, {
          //   text: `${mention} :warning: ${name} Station *${id}* has sensor failure: ${sensorKey}`
          // });
          console.log(`${mention} :warning: ${name} Station *${id}* has sensor failure: ${sensorKey}`);
        } catch {}
      }
      continue;
    }

    // B: recovered from offline
    if (!isOffline && wasOffline) {
      delete newCache[id];
      try {
        // await axios.post(VIP_SLACK_WEBHOOK_URL, {
        //   text: `:white_check_mark: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) has *RECOVERED*!`,
        //   link_names: 1
        // });
        console.log(`:white_check_mark: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) has *RECOVERED*!`);
      } catch {}
      continue;
    }

    // C: still online, no failures
    if (!isOffline) {
      newCache[id] = buildStationCacheEntry(statuses, isOffline);
      continue;
    }

    // D: just went offline
    // D: just went offline
    if (!wasOffline) {
      const baseText = `${mention} :rotating_light: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) is *OFFLINE*`;

      if (currentFailures.length) {
        // log or post with failures listed
        console.log(
          `${baseText} and has sensor failures: ${currentFailures.join(', ')}`
        );
        // await axios.post(VIP_SLACK_WEBHOOK_URL, {
        //   text: `${baseText} and has sensor failures: ${currentFailures.join(', ')}`
        // });
      } else {
        console.log(`${baseText}!`);
        // await axios.post(VIP_SLACK_WEBHOOK_URL, { text: `${baseText}!` });
      }
    }


    // offline fallback
    newCache[id] = buildStationCacheEntry(statuses, isOffline);
  }

  // 4) Save updated cache
  try {
    await saveCacheFor(name, newCache);
    console.log(`Saved cache for ${name} (${Object.keys(newCache).length} entries)`);
  } catch (err) {
    console.error(`Failed to save cache for ${name}:`, err.message);
  }

  // 5) Emit metrics
  const totalStations = stationsData.length;
  const offlineCount = stationsData.filter(s => newCache[String(s.station_id)]?.offline).length;
  const onlineCount = totalStations - offlineCount;
  const timestamp = Math.floor(Date.now() / 1000);

  const metricLines = buildMetricLines(
    name,
    functionName,
    timestamp,
    onlineCount,
    offlineCount,
    totalStations,
    sensorFailureCounts
  );
  try {
    await sendMetricsBatch(metricLines);
  } catch {}

  return offlineCount;
}

/**
 * Loop through every “user” and log if any station remains offline.
 */
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

export const handler = async () => { await checkAll(); };
await checkAll();
// export { processUser };
