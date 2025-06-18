import axios from 'axios';
import config from './config.json' with { type: 'json' };

import DeviceStatus from './DeviceStatus.js';
import { loadCacheFor, saveCacheFor } from './cache.js';
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
  const sensorFailureCounts = {};
  const sensorSuccessCounts = {};
  let cache     = {};
  let newCache  = {};
  let stationsData;

  const mention = alertUserIds.map(u => `<@${u}>`).join(' ');


  for (const key of SENSOR_KEYS) {
    sensorFailureCounts[key] = 0;
    sensorSuccessCounts[key] = 0;
  }

  // Get Stations
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

  // Get Cache
  try {
    cache = await loadCacheFor(name);
  } catch (err) {
    console.warn(`Could not load cache for ${name}, starting with empty:`, err.message);
    cache = {};
  }

  newCache = { ...cache };

  // Iterate over each station and fetch diagnostics
  for (const station of stationsData) {
    const id = String(station.station_id);
    const prevEntry = cache[id] || { offline: false, failures: [] };
    const wasOffline = prevEntry.offline;

    let statuses = [];
    try {
      const response = await axios.get(`${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`);

      if (response.status === 200 && Array.isArray(response.data.devices)) {
        statuses = DeviceStatus.processDevices(response.data.devices);
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }

    // Gather only devices whose sensorStatus === 'failure'
    const failuresOnly = statuses.filter(ds => ds.sensorStatus === 'failure');

    // Flatten out every “sensor key” that failed, across all devices in this station
    const currentFailures = failuresOnly.flatMap(ds => ds.failures.map(f => f.sensor));

    // Increment the global sensorFailureCounts by key
    for (const key of currentFailures) {
      if (sensorFailureCounts.hasOwnProperty(key)) {
        sensorFailureCounts[key]++;
      } else {
        sensorFailureCounts[key] = (sensorFailureCounts[key] || 0) + 1;
      }
    }

    // ALSO count “healthy” sensors (those in SENSOR_KEYS but not in currentFailures)
    for (const key of SENSOR_KEYS) {
      if (!currentFailures.includes(key)) {
        sensorSuccessCounts[key]++;
      }
    }

    const isOffline = station.state !== 1;

    // Station is online AND has new failures
    if (!isOffline && currentFailures.length) {
      newCache[id] = { offline: false, failures: currentFailures };

      const newFailures = currentFailures.filter(s => !prevEntry.failures.includes(s));

      for (const sensorKey of newFailures) {
        try {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: `:warning: ${name} Station *${id}* has sensor failure: ${sensorKey}`
          });
        } catch (slackErr) {
          console.warn(`Slack sensor‐failure post failed for station ${id}:`, slackErr.message);
        }
      }
      continue;
    }

    // Station was offline, but now is online
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

    //Station is online, no newly failing sensors, and was not offline
    if (!isOffline) {
      newCache[id] = { offline: false, failures: [] };
      continue;
    }

    // Station is offline AND was previously online
    if (!wasOffline) {
      const baseText = `${mention} :rotating_light: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) is *OFFLINE*`;
      try {
        if (currentFailures.length) {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: `${baseText} and has sensor failures: ${currentFailures.join(', ')}`
          });
        } else {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: baseText + '!'
          });
        }
      } catch (slackErr) {
        console.warn(`Slack offline post failed for station ${id}:`, slackErr.message);
      }
    }
    newCache[id] = { offline: true, failures: currentFailures };
  }

  //SAVE updated cache back to S3
  try {
    await saveCacheFor(name, newCache);
    console.log(`Saved updated cache for ${name} (entries: ${Object.keys(newCache).length})`);
  } catch (writeErr) {
    console.error(`Failed to save cache for ${name}:`, writeErr.message);
  }

  // BUILD + SEND Metrics
  const totalStations = stationsData.length;
  const offlineCount  = stationsData.filter(s => newCache[String(s.station_id)]?.offline).length;
  const onlineCount   = totalStations - offlineCount;
  const timestamp     = Math.floor(Date.now() / 1000);

  const metricLines = buildMetricLines(
    name,
    functionName,
    timestamp,
    onlineCount,
    offlineCount,
    sensorFailureCounts,
    sensorSuccessCounts
  );

  try {
    await sendMetricsBatch(metricLines);
  } catch (metricErr) {
    console.warn(`Could not send metrics for ${name}:`, metricErr.message);
  }

  return offlineCount;
}

/**
 * Loop through every “user” in USERS[], call processUser, and
 * log an error if any station remains offline.
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

// await checkAll();

// // (Optionally export processUser if you want to unit-test it from elsewhere)
// export { processUser };
