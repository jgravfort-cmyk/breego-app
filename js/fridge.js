// Talks to one cooler box: sends commands one at a time, reads status lines,
// works out the line ending the box expects, reconnects, and keeps a small history.

import { parseLine, command, LineAssembler, LINE_ENDINGS, RANGE, toCelsius } from './protocol.js';

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or full */ }
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = 150;          // pause between commands
const REPLY_MS = 1800;       // how long to wait for a status reply
const POLL_MS = 15000;       // ask for status this often, in case the box goes quiet
const SAMPLE_MS = 60000;     // history resolution
const HISTORY_HOURS = 24;

export class Fridge {
  constructor(transport, { demo = false } = {}) {
    this.t = transport;
    this.demo = demo;
    this.status = null;
    this.connection = 'idle'; // idle | connecting | connected | reconnecting | noreply | disconnected
    this.eol = store.get('breego.eol', null);
    this.log = [];
    this.pending = {};        // zone -> { value, until }
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.userClosed = false;
    this.historyKey = demo ? 'breego.demo.history' : 'breego.history';
    this.eventsKey = demo ? 'breego.demo.events' : 'breego.events';
    this.history = store.get(this.historyKey, []);
    this.events = store.get(this.eventsKey, []);
    this.assembler = new LineAssembler((line) => this.handleLine(line));
    this.t.onText = (text) => { this.addLog('inn', text); this.assembler.push(text); };
    this.t.onDisconnect = () => this.handleDisconnect();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  addLog(dir, text) {
    this.log.push({ t: Date.now(), dir, text });
    if (this.log.length > 200) this.log.shift();
    this.emit('log');
  }

  addEvent(text, detail = '') {
    this.events.unshift({ t: Date.now(), text, detail });
    this.events = this.events.slice(0, 100);
    store.set(this.eventsKey, this.events);
    this.emit('events');
  }

  setConnection(state) {
    this.connection = state;
    this.emit('connection', state);
  }

  async connect() {
    this.userClosed = false;
    this.setConnection('connecting');
    await this.t.connect();
    await this.handshake();
    this.startTimers();
  }

  /** Find a line ending the box answers to, then bind if the box asks for it. */
  async handshake() {
    const order = [this.eol, 'lf', 'literal', 'crlf', 'none'].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const key of order) {
      this.eol = key;
      const got = await this.requestStatus();
      if (got) {
        store.set('breego.eol', key);
        this.setConnection('connected');
        if (got.binding === 1) await this.send(command.bind());
        return true;
      }
    }
    this.eol = store.get('breego.eol', 'lf');
    this.setConnection('noreply');
    return false;
  }

  requestStatus(timeout = REPLY_MS) {
    return new Promise((resolve) => {
      let done = false;
      const off = this.on((type, data) => {
        if (type === 'status' && !done) { done = true; off(); resolve(data); }
      });
      setTimeout(() => { if (!done) { done = true; off(); resolve(null); } }, timeout);
      this.send(command.status());
    });
  }

  /** Commands go out one at a time with a short gap, since BLE can't overlap writes. */
  send(cmd, eolKey = this.eol || 'lf') {
    const text = cmd + (LINE_ENDINGS[eolKey]?.value ?? '\n');
    this.queue = this.queue.then(async () => {
      if (!this.t.connected) return;
      this.addLog('ut', text);
      try { await this.t.write(text); } catch (e) { this.addLog('feil', String(e?.message || e)); }
      await sleep(GAP_MS);
    });
    return this.queue;
  }

  handleLine(line) {
    const msg = parseLine(line);
    if (msg.kind === 'status') {
      const prev = this.status;
      this.status = msg;
      if (this.connection === 'noreply' || this.connection === 'reconnecting') this.setConnection('connected');
      if (prev && prev.on !== msg.on) this.addEvent(msg.on ? 'Boksen ble slått på' : 'Boksen ble slått av');
      if (prev && prev.speed !== msg.speed) this.addEvent(msg.speed === 'max' ? 'Byttet til MAX' : 'Byttet til ECO');
      for (const zone of ['left', 'right']) {
        const p = this.pending[zone];
        if (p && (msg[zone + 'Set'] === p.value || Date.now() > p.until)) delete this.pending[zone];
      }
      if (!this.history.length) this.sample();
      this.emit('status', msg);
    } else if (msg.kind === 'fault') {
      this.addEvent(`Feilkode E${msg.code}`, msg.zone === 3 ? 'Høyre sone' : '');
      this.emit('fault', msg);
    }
  }

  handleDisconnect() {
    clearInterval(this.pollTimer);
    clearInterval(this.sampleTimer);
    if (this.userClosed) { this.setConnection('disconnected'); return; }
    this.reconnect();
  }

  async reconnect() {
    this.setConnection('reconnecting');
    for (let attempt = 0; attempt < 6 && !this.userClosed; attempt++) {
      await sleep(Math.min(16000, 1000 * 2 ** attempt));
      try {
        await this.t.open();
        await this.handshake();
        this.startTimers();
        return;
      } catch { /* try again */ }
    }
    this.setConnection('disconnected');
  }

  startTimers() {
    clearInterval(this.pollTimer);
    clearInterval(this.sampleTimer);
    this.pollTimer = setInterval(() => this.send(command.status()), POLL_MS);
    this.sampleTimer = setInterval(() => this.sample(), this.demo ? 5000 : SAMPLE_MS);
  }

  sample() {
    const s = this.status;
    if (!s) return;
    const cutoff = Date.now() - HISTORY_HOURS * 3600e3;
    this.history.push({
      t: Date.now(),
      l: round1(toCelsius(s.leftCur, s.unit)),
      r: s.zones === 2 ? round1(toCelsius(s.rightCur, s.unit)) : null,
      on: s.on,
    });
    this.history = this.history.filter((p) => p.t >= cutoff).slice(-2000);
    store.set(this.historyKey, this.history);
    this.detectLidOpen();
    this.emit('history');
  }

  /** The box has no lid sensor. A quick jump in temperature while running is the best hint. */
  detectLidOpen() {
    const h = this.history;
    if (h.length < 3 || !this.status?.on) return;
    const now = h[h.length - 1];
    const before = h.find((p) => p.t >= now.t - 3 * 60e3);
    if (!before || before === now) return;
    for (const z of ['l', 'r']) {
      if (now[z] != null && before[z] != null && now[z] - before[z] >= 2) {
        const last = this.events[0];
        if (!last || last.text !== 'Mulig åpent lokk' || Date.now() - last.t > 10 * 60e3) {
          this.addEvent('Mulig åpent lokk', `${z === 'l' ? 'Venstre' : 'Høyre'} sone steg ${round1(now[z] - before[z])}° på kort tid`);
          this.emit('lid', z);
        }
      }
    }
  }

  // ---- controls ----
  get limits() {
    const s = this.status;
    const max = s?.max != null && s.max > s?.min ? s.max : RANGE.max;
    const min = s?.min != null && s.min < max ? s.min : RANGE.min;
    return { min, max };
  }

  setTemp(zone, celsius) {
    const { min, max } = this.limits;
    const v = Math.round(Math.min(max, Math.max(min, celsius)));
    this.pending[zone] = { value: v, until: Date.now() + 5000 };
    this.emit('pending');
    return this.send(zone === 'right' ? command.rightTemp(v) : command.leftTemp(v));
  }

  setPower(on) { return this.send(command.power(on)); }
  setSpeed(max) { return this.send(command.speed(max)); }
  setUnit(fahrenheit) { return this.send(command.unit(fahrenheit)); }
  setProtection(level) { return this.send(command.protection(level)); }

  /** For the troubleshooting screen: send any text exactly as typed, plus the chosen line ending. */
  sendRaw(text, eolKey) { return this.send(text, eolKey); }

  setLineEnding(key) {
    if (!LINE_ENDINGS[key]) return;
    this.eol = key;
    store.set('breego.eol', key);
  }

  disconnect() {
    this.userClosed = true;
    clearInterval(this.pollTimer);
    clearInterval(this.sampleTimer);
    this.t.disconnect();
    this.setConnection('disconnected');
  }

  clearHistory() {
    this.history = [];
    this.events = [];
    store.set(this.historyKey, []);
    store.set(this.eventsKey, []);
    this.emit('history');
    this.emit('events');
  }
}

function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }

export { store };
