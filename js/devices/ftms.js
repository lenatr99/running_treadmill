const FTMS_SERVICE = '00001826-0000-1000-8000-00805f9b34fb';
const FTMS_CONTROL_POINT = '00002ad9-0000-1000-8000-00805f9b34fb';
const TREADMILL_DATA_CHAR = '00002acd-0000-1000-8000-00805f9b34fb';
const SUPPORTED_SPEED_RANGE = '00002ad4-0000-1000-8000-00805f9b34fb';
const SUPPORTED_INCLINATION_RANGE = '00002ad5-0000-1000-8000-00805f9b34fb';
const FITNESS_MACHINE_STATUS = '00002ada-0000-1000-8000-00805f9b34fb';

const CP = {
  REQUEST_CONTROL: 0x00,
  SET_SPEED: 0x02,
  SET_INCLINE: 0x03,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
};

const RESULT = {
  0x01: 'Success',
  0x02: 'Op Code Not Supported',
  0x03: 'Invalid Parameter',
  0x04: 'Operation Failed',
  0x05: 'Control Not Permitted',
};

const DEFAULT_SPEED_RANGE = { min: 0, max: 25, increment: 0.1 };
const DEFAULT_INCLINE_RANGE = { min: 0, max: 20, increment: 0.5 };

export class FtmsTreadmill {
  constructor({ onStatus, onTelemetry, onWarning, onDisconnected } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onTelemetry = onTelemetry || (() => {});
    this.onWarning = onWarning || (() => {});
    this.onDisconnected = onDisconnected || (() => {});
    this.device = null;
    this.controlPoint = null;
    this.treadmillData = null;
    this.commandChain = Promise.resolve();
    this.pendingCommand = null;
    this.currentSpeed = null;
    this.currentIncline = null;
    this.targetSpeed = null;
    this.targetIncline = null;
    this.speedRange = DEFAULT_SPEED_RANGE;
    this.inclineRange = DEFAULT_INCLINE_RANGE;
    this.telemetryWaiters = [];
  }

  get connected() {
    return Boolean(this.controlPoint);
  }

  async connect() {
    this.onStatus('Scanning...', '');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FTMS_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnected());

    this.onStatus('Connecting...', '');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);
    this.controlPoint = await service.getCharacteristic(FTMS_CONTROL_POINT);
    this.treadmillData = await service.getCharacteristic(TREADMILL_DATA_CHAR);
    this.commandChain = Promise.resolve();

    await this.controlPoint.startNotifications();
    this.controlPoint.addEventListener('characteristicvaluechanged', event => this.handleControlPointResponse(event));

    await this.treadmillData.startNotifications();
    this.treadmillData.addEventListener('characteristicvaluechanged', event => this.handleTreadmillData(event));

    await this.readRanges(service);
    await this.requestControl();
    this.onStatus(`Connected: ${this.device.name || 'Treadmill'}`, 'ok');
    return this.device;
  }

  handleDisconnected() {
    this.controlPoint = null;
    this.treadmillData = null;
    this.commandChain = Promise.resolve();
    this.pendingCommand = null;
    this.currentSpeed = null;
    this.currentIncline = null;
    this.targetSpeed = null;
    this.targetIncline = null;
    this.telemetryWaiters.splice(0).forEach(waiter => waiter(false));
    this.onStatus('Disconnected - tap Connect to reconnect', 'err');
    this.onTelemetry({ speed: null, incline: null });
    this.onDisconnected();
  }

  async readRanges(service) {
    this.speedRange = await this.readRange(service, SUPPORTED_SPEED_RANGE, 100, DEFAULT_SPEED_RANGE);
    this.inclineRange = await this.readRange(service, SUPPORTED_INCLINATION_RANGE, 10, DEFAULT_INCLINE_RANGE, true);
  }

  async readRange(service, uuid, scale, fallback, signed = false) {
    try {
      const char = await service.getCharacteristic(uuid);
      const value = await char.readValue();
      if (value.byteLength < 6) return fallback;
      const read = signed
        ? offset => value.getInt16(offset, true) / scale
        : offset => value.getUint16(offset, true) / scale;
      const min = read(0);
      const max = read(2);
      const increment = Math.max(0.01, read(4));
      return { min, max, increment };
    } catch (_) {
      return fallback;
    }
  }

  async requestControl() {
    return this.runCommand(CP.REQUEST_CONTROL, new Uint8Array([CP.REQUEST_CONTROL]), { timeoutMs: 2500 });
  }

  async startResume() {
    return this.runCommand(CP.START_RESUME, new Uint8Array([CP.START_RESUME]), { timeoutMs: 2500 });
  }

  async stop() {
    return this.runCommand(CP.STOP_PAUSE, new Uint8Array([CP.STOP_PAUSE, 0x01]), { timeoutMs: 2500 });
  }

  async setSpeed(kmh, options = {}) {
    const target = this.clampToRange(kmh, this.speedRange);
    this.targetSpeed = target;
    if (!this.connected) return target;
    const retries = options.retries ?? 2;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const startSpeed = this.currentSpeed;
      const val = Math.round(target * 100);
      const bytes = new Uint8Array([CP.SET_SPEED, val & 0xff, (val >> 8) & 0xff]);
      await this.runCommand(CP.SET_SPEED, bytes, { timeoutMs: 3000 });

      if (options.verify === false) return target;
      const confirmed = await this.waitForSpeedTarget(target, options.confirmTimeoutMs ?? 1800, startSpeed);
      if (confirmed) return target;
      if (attempt < retries) await delay(300 + attempt * 300);
    }

    this.onWarning(`Treadmill accepted ${target.toFixed(1)} km/h, but telemetry did not confirm it yet.`);
    return target;
  }

  async setIncline(pct) {
    const target = this.clampToRange(pct, this.inclineRange);
    this.targetIncline = target;
    if (!this.connected) return target;
    const val = Math.round(target * 10);
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, CP.SET_INCLINE);
    view.setInt16(1, val, true);
    await this.runCommand(CP.SET_INCLINE, new Uint8Array(buf), { timeoutMs: 3000 });
    return target;
  }

  runCommand(opcode, bytes, options = {}) {
    if (!this.controlPoint) return Promise.resolve(null);
    const task = () => this.executeCommand(opcode, bytes, options);
    const op = this.commandChain.then(task, task);
    this.commandChain = op.catch(async error => {
      if (this.isRecoverableControlError(error)) {
        try {
          await this.executeCommand(CP.REQUEST_CONTROL, new Uint8Array([CP.REQUEST_CONTROL]), { timeoutMs: 2500 });
        } catch (_) {
          // The original error is more useful to callers.
        }
      }
    });
    return op;
  }

  executeCommand(opcode, bytes, { timeoutMs = 2500 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommand?.opcode === opcode) this.pendingCommand = null;
        reject(new Error(`FTMS command 0x${opcode.toString(16)} timed out`));
      }, timeoutMs);

      this.pendingCommand = { opcode, resolve, reject, timer };
      this.controlPoint.writeValueWithResponse(bytes).catch(error => {
        if (this.pendingCommand?.opcode === opcode) this.pendingCommand = null;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  handleControlPointResponse(event) {
    const data = event.target.value;
    if (data.byteLength < 3 || data.getUint8(0) !== 0x80) return;

    const requestOpcode = data.getUint8(1);
    const resultCode = data.getUint8(2);
    const pending = this.pendingCommand;
    if (!pending || pending.opcode !== requestOpcode) {
      console.warn('Unexpected FTMS response', requestOpcode, resultCode);
      return;
    }

    this.pendingCommand = null;
    clearTimeout(pending.timer);
    if (resultCode === 0x01) {
      pending.resolve({ requestOpcode, resultCode });
      return;
    }

    const message = RESULT[resultCode] || `Result ${resultCode}`;
    const error = new Error(`FTMS command 0x${requestOpcode.toString(16)} failed: ${message}`);
    error.resultCode = resultCode;
    error.requestOpcode = requestOpcode;
    pending.reject(error);
  }

  handleTreadmillData(event) {
    const data = event.target.value;
    if (data.byteLength < 4) return;

    const flags = data.getUint16(0, true);
    let offset = 2;

    if ((flags & 0x0001) === 0 && data.byteLength >= offset + 2) {
      this.currentSpeed = data.getUint16(offset, true) / 100;
      offset += 2;
    }

    if (flags & 0x0002) offset += 2;
    if (flags & 0x0004) offset += 3;

    if (flags & 0x0008 && data.byteLength >= offset + 4) {
      this.currentIncline = data.getInt16(offset, true) / 10;
    }

    this.onTelemetry({ speed: this.currentSpeed, incline: this.currentIncline });
    this.flushTelemetryWaiters();
  }

  waitForSpeedTarget(target, timeoutMs, startSpeed = this.currentSpeed) {
    if (this.speedIsMovingTowardTarget(target, startSpeed)) {
      return Promise.resolve(true);
    }

    return new Promise(resolve => {
      const done = result => {
        clearTimeout(timer);
        this.telemetryWaiters = this.telemetryWaiters.filter(fn => fn !== waiter);
        resolve(result);
      };
      const waiter = () => {
        if (this.speedIsMovingTowardTarget(target, startSpeed)) {
          done(true);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        this.telemetryWaiters = this.telemetryWaiters.filter(fn => fn !== waiter);
        resolve(false);
      }, timeoutMs);
      this.telemetryWaiters.push(waiter);
    });
  }

  flushTelemetryWaiters() {
    this.telemetryWaiters = this.telemetryWaiters.filter(waiter => !waiter());
  }

  clampToRange(value, range) {
    const clamped = Math.min(range.max, Math.max(range.min, value));
    const stepped = Math.round(clamped / range.increment) * range.increment;
    return Number(Math.min(range.max, Math.max(range.min, stepped)).toFixed(3));
  }

  isRecoverableControlError(error) {
    return error?.resultCode === 0x04 || error?.resultCode === 0x05;
  }

  speedIsMovingTowardTarget(target, startSpeed) {
    if (this.currentSpeed == null) return false;
    if (Math.abs(this.currentSpeed - target) <= 0.25) return true;
    if (startSpeed == null || Math.abs(target - startSpeed) <= 0.25) return false;
    const direction = Math.sign(target - startSpeed);
    return direction > 0
      ? this.currentSpeed >= startSpeed + 0.2
      : this.currentSpeed <= startSpeed - 0.2;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
