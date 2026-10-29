import { Fridge, store } from './fridge.js';
import { BleTransport, SimTransport, bluetoothSupported } from './transports.js';
import { FAULTS, PROTECTION, LINE_ENDINGS, RANGE, toCelsius, fromCelsius } from './protocol.js';

const VERSION = '0.1.1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let fridge = null;
let zone = 'left';
let dragValue = null;     // °C while the user drags the dial
let stepTimer = null;
let powerArmed = 0;

const PRESETS = [
  { n: 'Drikke', t: 4 }, { n: 'Ferskvare', t: 2 }, { n: 'Fisk og agn', t: 0 },
  { n: 'Vin', t: 10 }, { n: 'Is og frys', t: -18 }, { n: 'Dypfrys', t: -20 },
];

// ---------- small helpers ----------
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const unit = () => fridge?.status?.unit || 'C';
const fmt = (c, d = 0) => (c == null ? '–' : fromCelsius(c, unit()).toFixed(d).replace('.', ',').replace('-', '−'));
const clock = (t) => new Date(t).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
const deviceName = () => store.get('breego.name', null) || (fridge?.demo ? 'Demo-boksen' : 'Kjøleboksen');

function zonesOf(s) {
  if (!s || s.zones !== 2) return [{ key: 'left', label: 'Kjøleboks' }];
  return [{ key: 'left', label: 'Venstre' }, { key: 'right', label: 'Høyre' }];
}
const zoneColor = (setC) => (setC != null && setC <= 0 ? '--deep' : '--ice');
const zoneKind = (setC) => (setC != null && setC <= 0 ? 'Frys' : 'Kjøl');
function targetOf(z) {
  if (z === zone && dragValue != null) return dragValue;
  const p = fridge?.pending[z];
  if (p) return p.value;
  return fridge?.status?.[z + 'Set'] ?? null;
}
const currentOf = (z) => toCelsius(fridge?.status?.[z + 'Cur'], unit());

// ---------- connect screen ----------
function initConnect() {
  if (!bluetoothSupported()) {
    $('#btn-connect').disabled = true;
    $('#c-title').textContent = 'Denne nettleseren kan ikke bruke Bluetooth';
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg\//.test(ua);
    const firefox = /Firefox\//.test(ua);
    $('#c-sub').textContent = ios
      ? 'iPhone tillater ikke Bluetooth fra nettsider. Breego-appen kommer i App Store. Til testing kan du bruke den gratis nettleseren Bluefy. Du kan også prøve demoen.'
      : safari
        ? 'Safari støtter ikke Bluetooth. Kopier adressen og åpne den i Google Chrome. Du kan prøve demoen så lenge.'
        : firefox
          ? 'Firefox støtter ikke Bluetooth. Kopier adressen og åpne den i Google Chrome. Du kan prøve demoen så lenge.'
          : 'Åpne siden i Google Chrome på Android, Mac eller PC. Du kan prøve demoen så lenge.';
  }
  $('#btn-connect').onclick = () => start(new BleTransport(), false);
  $('#btn-demo').onclick = () => start(new SimTransport(), true);
}

async function start(transport, demo) {
  const radar = $('#radar');
  radar.classList.add('scanning');
  $('#btn-connect').disabled = true;
  $('#btn-demo').disabled = true;
  $('#c-title').textContent = demo ? 'Starter demoen …' : 'Velg boksen i listen';
  $('#c-sub').textContent = demo ? 'Dette er en pretend-boks som oppfører seg som en ekte.' : 'Den heter «SimpleBLEPeripheral» eller «Intelligent Refrigerator».';
  fridge = new Fridge(transport, { demo });
  fridge.on(onFridgeEvent);
  try {
    await fridge.connect();
    showMain();
    toast(fridge.connection === 'connected' ? `Tilkoblet ${deviceName()}` : 'Tilkoblet, men boksen svarer ikke ennå');
  } catch (e) {
    fridge = null;
    const cancelled = e && (e.name === 'NotFoundError' || /cancel/i.test(e.message || ''));
    $('#c-title').textContent = cancelled ? 'Ingen boks valgt' : 'Fikk ikke koblet til';
    $('#c-sub').textContent = cancelled
      ? 'Trykk på knappen igjen og velg boksen i listen. Sjekk at boksen er slått på og står i nærheten.'
      : `Slå boksen av og på, og prøv igjen. Feilmelding: ${e?.message || e}`;
    $('#btn-connect').disabled = !bluetoothSupported();
    $('#btn-demo').disabled = false;
  } finally {
    radar.classList.remove('scanning');
  }
}

function showMain() {
  $('#v-connect').hidden = true;
  $('#v-main').hidden = false;
  $('#devname').textContent = deviceName();
  $('#nm').textContent = deviceName();
  showPage('home');
  renderAll();
  requestAnimationFrame(() => { sizeFrost(); });
}

function backToConnect() {
  $('#v-main').hidden = true;
  $('#v-connect').hidden = false;
  $('#c-title').textContent = 'Koble til kjøleboksen';
  $('#c-sub').textContent = 'Slå på boksen og hold telefonen i nærheten. Trykk på knappen og velg boksen i listen.';
  $('#btn-connect').disabled = !bluetoothSupported();
  $('#btn-demo').disabled = false;
  if (!bluetoothSupported()) initConnect();
}

// ---------- events from the box ----------
function onFridgeEvent(type, data) {
  if (type === 'status' || type === 'pending') renderAll();
  if (type === 'connection') renderConnection();
  if (type === 'log') renderRawLog();
  if (type === 'events') renderEvents();
  if (type === 'history' && !$('#p-log').hidden) drawChart();
  if (type === 'fault') renderFault(data);
  if (type === 'lid') toast(`Har lokket stått åpent? ${data === 'left' || data === 'l' ? 'Venstre' : 'Høyre'} sone ble varmere.`, 4000);
}

const CONN_TEXT = {
  connecting: 'Kobler til …', connected: 'Tilkoblet', reconnecting: 'Kobler til igjen …',
  noreply: 'Tilkoblet, men ingen svar', disconnected: 'Frakoblet', idle: '',
};
function renderConnection() {
  const c = fridge?.connection || 'idle';
  const el = $('#conn');
  el.dataset.state = c;
  el.textContent = (fridge?.demo ? 'Demo · ' : '') + CONN_TEXT[c];
  $('#noreply').hidden = c !== 'noreply';
  if (c === 'disconnected' && !fridge?.userClosed) toast('Mistet kontakten med boksen. Gå nærmere og koble til på nytt.', 4000);
}

function renderFault(f) {
  const info = FAULTS[f.code] || { code: `E${f.code}`, title: 'Ukjent feil', help: 'Slå boksen av og på igjen.' };
  const el = $('#fault');
  el.innerHTML = '';
  const b = document.createElement('b'); b.textContent = `${info.code}: ${info.title}`;
  const s = document.createElement('span'); s.textContent = info.help;
  const x = document.createElement('button'); x.textContent = 'Lukk'; x.onclick = () => { el.hidden = true; };
  el.append(b, s, x);
  el.hidden = false;
}

// ---------- render ----------
function renderAll() {
  renderConnection();
  const s = fridge?.status;
  const zs = zonesOf(s);
  if (!zs.some((z) => z.key === zone)) zone = 'left';

  // zone switch
  const zonesEl = $('#zones');
  zonesEl.hidden = zs.length < 2;
  zonesEl.innerHTML = zs.map((z) => {
    const set = targetOf(z.key);
    return `<button aria-pressed="${z.key === zone}" data-z="${z.key}"><span class="dot" style="background:var(${zoneColor(set)})"></span>${z.label} · ${zoneKind(set)} <span class="mini num">${fmt(currentOf(z.key), 1)}°</span></button>`;
  }).join('');
  $$('#zones button').forEach((b) => { b.onclick = () => { zone = b.dataset.z; dragValue = null; renderAll(); }; });

  renderDial();
  renderPower(s);

  // mode
  $$('.mode').forEach((b) => b.setAttribute('aria-pressed', String((s?.speed || 'eco') === b.dataset.mode)));
  $('#mode-rpm').textContent = s ? (s.speed === 'max' ? '3500 o/min' : '2500 o/min') : '';

  // settings
  $$('#prot button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.p) === s?.protection)));
  $('#prot-help').textContent = PROTECTION[s?.protection]?.help || 'Velg hvor tidlig boksen skal slå seg av for å spare batteriet.';
  $$('#unit button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.u === unit())));
}

function renderDial() {
  const s = fridge?.status;
  const target = targetOf(zone);
  const cur = currentOf(zone);
  const color = zoneColor(target);
  const dial = $('#dial');
  dial.style.setProperty('--zone', `var(${color})`);
  $('#dialsvg').style.setProperty('--zonec', `var(${color})`);
  dial.classList.toggle('off', !!s && !s.on);
  dial.classList.toggle('pending', !!fridge?.pending[zone]);
  const a = v2a(target ?? 0);
  $('#trackfill').setAttribute('d', target == null ? '' : arc(A0, Math.max(A0 + 0.01, a)));
  const [kx, ky] = pt(a);
  $('#knob').setAttribute('transform', `translate(${kx.toFixed(1)} ${ky.toFixed(1)})`);
  $('#knob').style.display = target == null ? 'none' : '';
  if (cur != null) {
    const [cx, cy] = pt(v2a(Math.max(RANGE.min, Math.min(RANGE.max, cur))));
    $('#curdot').setAttribute('cx', cx); $('#curdot').setAttribute('cy', cy);
    $('#curdot').style.display = '';
  } else $('#curdot').style.display = 'none';
  $('#d-target').innerHTML = target == null ? '–' : `${fmt(target)}<sup>°${unit()}</sup>`;
  $('#d-cur').textContent = cur == null ? '–' : `${fmt(cur, 0)}°`;
  $$('.tl').forEach((t) => { t.textContent = fmt(Number(t.dataset.v)); });
  $$('#presets .pre').forEach((p) => p.setAttribute('aria-pressed', String(Number(p.dataset.t) === target)));
  $$('#presets .pre span').forEach((sp) => { sp.textContent = `${fmt(Number(sp.dataset.t))}°${unit()}`; });

  const sl = $('#statusline');
  if (!s) sl.innerHTML = 'Venter på status fra boksen …';
  else if (!s.on) sl.innerHTML = 'Boksen er <b>slått av</b>';
  else if (target == null || cur == null) sl.textContent = '';
  else {
    const diff = cur - target;
    if (Math.abs(diff) < 1) sl.innerHTML = `<b>På målet</b> · holder ${fmt(target)}°`;
    else if (diff > 0) {
      const mins = minutesToTarget(zone, cur, target);
      sl.innerHTML = mins ? `Kjøler ned · <b>ca. ${mins} min</b> til ${fmt(target)}°` : `Kjøler ned mot <b>${fmt(target)}°</b>`;
    } else sl.innerHTML = `Temperaturen stiger mot <b>${fmt(target)}°</b>`;
  }
}

/** Estimate from how fast the zone has cooled over the last ten minutes. */
function minutesToTarget(z, cur, target) {
  const h = fridge?.history || [];
  const key = z === 'right' ? 'r' : 'l';
  const recent = h.filter((p) => p.t >= Date.now() - 10 * 60e3 && p[key] != null);
  if (recent.length < 3) return null;
  const first = recent[0], last = recent[recent.length - 1];
  const minutes = (last.t - first.t) / 60e3;
  const rate = (first[key] - last[key]) / minutes; // degrees per minute, positive when cooling
  if (!(rate > 0.03)) return null;
  return Math.max(1, Math.round((cur - target) / rate));
}

function renderPower(s) {
  const pwr = $('#pwr');
  const on = !!s?.on;
  pwr.classList.toggle('on', on);
  pwr.setAttribute('aria-pressed', String(on));
  pwr.setAttribute('aria-label', on ? 'Slå av kjøleboksen' : 'Slå på kjøleboksen');

  const v = s?.volt;
  if (v == null) {
    $('#b-volt').innerHTML = '–';
    $('#ringarc').setAttribute('stroke-dashoffset', '226.2');
    ['#b-state', '#b-prot', '#b-model'].forEach((k) => { $(k).textContent = '–'; });
    $('#b-help').textContent = 'Venter på status fra boksen.';
    return;
  }
  const is24 = v > 18;
  const lo = is24 ? 21 : 10.5, hi = is24 ? 28.8 : 14.4;
  const frac = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  $('#b-volt').innerHTML = `${v.toFixed(1).replace('.', ',')}<small>&nbsp;V</small>`;
  $('#ringarc').setAttribute('stroke-dashoffset', (226.2 * (1 - frac)).toFixed(1));
  const k = is24 ? 2 : 1;
  let state, color, help;
  if (v >= 13.2 * k) { state = 'Lader'; color = '--ok'; help = 'Spenningen tyder på at motoren går eller at en lader er koblet til.'; }
  else if (v >= 12.4 * k) { state = 'God'; color = '--ok'; help = 'Batteriet har god spenning.'; }
  else if (v >= 12.0 * k) { state = 'OK'; color = '--ok'; help = 'Batteriet er i orden, men har brukt noe av ladningen.'; }
  else if (v >= 11.6 * k) { state = 'Lav'; color = '--ember'; help = 'Batteriet begynner å bli lavt. Batterivernet slår av boksen før startbatteriet blir for svakt.'; }
  else { state = 'Svært lav'; color = '--bad'; help = 'Batteriet er nesten tomt. Start bilen eller koble til 230 V.'; }
  $('#ringarc').setAttribute('stroke', `var(${color})`);
  $('#b-state').textContent = state;
  $('#b-prot').textContent = PROTECTION[s.protection]?.name || '–';
  $('#b-model').textContent = `${s.zones === 2 ? 'To soner' : 'Én sone'} · ${s.model || 'type ' + s.type}`;
  $('#b-help').textContent = help;
}

// ---------- dial geometry ----------
const CX = 150, CY = 150, R = 118, A0 = 135, SWEEP = 270;
const v2a = (v) => A0 + (v - RANGE.min) / (RANGE.max - RANGE.min) * SWEEP;
const pt = (a, r = R) => [CX + r * Math.cos(a * Math.PI / 180), CY + r * Math.sin(a * Math.PI / 180)];
function arc(a1, a2, r = R) {
  const [x1, y1] = pt(a1, r), [x2, y2] = pt(a2, r);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
function buildDial() {
  let ticks = '';
  for (let v = RANGE.min; v <= RANGE.max; v++) {
    const a = v2a(v), major = v % 5 === 0, [x1, y1] = pt(a, R + 16), [x2, y2] = pt(a, R + (major ? 24 : 20));
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--ink-3)" stroke-width="${major ? 1.6 : 1}" opacity="${major ? 0.8 : 0.4}" stroke-linecap="round"/>`;
  }
  const labels = [-20, -10, 0, 10].map((v) => {
    const [x, y] = pt(v2a(v), R + 38);
    return `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="10" fill="var(--ink-3)" class="tl" data-v="${v}">${v}</text>`;
  }).join('');
  $('#dialsvg').innerHTML = `
    <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="var(--deep)"/><stop offset="1" stop-color="var(--ice)"/></linearGradient></defs>
    <path d="${arc(A0, A0 + SWEEP)}" fill="none" stroke="var(--surface-2)" stroke-width="18" stroke-linecap="round"/>
    <path id="trackfill" fill="none" stroke="url(#g)" stroke-width="18" stroke-linecap="round"/>
    <circle id="curdot" r="4" fill="var(--ink)" opacity=".55"/>
    ${ticks}${labels}
    <g id="knob" style="cursor:grab"><circle r="17" fill="var(--surface)" stroke="var(--zonec)" stroke-width="3"/><circle r="5" fill="var(--zonec)"/></g>`;
}

function bindDial() {
  const el = $('#dial');
  let dragging = false;
  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * 300 - CX, y = (e.clientY - r.top) / r.height * 300 - CY;
    if (Math.hypot(x, y) < 70) return null;
    let a = Math.atan2(y, x) * 180 / Math.PI;
    if (a < 0) a += 360;
    if (a < A0 - 1) a += 360;
    let rel = (a - A0) / SWEEP;
    if (rel > 1) rel = rel > 1 + ((360 - SWEEP) / SWEEP) / 2 ? 0 : 1;
    const { min, max } = fridge.limits;
    return Math.round(Math.min(max, Math.max(min, RANGE.min + rel * (RANGE.max - RANGE.min))));
  };
  el.addEventListener('pointerdown', (e) => {
    if (!fridge?.status || e.target.closest('.round')) return;
    const v = fromEvent(e);
    if (v == null) return;
    dragging = true;
    el.setPointerCapture(e.pointerId);
    if (v !== dragValue) { dragValue = v; tick(); renderAll(); }
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const v = fromEvent(e);
    if (v != null && v !== dragValue) { dragValue = v; tick(); renderAll(); }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    commitTemp(dragValue);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  const step = (d) => {
    if (!fridge?.status) return;
    const { min, max } = fridge.limits;
    const base = dragValue ?? targetOf(zone) ?? 4;
    dragValue = Math.min(max, Math.max(min, base + d));
    tick();
    renderAll();
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => commitTemp(dragValue), 600);
  };
  $('#minus').onclick = () => step(-1);
  $('#plus').onclick = () => step(1);
}

function commitTemp(v) {
  if (v == null || !fridge) return;
  const z = zone;
  dragValue = null;
  fridge.setTemp(z, v);
  const label = zonesOf(fridge.status).find((x) => x.key === z)?.label || 'Boksen';
  toast(`${label} satt til ${fmt(v)}°${unit()}`);
  renderAll();
}
function tick() { try { navigator.vibrate?.(4); } catch { /* not supported */ } }

// ---------- controls ----------
function bindControls() {
  $('#presets').innerHTML = PRESETS.map((p) => `<button class="pre" data-t="${p.t}"><b>${p.n}</b><span class="num" data-t="${p.t}"></span></button>`).join('');
  $$('#presets .pre').forEach((b) => {
    b.onclick = () => {
      if (!fridge?.status) return;
      const { min, max } = fridge.limits;
      const t = Number(b.dataset.t);
      if (t < min || t > max) { toast('Boksen støtter ikke denne temperaturen.'); return; }
      commitTemp(t);
    };
  });

  $('#pwr').onclick = () => {
    if (!fridge?.status) return;
    if (fridge.status.on) {
      if (Date.now() - powerArmed > 3000) { powerArmed = Date.now(); toast('Trykk igjen for å slå av boksen'); return; }
      powerArmed = 0;
      fridge.setPower(false);
      toast('Slår av boksen …');
    } else {
      fridge.setPower(true);
      toast('Slår på boksen …');
    }
  };

  $$('.mode').forEach((b) => {
    b.onclick = () => {
      if (!fridge?.status) return;
      const max = b.dataset.mode === 'max';
      fridge.setSpeed(max);
      toast(max ? 'MAX: kjøler ned raskt' : 'ECO: stille og sparsom');
    };
  });

  $$('#prot button').forEach((b) => {
    b.onclick = () => {
      if (!fridge?.status) return;
      fridge.setProtection(Number(b.dataset.p));
      toast(`Batterivern: ${PROTECTION[b.dataset.p].name}`);
    };
  });
  $$('#unit button').forEach((b) => {
    b.onclick = () => { if (fridge?.status) fridge.setUnit(b.dataset.u === 'F'); };
  });

  $$('.nav button').forEach((b) => { b.onclick = () => showPage(b.dataset.v); });

  const dlg = $('#namedlg');
  const openRename = () => {
    $('#namein').value = deviceName();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  };
  $('#devname').onclick = openRename;
  $('#rename').onclick = openRename;
  $('#nameform').addEventListener('submit', (e) => {
    const ok = e.submitter?.value === 'ok';
    if (ok) {
      const v = $('#namein').value.trim();
      store.set('breego.name', v || null);
      $('#devname').textContent = deviceName();
      $('#nm').textContent = deviceName();
      toast(`Nytt navn: ${deviceName()}`);
    }
  });

  $('#disconnect').onclick = () => { fridge?.disconnect(); fridge = null; backToConnect(); };
  $('#clearlog').onclick = () => { fridge?.clearHistory(); toast('Loggen er tømt'); };

  // troubleshooting
  $('#eol').innerHTML = Object.entries(LINE_ENDINGS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#eol').onchange = (e) => { fridge?.setLineEnding(e.target.value); fridge?.send('/S00/1/-01'); };
  $('#debug').addEventListener('toggle', () => { $('#eol').value = fridge?.eol || 'lf'; renderRawLog(); });
  $('#rawform').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#raw').value.trim();
    if (v && fridge) fridge.sendRaw(v, $('#eol').value);
  });
  $('#copylog').onclick = async () => {
    const text = (fridge?.log || []).map((l) => `${clock(l.t)} ${l.dir.padEnd(4)} ${JSON.stringify(l.text)}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Loggen er kopiert'); }
    catch { toast('Fikk ikke kopiert. Merk teksten og kopier den selv.'); }
  };
  $('#ver').textContent = `versjon ${VERSION}`;
}

function showPage(v) {
  ['home', 'log', 'set'].forEach((k) => { $('#p-' + k).hidden = k !== v; });
  $$('.nav button').forEach((b) => {
    if (b.dataset.v === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (v === 'log') { drawChart(); renderEvents(); }
  if (v === 'home') sizeFrost();
}

function renderRawLog() {
  if (!$('#debug').open) return;
  const el = $('#rawlog');
  const rows = (fridge?.log || []).slice(-80);
  el.innerHTML = '';
  for (const l of rows) {
    const line = document.createElement('div');
    line.className = l.dir;
    const t = document.createElement('time'); t.textContent = clock(l.t) + ' ';
    line.append(t, `${l.dir === 'ut' ? '→' : l.dir === 'inn' ? '←' : '!'} ${JSON.stringify(l.text)}`);
    el.append(line);
  }
  el.scrollTop = el.scrollHeight;
}

function renderEvents() {
  const el = $('#events');
  const ev = fridge?.events || [];
  if (!ev.length) { el.innerHTML = '<p class="empty">Ingen hendelser ennå. Her dukker feilkoder, av og på, modusbytter og mulig åpent lokk opp.</p>'; return; }
  el.innerHTML = '';
  for (const e of ev.slice(0, 40)) {
    const row = document.createElement('div'); row.className = 'ev';
    const t = document.createElement('time'); t.textContent = clock(e.t);
    const d = document.createElement('div'); d.textContent = e.text;
    if (e.detail) { const s = document.createElement('small'); s.textContent = e.detail; d.append(s); }
    row.append(t, d); el.append(row);
  }
}

// ---------- chart ----------
function drawChart() {
  const svg = $('#chart');
  const h = fridge?.history || [];
  const dual = fridge?.status?.zones === 2;
  $('#legend').innerHTML = dual
    ? '<span><i style="background:var(--ice)"></i>Venstre</span><span><i style="background:var(--deep)"></i>Høyre</span>'
    : '<span><i style="background:var(--ice)"></i>Temperatur</span>';
  $('#chart-empty').hidden = h.length >= 2;
  if (h.length < 2) { svg.innerHTML = ''; return; }
  const X0 = 34, X1 = 312, Y0 = 12, Y1 = 150;
  const vals = h.flatMap((p) => [p.l, p.r]).filter((v) => v != null);
  let lo = Math.floor((Math.min(...vals) - 2) / 5) * 5, hi = Math.ceil((Math.max(...vals) + 2) / 5) * 5;
  if (hi - lo < 10) hi = lo + 10;
  const t0 = h[0].t, t1 = h[h.length - 1].t;
  const x = (t) => X0 + (t - t0) / Math.max(1, t1 - t0) * (X1 - X0);
  const y = (v) => Y1 - (v - lo) / (hi - lo) * (Y1 - Y0);
  const mono = 'font-size="9.5" font-family="IBM Plex Mono, monospace" fill="var(--ink-3)"';
  let g = '';
  const stepY = (hi - lo) > 20 ? 10 : 5;
  for (let v = lo; v <= hi; v += stepY) {
    g += `<line x1="${X0}" x2="${X1}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${X0 - 6}" y="${y(v) + 3.5}" text-anchor="end" ${mono}>${fmt(v)}°</text>`;
  }
  g += `<text x="${X0}" y="${Y1 + 16}" ${mono}>${clock(t0)}</text><text x="${X1}" y="${Y1 + 16}" text-anchor="end" ${mono}>${clock(t1)}</text>`;
  const series = (key, color) => {
    const pts = h.filter((p) => p[key] != null).map((p) => [x(p.t), y(p[key])]);
    if (pts.length < 2) return '';
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const last = pts[pts.length - 1];
    return `<path d="${d} L${last[0].toFixed(1)} ${Y1} L${pts[0][0].toFixed(1)} ${Y1}Z" fill="var(${color})" opacity=".08"/>` +
      `<path d="${d}" fill="none" stroke="var(${color})" stroke-width="2" stroke-linejoin="round"/>` +
      `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="var(${color})"/>`;
  };
  g += series('l', '--ice');
  if (dual) g += series('r', '--deep');
  svg.innerHTML = g;
}

// ---------- frost particles ----------
const cv = $('#frost'), cx = cv.getContext('2d');
let parts = [], W = 0, H = 0;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function sizeFrost() {
  const r = cv.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  W = r.width; H = r.height;
  cv.width = W * dpr; cv.height = H * dpr;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!parts.length) for (let i = 0; i < 46; i++) parts.push(spawn(true));
}
function spawn(init) {
  return { a: Math.random() * Math.PI * 2, r: W * (init ? 0.18 + Math.random() * 0.18 : 0.34), s: 0.6 + Math.random() * 1.8, v: 0.1 + Math.random() * 0.25, life: init ? Math.random() : 0, rot: Math.random() * 6 };
}
function frame() {
  if (W && !$('#v-main').hidden && !$('#p-home').hidden) {
    cx.clearRect(0, 0, W, H);
    const s = fridge?.status;
    const col = getComputedStyle(document.documentElement).getPropertyValue(zoneColor(targetOf(zone))).trim() || '#6cc4f5';
    const speed = s?.on ? (s.speed === 'max' ? 2.2 : 1) : 0.25;
    cx.fillStyle = col; cx.strokeStyle = col;
    parts.forEach((p, i) => {
      p.r -= p.v * speed * 0.35; p.a += 0.0015 * speed; p.life += 0.004 * speed; p.rot += 0.01;
      if (p.r < W * 0.12 || p.life > 1) { parts[i] = spawn(false); return; }
      const x = W / 2 + Math.cos(p.a) * p.r, y = H / 2 + Math.sin(p.a) * p.r;
      cx.globalAlpha = Math.sin(p.life * Math.PI) * (s?.on ? 0.55 : 0.15);
      if (p.s > 1.9) {
        cx.lineWidth = 0.8; cx.beginPath();
        for (let k = 0; k < 3; k++) { const t = p.rot + k * Math.PI / 3; cx.moveTo(x - Math.cos(t) * p.s * 1.6, y - Math.sin(t) * p.s * 1.6); cx.lineTo(x + Math.cos(t) * p.s * 1.6, y + Math.sin(t) * p.s * 1.6); }
        cx.stroke();
      } else { cx.beginPath(); cx.arc(x, y, p.s * 0.7, 0, 7); cx.fill(); }
    });
    cx.globalAlpha = 1;
  }
  if (!reduceMotion) requestAnimationFrame(frame);
}
addEventListener('resize', sizeFrost);

// ---------- boot ----------
buildDial();
bindDial();
bindControls();
initConnect();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
