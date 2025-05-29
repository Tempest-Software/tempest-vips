import { processUser } from './index.js';
import DeviceStatus from './DeviceStatus.js';
import axios from 'axios';

if (process.env.NODE_ENV === 'development') {
  (async () => {
    console.log('\nRunning DEV harness for processUser with multiple edge cases…\n');
    const { SENSOR_STATUS_FLAGS: F } = DeviceStatus;

    const testCases = [
      {
        desc: '1) Offline with sensor failures',
        stations: [{ station_id: 999, name: 'DEV-STATION-1', state: 0 }],
        devices: [
          { device_id: 101, serial_number: 'AR-DEV1', sensor_status: F.AIR_TEMPERATURE_FAILED },
          { device_id: 102, serial_number: 'SK-DEV2', sensor_status: F.SKY_WIND_FAILED | F.SKY_PRECIP_FAIL },
          { device_id: 104, serial_number: 'ST-DEV4', sensor_status: F.AIR_RH_FAILED },
        ],
      },
      {
        desc: '2) Online with sensor failures',
        stations: [{ station_id: 888, name: 'DEV-STATION-2', state: 1 }],
        devices: [
          { device_id: 105, serial_number: 'ST-DEV5', sensor_status: F.SKY_LIGHT_UV_FAIL | F.AIR_PRESSURE_FAILED },
        ],
      },
      {
        desc: '3) Just offline (no sensor failures)',
        stations: [{ station_id: 777, name: 'DEV-STATION-3', state: 0 }],
        devices: [
          { device_id: 106, serial_number: 'AR-DEV6', sensor_status: F.SENSORS_OK },
        ],
      },
    ];

    const originalGet = axios.get;

    for (const tc of testCases) {
      console.log(`\n--- Test Case: ${tc.desc} ---`);

      axios.get = async (url, ...rest) => {
        if (url.includes('/stations?')) {
          return { status: 200, data: { stations: tc.stations } };
        }
        if (url.includes('/diagnostics/')) {
          return { status: 200, data: { devices: tc.devices } };
        }
        return originalGet(url, ...rest);
      };

      await processUser({
        name: 'DEV',
        apiKey: 'fake-key',
        alertUserIds: ['UQDEVELOPER'],
      });
    }

    axios.get = originalGet;

    console.log('\n✅ DEV harness complete.\n');
    process.exit(0);
  })();
}
