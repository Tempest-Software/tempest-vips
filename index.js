import axios from 'axios';
import AWS from 'aws-sdk';
import config from './config.json' with { type: 'json' };
import DeviceStatus from './DeviceStatus.js';

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

// instantiate S3 with explicit credentials
const s3 = new AWS.S3({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  }
});

const USERS = [
  { name: 'KOOTENAI', apiKey: KOOTENAI_API_Key },
  { name: 'CPI',      apiKey: CPI_API_Key      },
  { name: 'MOSS',     apiKey: MOSS_API_Key     },
];

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

// ————————————————
// processDevices helper: uses sensor_status & serial_number from diagData.devices
function processDevices(devices, settings = {}, target = null) {
  return devices
    .filter(device => !device.serial_number.includes('HB'))
    .map(device => {
      const deviceType = device.serial_number.split('-')[0];
      const ds = new DeviceStatus(settings, target);
      const humanStatus = ds.findStatus(device.sensor_status, deviceType);
      return {
        device_id:   device.device_id,
        serial:      device.serial_number,
        deviceType,
        rawStatus:   device.sensor_status,
        humanStatus,  // "failure" | "warning" | "success"
      };
    });
}
// ————————————————

async function processUser({ name, apiKey }) {
  const stationsUrl = `${GROUP_BASE_URL}/stations?api_key=${apiKey}`;
  const { data, status } = await axios.get(stationsUrl);

  if (status !== 200) {
    console.warn(`HTTP ${status} fetching ${name} stations`);
    return 0;
  }

  const cache      = await loadCacheFor(name);
  const newCache   = { ...cache };
  const newOffline = [];
  const recovered  = [];

  for (const station of data.stations) {
    const id = String(station.station_id);

    // 1️⃣ Fetch diagnostics for this station
    let diagData;
    try {
      const diagUrl = `${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`;
      const resp = await axios.get(diagUrl);
      if (resp.status === 200) {
        diagData = resp.data;
      } else {
        console.warn(`HTTP ${resp.status} fetching diagnostics for station ${id}`);
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }

    // 1.5️⃣ Process and log only non-success statuses
    if (diagData && Array.isArray(diagData.devices)) {
      const deviceStatuses = processDevices(diagData.devices);
      const nonSuccess = deviceStatuses.filter(ds => ds.humanStatus !== 'success');
      if (nonSuccess.length) {
        console.log(`🔧 Station ${id} non-success device statuses:`, nonSuccess);
      }
    }

    // 2️⃣ Your existing online/offline logic
    if (station.state !== 1) {
      if (cache[id] !== 'offline') newOffline.push({ id, name: station.name });
      newCache[id] = 'offline';
    } else if (cache[id] === 'offline') {
      recovered.push({ id, name: station.name });
      delete newCache[id];
    }
  }

  // 3️⃣ Persist cache and notify Slack as before
  if (newOffline.length || recovered.length) {
    await saveCacheFor(name, newCache);
  }

  for (const { id, name: stationName } of newOffline) {
    await axios.post(TEST_SLACK_WEBHOOK_URL, {
      text: `:rotating_light: ${name} Station *${id}* (${stationName}) is *OFFLINE*!`
    });
  }

  for (const { id, name: stationName } of recovered) {
    await axios.post(TEST_SLACK_WEBHOOK_URL, {
      text: `:white_check_mark: ${name} Station *${id}* (${stationName}) has *RECOVERED*!`
    });
  }

  if (Object.keys(cache).length > 0 && Object.keys(newCache).length === 0) {
    await axios.post(TEST_SLACK_WEBHOOK_URL, {
      text: `:tada: All ${name} stations are now *ONLINE*!`
    });
  }

  return Object.keys(newCache).length;
}

async function checkAll() {
  let anyOffline = false;
  const details  = [];

  for (const userObj of USERS) {
    const count = await processUser(userObj);
    if (count > 0) {
      anyOffline = true;
      details.push(`${userObj.name}: ${count}`);
    }
  }

  if (anyOffline) {
    console.error(`Stations still offline: ${details.join(', ')}`);
  } else {
    console.log('✅ All stations for all users are online');
  }
}

await checkAll();

export const handler = async () => {
  await checkAll();
};
