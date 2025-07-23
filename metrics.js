import axios from 'axios';
import config from './config.json' with { type: 'json' };

const { METRIC_URL } = config;

export function buildMetricLines(
  userName,
  functionName,
  timestamp,
  healthyCount,
  offlineCount,
  totalStations,
  sensorFailureCounts,
) {
  const name = userName.toLowerCase();
  const lines = [
    `vip.${name}_station_healthy_count.${functionName},${timestamp},${healthyCount}`,
    `vip.${name}_station_offline_count.${functionName},${timestamp},${offlineCount}`
  ];

  // Per-sensor failure counts
  for (const sensor of Object.keys(sensorFailureCounts)) {
    const count = sensorFailureCounts[sensor] || 0;
    lines.push(
      `vip.${name}_station_${sensor}_failure_count.${functionName},${timestamp},${count}`
    );
  }

  // Total failures across all sensors
  const totalFailures = Object.values(sensorFailureCounts).reduce((sum, c) => sum + c, 0);
  lines.push(
    `vip.${name}_station_total_sensor_failure_count.${functionName},${timestamp},${totalFailures}`
  );

  // Total stations
  lines.push(
    `vip.${name}_station_total_count.${functionName},${timestamp},${totalStations}`
  );

  return lines;
}

export async function sendMetricsBatch(lines) {
  try {
    const records = lines.join(';');
    const url = `${METRIC_URL}?records=${encodeURIComponent(records)}`;
    await axios.get(url);
  } catch (error) {
    throw new Error(`Failed to send metrics: ${error.message}`);
  }
}

export async function sendUserMetrics(
  userName,
  functionName,
  healthyCount,
  offlineCount,
  totalStations,
  sensorFailureCounts
) {
  const timestamp = Math.floor(Date.now() / 1000);
  
  const metricLines = buildMetricLines(
    userName,
    functionName,
    timestamp,
    healthyCount,
    offlineCount,
    totalStations,
    sensorFailureCounts
  );

  await sendMetricsBatch(metricLines);
}