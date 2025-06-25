import axios from 'axios';
import config from './config.json' with { type: 'json' };

const { METRIC_URL } = config;

export function buildMetricLines(
  userName,
  functionName,
  timestamp,
  onlineCount,
  offlineCount,
  totalStations,
  sensorFailureCounts,    // per-sensor failure counts
) {
  const name = userName.toLowerCase();
  const lines = [
    `vip.${name}_station_online_count.${functionName},${timestamp},${onlineCount}`,
    `vip.${name}_station_offline_count.${functionName},${timestamp},${offlineCount}`
  ];

  // 1) Per-sensor failure counts
  for (const sensor of Object.keys(sensorFailureCounts)) {
    const count = sensorFailureCounts[sensor] || 0;
    lines.push(
      `vip.${name}_station_${sensor}_failure_count.${functionName},${timestamp},${count}`
    );
  }

  // 2) Total failures across all sensors
  const totalFailures = Object.values(sensorFailureCounts).reduce((sum, c) => sum + c, 0);
  lines.push(
    `vip.${name}_station_total_sensor_failure_count.${functionName},${timestamp},${totalFailures}`
  );

  // 3) Total stations
  lines.push(
    `vip.${name}_station_total_count.${functionName},${timestamp},${totalStations}`
  );

  return lines;
}

export async function sendMetricsBatch(lines) {
  const records = lines.join(';');
  const url = `${METRIC_URL}?records=${encodeURIComponent(records)}`;
  await axios.get(url);
}
