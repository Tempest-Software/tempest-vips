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

function processDevices(devices, settings = {}, target = null) {
  return devices
    .filter(device => !device.serial_number.includes('HB'))
    .map(device => {
      const { device_id, serial_number: serial, sensor_status: rawStatus } = device;
      const deviceType = serial.split('-')[0];
      const ds = new DeviceStatus(settings, target);
      const sensorStatus = ds.findStatus(rawStatus, deviceType);

      // collect each error-flag's failedText + sensor label
      const failures = [];
      if (sensorStatus === 'warning') {
        const sensorDefs = ds.sensors[deviceType] || [];
        for (const sensorDef of sensorDefs) {
          for (const flagObj of sensorDef.flags) {
            if (flagObj.type === 'warning' && ds._hasSensorError(rawStatus, flagObj.flag)) {
              failures.push({
                sensor: sensorDef.label,
                reason: flagObj.failedText || sensorDef.label
              });
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

    // Fetch diagnostics for this station
    let diagData;
    try {
      const resp = await axios.get(
        `${GROUP_BASE_URL}/diagnostics/${id}?api_key=${apiKey}`
      );
      if (resp.status === 200) {
        diagData = resp.data;
      } else {
        console.warn(`HTTP ${resp.status} fetching diagnostics for station ${id}`);
      }
    } catch (err) {
      console.warn(`Error fetching diagnostics for station ${id}:`, err.message);
    }

    // Send Slack alerts for each error-flag
    if (diagData && Array.isArray(diagData.devices)) {
      const deviceStatuses = processDevices(diagData.devices);
      const failuresOnly = deviceStatuses.filter(ds => ds.humanStatus === 'warning');

      for (const { serial, failures } of failuresOnly) {
        for (const { sensor, reason } of failures) {
          const text = `:warning: ${name} Station ${id} ${sensor} device (${serial}) has a sensor failure: ${reason}`;
          console.log(text);
          // await axios.post(TEST_SLACK_WEBHOOK_URL, { text });
        }
      }
    }

    if (station.state !== 1) {
      if (cache[id] !== 'offline') newOffline.push({ id, name: station.name });
      newCache[id] = 'offline';
    } else if (cache[id] === 'offline') {
      recovered.push({ id, name: station.name });
      delete newCache[id];
    }
  }

  // Persist cache and notify Slack as before
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
