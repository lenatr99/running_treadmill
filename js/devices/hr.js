const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';

export class HeartRateMonitor {
  constructor({ onStatus, onHeartRate } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onHeartRate = onHeartRate || (() => {});
    this.device = null;
    this.currentHR = null;
  }

  async connect() {
    this.onStatus('Scanning for Polar H10...', '');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE] }],
      optionalServices: [HR_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnected());

    this.onStatus('Connecting...', '');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(HR_SERVICE);
    const hrChar = await service.getCharacteristic(HR_MEASUREMENT);

    await hrChar.startNotifications();
    hrChar.addEventListener('characteristicvaluechanged', event => this.handleMeasurement(event));

    this.onStatus(`${this.device.name || 'HR Monitor'} connected`, 'ok');
    return this.device;
  }

  handleDisconnected() {
    this.currentHR = null;
    this.onHeartRate(null);
    this.onStatus('HR monitor disconnected', 'err');
  }

  handleMeasurement(event) {
    const data = event.target.value;
    const flags = data.getUint8(0);
    this.currentHR = (flags & 0x01) ? data.getUint16(1, true) : data.getUint8(1);
    this.onHeartRate(this.currentHR);
  }
}
