# Tempest VIP Monitor

A Node.js application that monitors WeatherFlow Tempest weather stations for VIP users, tracking sensor failures and offline status with real-time Slack alerts and metrics reporting.

## Overview

This monitoring system continuously checks multiple users weather station networks for:
- Offline stations
- Sensor failures (temperature, humidity, wind, precipitation, lightning, UV, pressure)
- Device health status
- Recovery from failures

The system maintains state between runs to intelligently alert only on new issues while tracking metrics for all monitored stations.

## Configuration

The application uses a `config.json` file with the following structure:

```json
{
  "VIP_SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/...",
  "S3_BUCKET": "your-s3-bucket",
  "AWS_REGION": "us-east-1",
  "AWS_ACCESS_KEY_ID": "your-access-key",
  "AWS_SECRET_ACCESS_KEY": "your-secret-key",
  "METRIC_URL": "https://your-metrics-endpoint.com",
  
  "KOOTENAI_API_Key": "api-key-1",
  "CPI_API_Key": "api-key-2",
  "MOSS_API_Key": "api-key-3",
  "CALPINE_API_Key": "api-key-4",
  "PROLOGIS_API_Key": "api-key-5",
  "ALABAMAPOWER_API_Key": "api-key-6",
  "BLACHLY_API_Key": "api-key-7",
  "JOEMC_API_Key": "api-key-8",
  "BENTON_API_Key": "api-key-9"
}
```

## User Configuration

Users are defined in `index.js` with the following properties:

```javascript
{
  name: 'USER_NAME',               // Used for metrics and logging
  apiKey: USER_API_Key,            // Reference to config.json key
  alertUserIds: ['UXXXXXXXX'],     // Slack user IDs for @mentions
  alertsOn: true                   // Enable/disable alerts for this user
}
```

## Sensor Types Monitored

The system monitors the following sensor types:
- **air_temperature**: Temperature sensor
- **rh**: Relative humidity
- **lightning**: Lightning detection
- **wind**: Wind speed and direction
- **precip**: Precipitation
- **light_uv**: Light and UV sensors
- **pressure**: Atmospheric pressure

## Alert Types

### Offline Alert
```
🚨 @mention USER Station *12345* (Station Name) is *OFFLINE*!
```

### Sensor Failure Alert  
```
⚠️ @mention USER Station *12345* (Station Name) has sensor failures: air_temperature, wind
```

### Recovery Alert
```
✅ USER Station *12345* (Station Name) has *RECOVERED*!
```

## Metrics

The system emits the following metrics per user:
- `vip.{user}_station_online_count` - Number of healthy stations
- `vip.{user}_station_offline_count` - Number of offline stations
- `vip.{user}_station_{sensor}_failure_count` - Failures per sensor type
- `vip.{user}_station_total_sensor_failure_count` - Total sensor failures
- `vip.{user}_station_total_count` - Total stations monitored

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `config.json` file with your credentials
4. Deploy to AWS Lambda or run locally

## Development

### Running Locally
```bash
node index.js
```

### Test Mode
Set `NODE_ENV=development` to run with mock data:
```bash
NODE_ENV=development node testDevices.js
```

This will simulate various failure scenarios without making real API calls.

## Files Overview

- **index.js** - Main entry point and orchestration logic
- **DeviceStatus.js** - Device and sensor status parsing
- **Slack.js** - Slack webhook integration
- **cache.js** - S3 cache management
- **metrics.js** - Metrics formatting and submission
- **testDevices.js** - Development test harness