// Two ways to talk to a box: real Bluetooth, or a simulated box for the demo.
// Both expose the same small interface: connect(), write(text), disconnect(),
// and the callbacks onText(text) and onDisconnect().

import { formatTemp } from './protocol.js';

const SERVICE = 0xfff0;
const WRITE_CHAR = 0xfff1;
const NOTIFY_CHAR = 0xfff4;
const CHUNK = 20; // safe default BLE packet size

export const bluetoothSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export class BleTransport {
  constructor() {
    this.onText = null;
    this.onDisconnect = null;
    this.device = null;
    this.tx = null;
    this.rx = null;
    this._handler = (e) => {
      const text = new TextDecoder().decode(e.target.value);
      this.onText?.(text);
    };
  }

  get name() { return this.device?.name || 'Kjøleboks'; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [
        { name: 'SimpleBLEPeripheral' },
        { namePrefix: 'Intelligent' },
        { services: [SERVICE] },
      ],
      optionalServices: [SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    await this.open();
  }

  async open() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.tx = await service.getCharacteristic(WRITE_CHAR);
    if (this.rx) this.rx.removeEventListener('characteristicvaluechanged', this._handler);
    this.rx = await service.getCharacteristic(NOTIFY_CHAR);
    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', this._handler);
  }

  get connected() { return !!this.device?.gatt?.connected; }

  async write(text) {
    const data = new TextEncoder().encode(text);
    for (let i = 0; i < data.length; i += CHUNK) {
      const chunk = data.slice(i, i + CHUNK);
      if (this.tx.properties.writeWithoutResponse && this.tx.writeValueWithoutResponse) {
        await this.tx.writeValueWithoutResponse(chunk);
      } else {
        await this.tx.writeValue(chunk);
      }
    }
  }

  disconnect() { this.device?.gatt?.disconnect(); }
}

/** A pretend dual-zone box that speaks the same protocol. Used for the demo. */
export class SimTransport {
  constructor() {
    this.onText = null;
    this.onDisconnect = null;
    this.connected = false;
    this.s = {
      type: 'H', zones: 2, on: 1, unit: 1,
      leftCur: 7.4, rightCur: -14.6, leftSet: 4, rightSet: -18,
      protection: 2, volt: 126, speed: 1,
    };
  }

  get name() { return 'Demo-boks'; }

  async connect() {
    await new Promise((r) => setTimeout(r, 900));
    this.connected = true;
    this.timer = setInterval(() => this.tick(), 2000);
  }

  async open() { this.connected = true; }

  disconnect() {
    clearInterval(this.timer);
    this.connected = false;
    this.onDisconnect?.();
  }

  statusLine() {
    const s = this.s;
    const cur = (c) => formatTemp(s.unit === 2 ? c * 9 / 5 + 32 : c);
    return `/S00/${s.type}/${s.zones},${s.on},${s.unit},${cur(s.leftCur)},${s.zones === 2 ? cur(s.rightCur) : '000'},` +
      `${formatTemp(s.leftSet)},${s.zones === 2 ? formatTemp(s.rightSet) : '000'},${s.protection},` +
      `${String(Math.round(s.volt)).padStart(3, '0')},${s.speed},+20,-20,0\n`;
  }

  emit(text) {
    // Send in 20-character pieces, like real Bluetooth notifications.
    for (let i = 0; i < text.length; i += 20) {
      const piece = text.slice(i, i + 20);
      setTimeout(() => this.onText?.(piece), 30 + i);
    }
  }

  async write(text) {
    const cmd = text.replace(/\\n|\r|\n/g, '');
    const m = cmd.match(/^\/S0(\d)\/(\d)\/([+-]?\d+)$/);
    const s = this.s;
    if (m) {
      const [, op, sub, arg] = m;
      const v = Number(arg);
      if (op === '0' && sub === '2') { /* binding: nothing to do */ }
      if (op === '1') s.on = v ? 1 : 0;
      if (op === '3') s.leftSet = v;
      if (op === '4') s.protection = v;
      if (op === '5') s.rightSet = v;
      if (op === '6') s.speed = v;
      if (op === '7') s.unit = v;
    }
    setTimeout(() => this.emit(this.statusLine()), 120);
  }

  tick() {
    const s = this.s;
    const before = this.statusLine();
    const step = s.speed === 2 ? 0.5 : 0.3;
    const move = (cur, set) => {
      if (!s.on) return Math.min(20, cur + 0.1);
      const d = set - cur;
      return Math.abs(d) <= step ? set : cur + Math.sign(d) * step;
    };
    s.leftCur = move(s.leftCur, s.leftSet);
    s.rightCur = move(s.rightCur, s.rightSet);
    s.volt = s.on ? Math.max(118, s.volt - 0.02) : s.volt;
    const after = this.statusLine();
    if (after !== before) this.emit(after);
  }
}

