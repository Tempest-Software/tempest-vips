import axios from 'axios';
import config from './config.json' with { type: 'json' };

const { METRIC_URL } = config;

export function buildMetricLines(
  userName,
  functionName,
  timestamp,
  onlineCount,
  offlineCount,
  sensorFailureCounts,
  sensorSuccessCounts
) {
  const name = userName.toLowerCase();

  const lines = [
    `vip.${name}_station_online_count.${functionName},${timestamp},${onlineCount}`,
    `vip.${name}_station_offline_count.${functionName},${timestamp},${offlineCount}`,
  ];

  const failureKeys = Object.keys(sensorFailureCounts);
  if (failureKeys.length > 0) {
    for (const key of failureKeys) {
      const count = sensorFailureCounts[key];
      lines.push(
        `vip.${name}_station_${key}_failure_count.${functionName},${timestamp},${count}`
      );
    }

    const totalFailures = failureKeys.reduce((sum, k) => sum + (sensorFailureCounts[k] || 0), 0);
    lines.push(
      `vip.${name}_station_total_failure_count.${functionName},${timestamp},${totalFailures}`
    );

    const totalSuccesses = failureKeys.reduce((sum, k) => sum + (sensorSuccessCounts[k] || 0), 0);
    lines.push(
      `vip.${name}_station_total_success_count.${functionName},${timestamp},${totalSuccesses}`
    );
  }

  return lines;
}

export async function sendMetricsBatch(lines) {
  const records = lines.join(';');
  const url = `${METRIC_URL}?records=${encodeURIComponent(records)}`;
  await axios.get(url);
}
