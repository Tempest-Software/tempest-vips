import axios from 'axios';

export class Slack {
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl;
  }

  async sendAlert(message) {
    try {
      await axios.post(this.webhookUrl, { 
        text: message, 
        link_names: 1 
      });
    } catch (error) {
      console.warn('Failed to send Slack alert:', error.message);
    }
  }

  buildMentions(userIds) {
    return userIds && userIds.length 
      ? userIds.map(id => `<@${id}>`).join(' ') + ' ' 
      : '';
  }

  buildStationLink(stationId, stationName) {
    return `*<https://tempestwx.com/station/${stationId}|${stationId}>* (${stationName})`;
  }

  async sendSensorFailureAlert(mentions, userName, stationLink, sensors) {
    const message = `${mentions}:warning: ${userName} Station ${stationLink} has sensor failures: ${sensors.join(', ')}`;
    await this.sendAlert(message);
  }

  async sendRecoveryAlert(userName, stationLink) {
    const message = `:white_check_mark: ${userName} Station ${stationLink} has *RECOVERED*!`;
    await this.sendAlert(message);
  }

  async sendOfflineAlert(mentions, userName, stationLink, failedSensors = []) {
    const baseText = `${mentions}:rotating_light: ${userName} Station ${stationLink} is *OFFLINE*`;
    
    const message = failedSensors.length > 0
      ? `${baseText} and has sensor failures: ${failedSensors.join(', ')}`
      : `${baseText}!`;

    await this.sendAlert(message);
  }
}