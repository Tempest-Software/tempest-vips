import axios from 'axios';
import config from './config.json' with { type: 'json' };

const { METRIC_URL } = config;

export function buildMetricLines(userName, functionName, timestamp, onlineCount, offlineCount) {
  const name   = userName.toLowerCase();
  return [
    `vip.${name}_station_online_count.${functionName},${timestamp},${onlineCount}`,
    `vip.${name}_station_offline_count.${functionName},${timestamp},${offlineCount}`,
  ];
}

export async function sendMetricsBatch(lines) {
  const records = lines.join(';');
  const url     = `${METRIC_URL}?records=${encodeURIComponent(records)}`;
  await axios.get(url);
}
