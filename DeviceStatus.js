class DeviceStatus {
  constructor(settings, target) {
    this.target = target;
    const defaultSettings = {};
    this.settings = { ...defaultSettings, ...settings };

    // Define the sensors object as part of the instance
    this.sensors = {
      AR: [
        {
          label: "Temperature",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_TEMPERATURE_FAILED,
              type: "error"
            }
          ]
        },
        {
          label: "RH",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_RH_FAILED,
              type: "error"
            }
          ]
        },
        {
          label: "Lightning",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_LIGHTNING_FAILED,
              type: "error"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_LIGHTNING_DISTURBER,
              failedText: "Disturber",
              type: "warning"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_LIGHTNING_NOISE,
              failedText: "Noise",
              type: "warning"
            }
          ]
        }
      ],
      SK: [
        {
          label: "Wind",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.SKY_WIND_FAILED,
              type: "error"
            }
          ]
        },
        {
          label: "Precip",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.SKY_PRECIP_FAILED,
              type: "error"
            }
          ]
        },
        {
          label: "Light / UV",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.SKY_LIGHT_UV_FAIL,
              type: "error"
            }
          ]
        }
      ],
      ST: [
        {
          label: "Temperature",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_TEMPERATURE_FAILED,
              type: "error"
            }
          ]
        },
        {
          label: "RH",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_RH_FAILED,
              type: "error"
            }
          ]
        },
        {
          label: "Lightning",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_LIGHTNING_FAILED,
              type: "error"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_LIGHTNING_DISTURBER,
              failedText: "Disturber",
              type: "warning"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_LIGHTNING_NOISE,
              failedText: "Noise",
              type: "warning"
            }
          ]
        },
        {
          label: "Air Pressure",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.AIR_PRESSURE_FAILED,
              type: "error"
            },
          ]
        },
        {
          label: "Precip",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.SKY_PRECIP_FAILED,
              type: "error"
            },
          ]
        },
        {
          label: "Light / UV",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.SKY_LIGHT_UV_FAIL,
              type: "error"
            },
          ]
        },
        {
          label: "Light Sensor Type",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.LITR_LIGHT_SENSOR,
              failedText: "LTR",
              type: "normal"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.LITR_SENSOR_TYPE,
              failedText: "Si1133",
              type: "normal"
            },
          ],
          passedText: "APDS9200"
        },
        {
          label: "Power Mode",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE1,
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE2,
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE3,
            },
          ]
        },
        {
          label: "Power Booster",
          flags: [
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.ROCKET_DETECTED,
              failedText: "Detected",
              type: "normal"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.ROCKET_ENABLED,
              failedText: "Enabled",
              type: "normal"
            },
            {
              flag: DeviceStatus.SENSOR_STATUS_FLAGS.ROCKET_SHORE_POWER,
              failedText: "External Power",
              type: "normal"
            }
          ],
          passedText: "Not Detected"
        }
      ]
    };
  }

  // Static method to find status
  findStatus(status, deviceType) {
    let warning = 0;
    let failure = 0;
    let success = 0;

    const deviceSensors = this.sensors[deviceType];

    for (let x = 0; x < deviceSensors.length; x++) {
      const sensorItem = deviceSensors[x];

      for (let i = 0; i < sensorItem.flags.length; i++) {
        const sensorFlag = sensorItem.flags[i];

        if (this._hasSensorError(status, sensorFlag.flag)) {
          if (sensorFlag.type === "error") {
            failure += 1;
          } else if (sensorFlag.type === "warning") {
            warning += 1;
          } else {
            success += 1;
          }
        } else {
          success += 1;
        }
      }
    }

    if (failure > 0) {
      return "failure";
    } else if (warning > 0) {
      return "warning";
    } else if (success > 0){
      return "success";
    }
  }

  getPowerBoosterStatus = function (sensorFlags) {
    var externalPower = sensorFlags.includes("External Power");
    var enabled = sensorFlags.includes("Enabled");
    var detected = sensorFlags.includes("Detected");

    if (externalPower) {
      return "External Power";
    } else if (enabled) {
      return "Enabled";
    } else if (detected) {
      return "Detected";
    }
  }

  getBatteryStatus = function (batteryStatus, firmwareVersion) {
    let retval;

    if (Number(firmwareVersion) >= 174) {
      if ((batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE2) != 0 && (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE3) != 0) {
        retval = "Low Power Mode 5 (M2 + M3)";
      } else if ((batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE1) != 0 && (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE3) != 0) {
        retval = "Normal Mode (M1 + M3)";
      } else if (((batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE2) != 0 || (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE3) != 0) && (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE1) == 0) {
        retval = "Low Power Mode 3 (M3)";
      } else {
        retval = "Performance Mode (M0)";
      }
    } else {
      if (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE1) {
        retval = "Low Power Mode 1 (M1)";
      } else if (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE2) {
        retval = "Low Power Mode 2 (M2)";
      } else if (batteryStatus & DeviceStatus.SENSOR_STATUS_FLAGS.LOW_POWER_MODE3) {
        retval = "Low Power Mode 3 (M3)";
      } else {
        retval = "Normal (M0)";
      }
    }


    return retval;
  }

  _hasSensorError(status, flag) {
    let retval = false;

    if ((status & flag) != 0) {
      retval = true;
    }

    return retval;
  }
}

// Add static properties to the class
DeviceStatus.SENSOR_STATUS_FLAGS = {
  "SENSORS_OK": 0x00000000,
  "AIR_LIGHTNING_FAILED": 0x00000001,
  "AIR_LIGHTNING_NOISE": 0x00000002,
  "AIR_LIGHTNING_DISTURBER": 0x00000004,
  "AIR_PRESSURE_FAILED": 0x00000008,
  "AIR_TEMPERATURE_FAILED": 0x00000010,
  "AIR_RH_FAILED": 0x00000020,
  "SKY_WIND_FAILED": 0x00000040,
  "SKY_PRECIP_FAIL": 0x00000080,
  "SKY_LIGHT_UV_FAIL": 0x00000100,
  "LITR_LIGHT_SENSOR": 0x00020000,
  "LITR_SENSOR_TYPE": 0x00040000,
  "ROCKET_DETECTED": 0x00000200,  // Do not display in app
  "ROCKET_ENABLED": 0x00000400,   // Do not display in app
  "ROCKET_SHORE_POWER": 0x00010000, // Do not display in app
  "LOW_POWER_MODE1": 0x00000800,  // Do not display in app
  "LOW_POWER_MODE2": 0x00001000,  // Do not display in app
  "LOW_POWER_MODE3": 0x00002000,  // Do not display in app
  "SERIAL_ENABLED": 0x00004000    // Do not display in app
};

// Export the class
export default DeviceStatus;
