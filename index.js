import axios from 'axios';
import config from './config.json' with { type: 'json' };
import DeviceStatus from './DeviceStatus.js';
import { loadCacheFor, saveCacheFor, buildStationCacheEntry } from './cache.js';
import { buildMetricLines, sendMetricsBatch } from './metrics.js';
import { Slack } from './Slack.js';

const slack = new Slack(config.VIP_SLACK_WEBHOOK_URL);

const {
  KOOTENAI_API_Key,
  CPI_API_Key,
  MOSS_API_Key,
  CALPINE_API_Key,
  PROLOGIS_API_Key,
  ALABAMAPOWER_API_Key,
  BLACHLY_API_Key,
  JOEMC_API_Key,
  BENTON_API_Key
} = config;

const GROUP_BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const functionName = 'vip-lambda-julian';

// User definitions
const USERS = [
  { name: 'KOOTENAI',      apiKey: KOOTENAI_API_Key,     alertUserIds: ['UQJLHM6LV'], alertsOn: true  },
  { name: 'CPI',           apiKey: CPI_API_Key,          alertUserIds: ['UQJLHM6LV'], alertsOn: true  },
  { name: 'MOSS',          apiKey: MOSS_API_Key,         alertUserIds: ['U10DNQSBV'], alertsOn: true  },
  { name: 'CALPINE',       apiKey: CALPINE_API_Key,      alertUserIds: ['U06DYM1QMNK'], alertsOn: true  },
  { name: 'PROLOGIS',      apiKey: PROLOGIS_API_Key,     alertsOn: false },
  { name: 'ALABAMA_POWER', apiKey: ALABAMAPOWER_API_Key, alertsOn: false },
  { name: 'BLACHLY_LANE',  apiKey: BLACHLY_API_Key,      alertsOn: false },
  { name: 'JOEMC',         apiKey: JOEMC_API_Key,        alertsOn: false },
  { name: 'BENTON_REA',    apiKey: BENTON_API_Key,       alertsOn: false }
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

// Process one user's stations
async function processUser({ name, apiKey, alertUserIds, alertsOn }) {
  const mentions = slack.buildMentions(alertUserIds);
  const serialFailureCounts = {};
  const sensorFailureCounts = {};
  let cache = {};
  let newCache = {};
  let stationsData;

  // Initialize failure counters
  for (const key of SENSOR_KEYS) {
    sensorFailureCounts[key] = 0;
  }

  // 1) Fetch stations
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

  // 2) Load cache
  try {
    cache = await loadCacheFor(name);
  } catch (err) {
    console.warn(`Could not load cache for ${name}; starting empty:`, err.message);
    cache = {};
  }
  newCache = { ...cache };

  let healthyCount = 0;
  let offlineCount = 0;

  // 3) Process each station
  for (const station of stationsData) {
    const id = String(station.station_id);
    const stationName = station.name;
    const prevEntry = cache[id] || {};
    const wasOffline = prevEntry.offline;

    // Fetch diagnostics
    let statuses = [];
    try {
      const dResp = await axios.get(`${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`);
      if (dResp.status === 200 && Array.isArray(dResp.data.devices)) {
        statuses = DeviceStatus.processDevices(dResp.data.devices);
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }

    // Identify failures
    const failuresOnly = statuses.filter(ds => ds.sensorStatus === 'failure');
    const currentFailures = failuresOnly.flatMap(ds => ds.failures.map(f => f.sensor));
    const failedSerials = new Set(failuresOnly.map(ds => ds.serial));

    // Count serial failures once per device
    for (const serial of failedSerials) {
      serialFailureCounts[serial] = (serialFailureCounts[serial] || 0) + 1;
    }

    const isOffline = station.state !== 1;

    // Count sensor failures for offline stations
    if (isOffline) {
      for (const ds of failuresOnly) {
        for (const f of ds.failures) {
          sensorFailureCounts[f.sensor] = (sensorFailureCounts[f.sensor] || 0) + 1;
        }
      }
      offlineCount++;
    }

    // Count healthy stations
    if (!isOffline && currentFailures.length === 0) {
      healthyCount++;
    }

    // A) Unhealthy but online
    if (!isOffline && currentFailures.length) {
      newCache[id] = buildStationCacheEntry(statuses, isOffline);
      const oldFailures = Array.isArray(prevEntry.failures)
        ? prevEntry.failures
        : Object.values(prevEntry)
            .filter(v => v.failures)
            .flatMap(v => v.failures);
      const newFailures = currentFailures.filter(s => !oldFailures.includes(s));

      if (alertsOn && newFailures.length) {
        const deviceFailuresMap = {};
        for (const ds of failuresOnly) {
          const newDeviceFailures = ds.failures
            .map(f => f.sensor)
            .filter(sensor => newFailures.includes(sensor));
          if (newDeviceFailures.length) {
            deviceFailuresMap[ds.serial] = newDeviceFailures;
          }
        }
        for (const sensors of Object.values(deviceFailuresMap)) {
          await slack.sendSensorFailureAlert(mentions, name, id, stationName, sensors);
        }
      }
      continue;
    }

    // B) Recovered
    if (!isOffline && wasOffline) {
      delete newCache[id];
      if (alertsOn) {
        await slack.sendRecoveryAlert(name, id, stationName);
      }
      continue;
    }

    // C) Healthy and online
    if (!isOffline) {
      newCache[id] = buildStationCacheEntry(statuses, isOffline);
      continue;
    }

    // D) Just went offline
    if (!wasOffline) {
      if (alertsOn) {
        await slack.sendOfflineAlert(mentions, name, id, stationName, currentFailures);
      }
    }

    // Offline fallback (ensure cache updated)
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
  const timestamp = Math.floor(Date.now() / 1000);
  const metricLines = buildMetricLines(
    name,
    functionName,
    timestamp,
    healthyCount,
    offlineCount,
    totalStations,
    sensorFailureCounts
  );
  try {
    await sendMetricsBatch(metricLines);
  } catch {}

  return offlineCount;
}

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

export const handler = async () => {
  await checkAll();
};

await checkAll();