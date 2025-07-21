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
  CALPINE_API_Key,
  PROLOGIS_API_Key,
  ALABAMAPOWER_API_Key,
  BLACHLY_API_Key,
  JOEMC_API_Key,
  BENTON_API_Key
} = config;

const GROUP_BASE_URL = 'https://swd.weatherflow.com/swd/rest';
const functionName   = 'vip-lambda-julian';

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

async function processUser({ name, apiKey, alertUserIds, alertsOn }) {
  const serialFailureCounts = {};
  const sensorFailureCounts = {};
  let cache    = {};
  let newCache = {};
  let stationsData;

  const mention = alertUserIds && alertUserIds.length ? alertUserIds.map(u => `<@${u}>`).join(' ') : '';

  // seed per-sensor failure map
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

  // 2) Load S3 cache
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

    // fetch diagnostics
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

    // identify failures
    const failuresOnly = statuses.filter(ds => ds.sensorStatus === 'failure');
    const currentFailures = failuresOnly.flatMap(ds => ds.failures.map(f => f.sensor));
    const failedSerials = new Set(failuresOnly.map(ds => ds.serial));

    // count one failure per serial
    for (const serial of failedSerials) {
      serialFailureCounts[serial] = (serialFailureCounts[serial] || 0) + 1;
    }

    for (const ds of failuresOnly) {
      for (const f of ds.failures) {
        sensorFailureCounts[f.sensor] = (sensorFailureCounts[f.sensor] || 0) + 1;
      }
    }

    const isOffline = station.state !== 1;

    // A) Online with new failures
    if (!isOffline && currentFailures.length) {
      newCache[id] = buildStationCacheEntry(statuses, isOffline);
      const oldFailures = Array.isArray(prevEntry.failures) ? prevEntry.failures : Object.values(prevEntry).filter(v => v.failures).flatMap(v => v.failures);
      const newFailures = currentFailures.filter(s => !oldFailures.includes(s));

      if (alertsOn && newFailures.length) {
        // Group new failures by device (serial)
        const deviceFailuresMap = {};

        for (const ds of failuresOnly) {
          const newDeviceFailures = ds.failures.map(f => f.sensor).filter(sensor => newFailures.includes(sensor));
          if (newDeviceFailures.length) {
            deviceFailuresMap[ds.serial] = newDeviceFailures;
          }
        }
        // Send one message per device with all new failures for that device
        for (const [serial, sensors] of Object.entries(deviceFailuresMap)) {
          await postSlackAlert(VIP_SLACK_WEBHOOK_URL, {
            text: `${mention} :warning: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) has sensor failures: ${sensors.join(', ')}`
          });
        }
      }
      continue;
    }

    // B) Recovered from offline
    if (!isOffline && wasOffline) {
      delete newCache[id];
      if (alertsOn) {
        try {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: `:white_check_mark: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) has *RECOVERED*!`,
            link_names: 1
          });
        } catch {}
      }
      continue;
    }

    // C) Still online, no failures
    if (!isOffline) {
      newCache[id] = buildStationCacheEntry(statuses, isOffline);
      continue;
    }

    // D) Just went offline
    if (!wasOffline) {
      const baseText = `${mention} :rotating_light: ${name} Station *<https://tempestwx.com/station/${id}|${id}>* (${station.name}) is *OFFLINE*`;
      if (alertsOn) {
        if (currentFailures.length) {
          await axios.post(VIP_SLACK_WEBHOOK_URL, {
            text: `${baseText} and has sensor failures: ${currentFailures.join(', ')}`
          });
        } else {
          await axios.post(VIP_SLACK_WEBHOOK_URL, { text: `${baseText}!` });
        }
      }
    }

    // Offline fallback
    newCache[id] = buildStationCacheEntry(statuses, isOffline);
  }

  // 4) Save updated cache
  try {
    await saveCacheFor(name, newCache);
    console.log(`Saved cache for ${name} (${Object.keys(newCache).length} entries)`);
  } catch (err) {
    console.error(`Failed to save cache for ${name}:`, err.message);
  }

  // 5) Emit metrics (always runs, regardless of alertsOn)
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

// await checkAll();
// export { processUser };
