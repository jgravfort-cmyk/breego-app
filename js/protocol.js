// Tefu "Intelligent Vehicle Refrigerator" protocol V1.1.x.
// Plain ASCII commands such as "/S03/1/+04", answered by a full status line "/S00/...".

export const RANGE = { min: -20, max: 10 }; // °C, fridge 0..10, freezer -20..0

// Device type codes from the supplier's model table.
export const DEVICE_TYPES = {
  '1': 'TF12', '2': 'TF18', '3': 'TF18H', '4': 'TF22', '5': 'TFE30W', '6': 'TFE40W',
  '7': 'TFS30S', '8': 'TFS40S', '9': 'TFS50S', 'A': 'TF25', 'B': 'T35', 'C': 'T55',
  'D': 'P40', 'E': 'P55', 'F': 'X30', 'H': 'X40', 'I': 'X50',
};

export const FAULTS = {
  1: { code: 'E1', title: 'Batterivernet slo av boksen', help: 'Spenningen ble for lav. Start bilen, bytt til 230 V eller velg et lavere batterivern.' },
  2: { code: 'E2', title: 'For høy strøm i viften', help: 'Sjekk at ingenting blokkerer viften og at luftehullene er åpne.' },
  3: { code: 'E3', title: 'Kompressoren starter ikke', help: 'Slå boksen av og på igjen. Sjekk at strømkabelen sitter godt.' },
  4: { code: 'E4', title: 'Feil turtall på kompressoren', help: 'Slå boksen av og på igjen. Kontakt Breego hvis feilen kommer tilbake.' },
  5: { code: 'E5', title: 'Kompressoren ble for varm', help: 'Gi boksen bedre lufting og la den kjøle seg ned før du starter igjen.' },
  6: { code: 'E6', title: 'Feil på temperaturføleren', help: 'Boksen har stoppet. Kontakt Breego for service.' },
};

export const PROTECTION = {
  1: { name: 'Lav', help: 'Kjører lengst. Bruk med et eget fritidsbatteri, ikke startbatteriet.' },
  2: { name: 'Middels', help: 'Et godt valg i de fleste biler.' },
  3: { name: 'Høy', help: 'Slår av tidligst. Tryggest for startbatteriet når bilen står lenge.' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** "+06", "-18", "+00": sign plus two digits, three characters in total. */
export function formatTemp(celsius) {
  const n = clamp(Math.round(celsius), -99, 99);
  return (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(2, '0');
}

export const command = {
  status: () => '/S00/1/-01',
  bind: () => '/S00/2/-01',
  power: (on) => `/S01/1/00${on ? 1 : 0}`,
  leftTemp: (c) => `/S03/1/${formatTemp(c)}`,
  protection: (level) => `/S04/1/00${clamp(level | 0, 1, 3)}`,
  rightTemp: (c) => `/S05/1/${formatTemp(c)}`,
  speed: (max) => `/S06/1/00${max ? 2 : 1}`,
  unit: (fahrenheit) => `/S07/1/00${fahrenheit ? 2 : 1}`,
};

/** Line endings to try. The spec says commands are 12 characters, which fits a literal "\n". */
export const LINE_ENDINGS = {
  lf: { label: 'Linjeskift (\\n som tegn 10)', value: '\n' },
  literal: { label: 'Bokstavelig «\\n» (to tegn)', value: '\\n' },
  crlf: { label: 'CR + LF', value: '\r\n' },
  none: { label: 'Ingen', value: '' },
};

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse one complete line from the box. */
export function parseLine(raw) {
  const line = String(raw).trim();
  let m = line.match(/^\/S00\/([0-9A-Za-z])\/(.+)$/);
  if (m) {
    const f = m[2].split(',').map((x) => x.trim());
    if (f.length < 10) return { kind: 'unknown', raw: line };
    const volt = num(f[8]);
    return {
      kind: 'status',
      type: m[1].toUpperCase(),
      model: DEVICE_TYPES[m[1].toUpperCase()] || null,
      zones: num(f[0]) === 2 ? 2 : 1,
      on: num(f[1]) === 1,
      unit: num(f[2]) === 2 ? 'F' : 'C',
      leftCur: num(f[3]),     // in the box's display unit
      rightCur: num(f[4]),    // in the box's display unit
      leftSet: num(f[5]),     // always °C
      rightSet: num(f[6]),    // always °C
      protection: num(f[7]),
      volt: volt == null ? null : volt / 10,
      speed: num(f[9]) === 2 ? 'max' : 'eco',
      max: num(f[10]),
      min: num(f[11]),
      binding: num(f[12]),
      raw: line,
    };
  }
  m = line.match(/^\/SEE\/(\d)\/(\d+)$/);
  if (m) return { kind: 'fault', zone: Number(m[1]), code: Number(m[2]), raw: line };
  return { kind: 'unknown', raw: line };
}

/**
 * Bluetooth notifications arrive in pieces of about 20 bytes. This joins them
 * into whole lines. A line ends at a real newline, a literal "\n", or a short pause.
 */
export class LineAssembler {
  constructor(onLine, idleMs = 350) {
    this.onLine = onLine;
    this.idleMs = idleMs;
    this.buf = '';
    this.timer = null;
  }
  push(text) {
    this.buf += text;
    const parts = this.buf.split(/\r?\n|\\n/);
    this.buf = parts.pop();
    for (const p of parts) if (p.trim()) this.onLine(p.trim());
    // A new message starting mid-buffer means the previous one had no line ending.
    const next = this.buf.indexOf('/S', 1);
    if (next > 0 && this.buf[0] === '/') {
      const head = this.buf.slice(0, next);
      if (head.trim()) this.onLine(head.trim());
      this.buf = this.buf.slice(next);
    }
    clearTimeout(this.timer);
    if (this.buf) this.timer = setTimeout(() => this.flush(), this.idleMs);
  }
  flush() {
    clearTimeout(this.timer);
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.onLine(rest);
  }
}

export const toCelsius = (v, unit) => (v == null ? null : unit === 'F' ? (v - 32) * 5 / 9 : v);
export const fromCelsius = (c, unit) => (c == null ? null : unit === 'F' ? c * 9 / 5 + 32 : c);
