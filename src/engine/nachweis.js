// Erkennung der Leistungsnachweise, Berechnung der indirekten Zeit und Eintragen per
// inkrementellem Update. Alle Stundenwerte als ganze Hundertstel (centi) – exakt gerundet.
import {
  PDFError, PDict, PName, PRef, PStream, PString, ByteWriter, writeObject, formatNumber, toHex, ascii, intOf,
} from './core.js';
import { PDFFile } from './file.js';
import { TextExtractor, layoutLines, FontInfo, standardWidths } from './text.js';
import { bundledFont } from './fonts.js';

// ---------------------------------------------------------------- Zahlen

/** a/b kaufmaennisch gerundet (a >= 0, b > 0) */
export const rhu = (a, b) => Math.floor((2 * a + b) / (2 * b));

export const DE = {
  /** "117,83" -> 11783 ; "3,8" -> 380 ; "12" -> 1200 ; "265,71 Stunden" -> 26571 (prefixOnly) */
  parseCenti(raw, prefixOnly = false) {
    let s = String(raw).trim();
    if (prefixOnly) {
      const m = /^[0-9.,-]*/.exec(s);
      s = m ? m[0] : '';
    } else {
      for (const suffix of [' Stunden', ' Std.', ' Std', ' h', 'h']) {
        if (s.endsWith(suffix)) s = s.slice(0, -suffix.length).trim();
      }
    }
    if (!s) return null;
    let neg = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    if (!/^[0-9][0-9.,]*$/.test(s)) return null;
    if ((s.match(/,/g) || []).length > 1) return null;
    let intPart = s;
    let frac = '';
    const c = s.indexOf(',');
    if (c >= 0) {
      intPart = s.slice(0, c);
      frac = s.slice(c + 1);
      if (!frac || !/^[0-9]+$/.test(frac)) return null;
    } else if ((s.match(/\./g) || []).length === 1 && s.length - s.indexOf('.') - 1 !== 3) {
      const d = s.indexOf('.');
      intPart = s.slice(0, d);
      frac = s.slice(d + 1);
    }
    const groups = intPart.split('.');
    if (groups.length > 1 && !groups.slice(1).every((g) => g.length === 3)) return null;
    intPart = groups.join('');
    if (!intPart || !/^[0-9]+$/.test(intPart)) return null;
    let centi = parseInt(intPart, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    if (frac.length > 2 && parseInt(frac[2], 10) >= 5) centi += 1;
    return neg ? -centi : centi;
  },

  /** "3:50" -> 230 Minuten */
  parseHourMinute(raw) {
    const m = /^\s*(\d{1,4}):(\d{2})\s*$/.exec(raw);
    if (!m) return null;
    const mm = parseInt(m[2], 10);
    if (mm >= 60) return null;
    return parseInt(m[1], 10) * 60 + mm;
  },

  /** "08:15 - 13:10" -> 295 Minuten */
  parseTimeRange(raw) {
    let s = String(raw).replace(/[–—]/g, '-').replace(/ bis /g, '-').replace(/Uhr/g, '');
    const parts = s.split('-').map((x) => x.trim());
    if (parts.length !== 2) return null;
    const a = clock(parts[0]), b = clock(parts[1]);
    if (a === null || b === null) return null;
    let d = b - a;
    if (d < 0) d += 24 * 60;
    return d;
  },

  /** 380 -> "3,80" */
  format(centi) {
    const neg = centi < 0;
    const v = Math.abs(centi);
    return (neg ? '-' : '') + Math.floor(v / 100) + ',' + String(v % 100).padStart(2, '0');
  },

  /** 300 -> "3", 1302 -> "13,02" */
  formatKurz(centi) {
    let s = DE.format(centi);
    while (s.includes(',') && s.endsWith('0')) s = s.slice(0, -1);
    if (s.endsWith(',')) s = s.slice(0, -1);
    return s;
  },

  formatHourMinute(minutes) {
    const m = Math.abs(minutes);
    return (minutes < 0 ? '-' : '') + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
  },

  centiFromMinutes: (min) => rhu(min * 100, 60),
};

function clock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 24 || mm >= 60) return null;
  return h * 60 + mm;
}

// ---------------------------------------------------------------- Datum

export class Tag {
  constructor(year, month, day) { this.year = year; this.month = month; this.day = day; }
  get key() { return this.year * 10000 + this.month * 100 + this.day; }
  toString() { return `${String(this.day).padStart(2, '0')}.${String(this.month).padStart(2, '0')}.${this.year}`; }
  get kurz() { return `${String(this.day).padStart(2, '0')}.${String(this.month).padStart(2, '0')}.`; }

  get ordinal() {
    const y = this.month <= 2 ? this.year - 1 : this.year;
    const era = Math.floor((y >= 0 ? y : y - 399) / 400);
    const yoe = y - era * 400;
    const mp = (this.month + 9) % 12;
    const doy = Math.floor((153 * mp + 2) / 5) + this.day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  static daysInMonth(y, m) {
    if ([1, 3, 5, 7, 8, 10, 12].includes(m)) return 31;
    if ([4, 6, 9, 11].includes(m)) return 30;
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  }

  /** "01.09.2026 Di", "Di, 01.09.2026", "01.09.26" am Anfang eines Textes */
  static parseAtStart(raw) {
    let s = String(raw).trim();
    const lm = /^[A-Za-zÄÖÜäöü]{1,3}[,. ]+/.exec(s);
    if (lm) s = s.slice(lm[0].length);
    else if (/^[A-Za-zÄÖÜäöü]/.test(s)) return null;
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?!\d)/.exec(s);
    if (!m) return null;
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    if (y < 100) y += 2000;
    return new Tag(y, mo, d);
  }

  static parseRange(s) {
    const n = String(s).replace(/–/g, '-').replace(/ bis /g, ' - ');
    const parts = n.split(' - ');
    if (parts.length !== 2) return null;
    const a = Tag.parseAtStart(parts[0]), b = Tag.parseAtStart(parts[1]);
    return a && b ? [a, b] : null;
  }

  static fullMonths(von, bis) {
    if (von.day !== 1 || bis.day !== Tag.daysInMonth(bis.year, bis.month)) return null;
    const m = (bis.year - von.year) * 12 + (bis.month - von.month) + 1;
    return m >= 1 ? m : null;
  }
}

// ---------------------------------------------------------------- Analyse

const isDirektLabel = (n) => {
  if (n.includes('indirekt')) return false;
  return n.startsWith('direkte stunden') || n.startsWith('direkte zeit') || n === 'summe' || n === 'summe stunden'
    || n.startsWith('summe direkt') || n === 'direkt' || n === 'stunden direkt' || n.startsWith('direkte fachleistungsstunden');
};
const isIndirektLabel = (n) => n.startsWith('indirekt') || n.startsWith('summe indirekt') || n.startsWith('stunden indirekt')
  || n.startsWith('davon indirekt') || n.startsWith('zzgl. indirekt') || n.startsWith('zzgl indirekt');
const isGesamtLabel = (n) => {
  if (n.includes('direkt')) return false;
  return n.startsWith('gesamtstunden') || n.startsWith('gesamtzeit') || n === 'gesamt' || n === 'stunden gesamt'
    || n.startsWith('gesamtsumme') || n.startsWith('summe gesamt') || n.startsWith('gesamt stunden')
    || n.startsWith('gesamte stunden') || n.startsWith('gesamtanzahl');
};
const isStundenKopf = (n) => ['stunden', 'std', 'std.', 'anzahl', 'dauer', 'stunden (dezimal)', 'anzahl stunden', 'fachleistungsstunden'].includes(n);
export const ohneUnterstriche = (s) => (s.includes('_') ? s.replace(/_/g, '').replace(/ /g, '') : s);
const isWert = (s) => {
  const t = ohneUnterstriche(s);
  return DE.parseCenti(t) !== null || DE.parseHourMinute(t) !== null;
};
const isPlatzhalter = (s) => {
  const t = s.trim();
  return t.length > 0 && [...t].every((c) => c === '_' || c === '.' || c === '…');
};

export const wertText = (feld) => (feld && feld.wert ? ohneUnterstriche(feld.wert.text) : null);

function neuerNachweis() {
  return {
    name: null, zeitraum: null, bewilligt: null, stundenSpalte: null, stundenKopf: null, eintraege: [],
    direkt: null, indirekt: null, gesamt: null, ersteSeite: 0, letzteSeite: 0,
  };
}
const hatInhalt = (n) => n.eintraege.length > 0 || !!n.direkt || !!n.indirekt || !!n.gesamt;
const hatSummen = (n) => !!n.indirekt || !!n.gesamt;

export function anwesenheitstage(n) {
  const map = new Map();
  for (const e of n.eintraege) {
    const h = e.stunden !== null ? e.stunden : e.minuten !== null ? DE.centiFromMinutes(e.minuten) : 0;
    if (h > 0) map.set(e.tag.key, e.tag);
  }
  return [...map.values()].sort((a, b) => a.key - b.key);
}

export function mehrfachTage(n) {
  const count = new Map();
  for (const e of n.eintraege) {
    if ((e.stunden || 0) > 0 || (e.minuten || 0) > 0) {
      const c = count.get(e.tag.key) || { tag: e.tag, n: 0 };
      c.n++;
      count.set(e.tag.key, c);
    }
  }
  return [...count.values()].filter((c) => c.n > 1).map((c) => c.tag).sort((a, b) => a.key - b.key);
}

function fuelle(e, runs, spalte) {
  for (const r of runs) {
    if (e.minuten === null) {
      const m = DE.parseTimeRange(r.text);
      if (m !== null) e.minuten = m;
    }
  }
  if (spalte) {
    for (const r of runs) {
      if (!(r.minX >= spalte.minX - 1 && r.maxX <= spalte.maxX + 30 && r.minX <= spalte.maxX)) continue;
      const v = DE.parseCenti(r.text);
      if (v !== null) { e.stunden = v; e.stundenText = r.text; return; }
      const hm = DE.parseHourMinute(r.text);
      if (hm !== null) { e.stunden = DE.centiFromMinutes(hm); e.stundenText = r.text; return; }
    }
    return;
  }
  for (const r of runs) {
    if (!r.text.includes(',')) continue;
    const v = DE.parseCenti(r.text);
    if (v !== null) { e.stunden = v; e.stundenText = r.text; return; }
  }
}

export function analyze(lines) {
  const result = [];
  let cur = neuerNachweis();
  let tabelleAktiv = false;
  const abschliessen = () => {
    if (hatInhalt(cur)) result.push(cur);
    cur = neuerNachweis();
    tabelleAktiv = false;
  };

  for (const line of lines) {
    const runs = line.runs.slice().sort((a, b) => a.minX - b.minX);
    const norms = runs.map((r) => r.normalized);
    if (!cur.eintraege.length && !hatSummen(cur) && cur.name === null) cur.ersteSeite = line.page;

    // Kopfbereich
    let i = norms.findIndex((n) => n === 'junger mensch' || n === 'klient' || n === 'klientin' || n === 'name des jungen menschen');
    if (i >= 0) {
      if (hatSummen(cur) || cur.eintraege.length) { abschliessen(); cur.ersteSeite = line.page; }
      if (i + 1 < runs.length) cur.name = runs[i + 1].text;
    }
    i = norms.findIndex((n) => n === 'leistungszeitraum' || n === 'zeitraum' || n === 'abrechnungszeitraum');
    if (i >= 0 && i + 1 < runs.length && Tag.parseAtStart(runs[i + 1].text) && cur.zeitraum === null) {
      cur.zeitraum = runs[i + 1].text;
    }
    i = norms.findIndex((n) => n.startsWith('bewilligte std') || n.startsWith('bewilligte stunden') || n.startsWith('bewilligte fachleistungsstunden'));
    if (i >= 0 && i + 1 < runs.length) {
      const v = DE.parseCenti(runs[i + 1].text, true);
      if (v !== null) cur.bewilligt = v;
    }

    // Tabellenkopf
    const si = norms.findIndex(isStundenKopf);
    if (si >= 0 && norms.some((n) => n === 'tag' || n === 'datum' || n.startsWith('zeitbereich') || n === 'uhrzeit' || n === 'zeit')) {
      // Wiederholter Kopf nach Seitenumbruch gehoert noch zum selben Nachweis
      if (cur.indirekt && cur.gesamt) { abschliessen(); cur.ersteSeite = line.page; }
      const kopf = runs[si];
      const rechts = runs.filter((r) => r.minX > kopf.maxX + 1).map((r) => r.minX);
      cur.stundenKopf = kopf;
      cur.stundenSpalte = { minX: kopf.minX - 4, maxX: (rechts.length ? Math.min(...rechts) : kopf.maxX + 60) - 2 };
      tabelleAktiv = true;
      cur.letzteSeite = line.page;
      continue;
    }

    if (!runs.length) continue;
    const first = runs[0];

    // Leistungszeilen (beginnen mit einem Datum)
    const tag = Tag.parseAtStart(first.text);
    if (tag) {
      const e = { tag, stunden: null, stundenText: null, minuten: null, page: line.page, y: line.y };
      fuelle(e, runs.slice(1), cur.stundenSpalte);
      const istDatenzeile = tabelleAktiv || e.minuten !== null || e.stunden !== null;
      if (istDatenzeile && !hatSummen(cur)) {
        cur.eintraege.push(e);
        cur.letzteSeite = line.page;
      }
      continue;
    }

    // Summenzeilen
    let summenZeile = false;
    norms.forEach((n, idx) => {
      if (n.length > 48) return;
      let typ = 0;
      if (isIndirektLabel(n)) typ = 2;
      else if (isGesamtLabel(n)) typ = 3;
      else if (isDirektLabel(n)) typ = 1;
      if (!typ) return;
      const label = runs[idx];
      let wert = null, platzhalter = null, belegt = null;
      for (const r of runs.slice(idx + 1)) {
        if (!(r.minX > label.maxX)) continue;
        if (cur.stundenSpalte) {
          if (r.minX >= cur.stundenSpalte.maxX) break;
        } else if (r.minX > label.maxX + 140) break;
        if (isWert(r.text)) wert = r;
        else if (isPlatzhalter(r.text)) platzhalter = r;
        else belegt = r;
        break;
      }
      const feld = { label, wert, platzhalter, belegt };
      if (typ === 1) cur.direkt = feld;
      else if (typ === 2) cur.indirekt = feld;
      else cur.gesamt = feld;
      summenZeile = true;
      cur.letzteSeite = line.page;
      tabelleAktiv = false;
    });
    if (summenZeile) continue;

    // weitere Zeit am selben Tag ohne eigenes Datum
    if (tabelleAktiv && cur.eintraege.length && !hatSummen(cur) && runs.some((r) => DE.parseTimeRange(r.text) !== null)) {
      const e = { tag: cur.eintraege[cur.eintraege.length - 1].tag, stunden: null, stundenText: null, minuten: null, page: line.page, y: line.y };
      fuelle(e, runs, cur.stundenSpalte);
      if (e.stunden !== null || e.minuten !== null) cur.eintraege.push(e);
    }
  }
  abschliessen();
  return result;
}

// ---------------------------------------------------------------- Regeln

export const STANDORTE = [
  {
    id: 'segeberg',
    name: 'Segeberg',
    kurz: '12 Minuten pro Anwesenheitstag',
    berechne(n) {
      const tage = anwesenheitstage(n).length;
      return { centi: tage * 20, minuten: tage * 12, formel: `${tage} ${tage === 1 ? 'Anwesenheitstag' : 'Anwesenheitstage'} × 12 Min.` };
    },
  },
  {
    id: 'pinneberg',
    name: 'Pinneberg',
    kurz: '20 % der direkten Stunden, höchstens 3 Std. pro Woche und 13,02 Std. im Monat',
    berechne(n, direktCenti) {
      const anteil = rhu(direktCenti, 5); // 20 %
      const { grenze, text } = pinnebergGrenze(n);
      if (anteil > grenze) {
        return { centi: grenze, formel: `20 % von ${DE.format(direktCenti)} Std. = ${DE.format(anteil)} → max. ${DE.format(grenze)} (${text})` };
      }
      return { centi: anteil, formel: `20 % von ${DE.format(direktCenti)} Std.` };
    },
  },
];

export const standortById = (id) => STANDORTE.find((s) => s.id === id) || STANDORTE[0];

/** Volle Monate: 13,02 Std. je Monat. Teilzeitraeume: 3 Std. pro Woche, anteilig (hoechstens 13,02 je Monat). */
function pinnebergGrenze(n) {
  const r = n.zeitraum ? Tag.parseRange(n.zeitraum) : null;
  if (!r || r[0].ordinal > r[1].ordinal) return { grenze: 1302, text: 'Monatsgrenze' };
  const [von, bis] = r;
  const m = Tag.fullMonths(von, bis);
  if (m) return { grenze: 1302 * m, text: m === 1 ? 'Monatsgrenze' : `${m} Monate` };
  const tage = bis.ordinal - von.ordinal + 1;
  let g = rhu(300 * tage, 7);
  if (tage <= 31 && g > 1302) g = 1302;
  return { grenze: g, text: `3 Std./Woche bei ${tage} Tagen` };
}

// ---------------------------------------------------------------- Inkrementelles Update

class IncrementalUpdate {
  constructor(file) {
    this.file = file;
    this.nextNum = file.nextObjectNumber;
    this.objects = [];
  }
  add(o) {
    const r = new PRef(this.nextNum++, 0);
    this.objects.push([r, o]);
    return r;
  }
  replace(r, o) {
    const i = this.objects.findIndex(([x]) => x.num === r.num);
    if (i >= 0) this.objects[i] = [this.objects[i][0], o];
    else this.objects.push([r, o]);
  }
  build() {
    const file = this.file;
    const w = new ByteWriter(file.data);
    const last = file.data[file.data.length - 1];
    if (last !== 0x0a && last !== 0x0d) w.str('\n');
    const offsets = new Map();
    for (const [r, o] of this.objects.slice().sort((a, b) => a[0].num - b[0].num)) {
      offsets.set(r.num, { offset: w.length, gen: r.gen });
      w.str(`${r.num} ${r.gen} obj\n`);
      writeObject(w, o);
      w.str('\nendobj\n');
    }
    const trailer = new PDict();
    for (const [k, v] of file.trailer.entries()) {
      if (!['Prev', 'XRefStm', 'Size', 'Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms', 'DL'].includes(k)) trailer.set(k, v);
    }
    const compressed = new Map();
    if (file.wasReconstructed) {
      for (const [num, e] of file.allEntries()) {
        if (offsets.has(num)) continue;
        if (e.type === 1) offsets.set(num, { offset: e.a, gen: e.b });
        else if (e.type === 2) compressed.set(num, { stream: e.a, index: e.b });
      }
    } else trailer.set('Prev', file.startXref);

    if (file.lastXrefIsStream || compressed.size) {
      const xrefNum = this.nextNum++;
      const xrefOffset = w.length;
      offsets.set(xrefNum, { offset: xrefOffset, gen: 0 });
      let nums = [...new Set([...offsets.keys(), ...compressed.keys()])].sort((a, b) => a - b);
      if (file.wasReconstructed && !nums.includes(0)) nums = [0, ...nums];
      let maxOff = 0;
      for (const o of offsets.values()) maxOff = Math.max(maxOff, o.offset);
      for (const c of compressed.values()) maxOff = Math.max(maxOff, c.stream);
      let w1 = 1;
      while (2 ** (8 * w1) <= maxOff) w1++;
      w1 = Math.max(w1, 4);
      const bin = [];
      const put = (v, width) => { for (let k = width - 1; k >= 0; k--) bin.push(Math.floor(v / 2 ** (8 * k)) & 255); };
      const index = [];
      for (let i = 0; i < nums.length;) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        index.push(nums[i], j - i + 1);
        for (let k = i; k <= j; k++) {
          const n = nums[k];
          if (offsets.has(n)) { const o = offsets.get(n); put(1, 1); put(o.offset, w1); put(o.gen, 2); }
          else if (compressed.has(n)) { const c = compressed.get(n); put(2, 1); put(c.stream, w1); put(c.index, 2); }
          else { put(0, 1); put(0, w1); put(n === 0 ? 0xffff : 0, 2); }
        }
        i = j + 1;
      }
      const d = trailer.clone();
      d.set('Type', new PName('XRef'));
      d.set('Size', this.nextNum);
      d.set('Index', index);
      d.set('W', [1, w1, 2]);
      w.str(`${xrefNum} 0 obj\n`);
      writeObject(w, new PStream(d, Uint8Array.from(bin)));
      w.str(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
    } else {
      const xrefOffset = w.length;
      w.str('xref\n');
      let nums = [...offsets.keys()].sort((a, b) => a - b);
      if (file.wasReconstructed) nums = [0, ...nums];
      for (let i = 0; i < nums.length;) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        w.str(`${nums[i]} ${j - i + 1}\n`);
        for (let k = i; k <= j; k++) {
          const o = offsets.get(nums[k]);
          if (o) w.str(`${String(o.offset).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n\r\n`);
          else w.str('0000000000 65535 f\r\n');
        }
        i = j + 1;
      }
      trailer.set('Size', this.nextNum);
      w.str('trailer\n');
      writeObject(w, trailer);
      w.str(`\nstartxref\n${xrefOffset}\n%%EOF\n`);
    }
    return w.result();
  }
}

// ---------------------------------------------------------------- Eintragen (Stamper)

function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function embedBundled(f, upd) {
  const ttf = base64ToBytes(f.base64);
  const tagged = 'KZDIGT+' + f.postScriptName;
  const fontFile = upd.add(new PStream(new PDict([['Length1', ttf.length]]), ttf));
  const descriptor = upd.add(new PDict([
    ['Type', new PName('FontDescriptor')], ['FontName', new PName(tagged)], ['Flags', 4], ['FontBBox', f.bbox],
    ['ItalicAngle', 0], ['Ascent', f.ascent], ['Descent', f.descent], ['CapHeight', f.capHeight], ['StemV', f.stemV],
    ['FontFile2', fontFile],
  ]));
  const glyphs = Object.entries(f.glyphs).sort((a, b) => a[1][0] - b[1][0]);
  const w = [];
  for (const [, [gid, width]] of glyphs) { w.push(gid, [width]); }
  const cid = upd.add(new PDict([
    ['Type', new PName('Font')], ['Subtype', new PName('CIDFontType2')], ['BaseFont', new PName(tagged)],
    ['CIDSystemInfo', new PDict([['Registry', new PString(ascii('Adobe'))], ['Ordering', new PString(ascii('Identity'))], ['Supplement', 0]])],
    ['FontDescriptor', descriptor], ['DW', 0], ['CIDToGIDMap', new PName('Identity')], ['W', w],
  ]));
  let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  cmap += `${glyphs.length} beginbfchar\n`;
  for (const [ch, [gid]] of glyphs) {
    const u = [...ch].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('');
    cmap += `<${gid.toString(16).toUpperCase().padStart(4, '0')}> <${u}>\n`;
  }
  cmap += 'endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  const toUnicode = upd.add(new PStream(new PDict(), ascii(cmap)));
  return upd.add(new PDict([
    ['Type', new PName('Font')], ['Subtype', new PName('Type0')], ['BaseFont', new PName(tagged)],
    ['Encoding', new PName('Identity-H')], ['DescendantFonts', [cid]], ['ToUnicode', toUnicode],
  ]));
}

export function stamp(items, file, linien = []) {
  if (file.isEncrypted) throw new PDFError('encrypted', 'Die PDF ist verschlüsselt bzw. geschützt');
  const pages = file.pageRefs();
  const upd = new IncrementalUpdate(file);
  const placed = [];
  const bundledRefs = new Map();
  const helvRefs = new Map();
  const fontInfos = new Map();
  const fontInfo = (fr) => {
    if (fontInfos.has(fr.num)) return fontInfos.get(fr.num);
    const fd = file.dictionary(fr);
    const f = fd ? new FontInfo(file, fd, fr) : null;
    fontInfos.set(fr.num, f);
    return f;
  };
  const f = formatNumber;

  const seiten = [...new Set([...items.map((i) => i.seite), ...linien.map((l) => l.seite)])].sort((a, b) => a - b);
  for (const seite of seiten) {
    if (seite < 0 || seite >= pages.length) throw new PDFError('notFound', 'Seite ' + (seite + 1));
    const pageRef = pages[seite];
    const pageDict = file.dictionary(pageRef);
    if (!pageDict) throw new PDFError('notFound', 'Seite ' + (seite + 1));
    const newPage = pageDict.clone();
    const resources = file.pageResources(pageDict).clone();
    const fonts = (file.dictionary(resources.get('Font')) || new PDict()).clone();
    let resourcesChanged = false;
    const nameFor = (ref, prefix) => {
      for (const [k, v] of fonts.entries()) if (v instanceof PRef && v.num === ref.num) return k;
      let i = 1;
      while (fonts.has(prefix + i)) i++;
      fonts.set(prefix + i, ref);
      resourcesChanged = true;
      return prefix + i;
    };

    let ops = '\nQ\nq\n';
    // Tabellenlinien (beim Einfuegen neuer Zeilen)
    const seitenLinien = linien.filter((l) => l.seite === seite);
    if (seitenLinien.length) {
      ops += 'q\n0 G\n0 J\n0 j\n[] 0 d\n';
      for (const l of seitenLinien) ops += `${f(l.lw)} w\n${f(l.x1)} ${f(l.y1)} m\n${f(l.x2)} ${f(l.y2)} l\nS\n`;
      ops += 'Q\n';
    }
    for (const item of items.filter((x) => x.seite === seite)) {
      let choice = null;
      // 1) gleiche Schrift aus dem Dokument, wenn alle Zeichen vorhanden sind
      if (item.vorbildFontRef) {
        const info = fontInfo(item.vorbildFontRef);
        const codes = info ? info.codesForText(item.text) : null;
        if (codes) {
          const width = (codes.reduce((s, c) => s + info.width(c), 0) / 1000) * item.groesse;
          const bytes = info.codeBytes === 2 ? codes.flatMap((c) => [(c >> 8) & 255, c & 255]) : codes.map((c) => c & 255);
          choice = { resName: nameFor(item.vorbildFontRef, 'KZF'), hex: toHex(Uint8Array.from(bytes)), width, label: info.baseFont };
        }
      }
      // 2) mitgelieferte Schrift gleichen Namens (Lato), als kleine Teilmenge eingebettet
      if (!choice) {
        const b = bundledFont(item.vorbildFontName);
        if (b && [...item.text].every((ch) => b.glyphs[ch])) {
          let ref = bundledRefs.get(b.postScriptName);
          if (!ref) { ref = embedBundled(b, upd); bundledRefs.set(b.postScriptName, ref); }
          const bytes = [];
          let width = 0;
          for (const ch of item.text) {
            const [gid, w] = b.glyphs[ch];
            bytes.push((gid >> 8) & 255, gid & 255);
            width += w;
          }
          choice = { resName: nameFor(ref, 'KZL'), hex: toHex(Uint8Array.from(bytes)), width: (width / 1000) * item.groesse, label: b.postScriptName };
        }
      }
      // 3) Helvetica als Rueckfallebene
      if (!choice) {
        const base = item.vorbildFett ? 'Helvetica-Bold' : 'Helvetica';
        let ref = helvRefs.get(base);
        if (!ref) {
          ref = upd.add(new PDict([['Type', new PName('Font')], ['Subtype', new PName('Type1')], ['BaseFont', new PName(base)], ['Encoding', new PName('WinAnsiEncoding')]]));
          helvRefs.set(base, ref);
        }
        const widths = standardWidths(base);
        const bytes = [];
        let width = 0;
        for (const ch of item.text) {
          const c = ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63;
          bytes.push(c);
          width += widths.get(c) || 556;
        }
        choice = { resName: nameFor(ref, 'KZH'), hex: toHex(Uint8Array.from(bytes)), width: (width / 1000) * item.groesse, label: base };
      }
      const x = item.rechtsbuendig ? item.x - choice.width : item.x;
      ops += `BT\n/${choice.resName} ${f(item.groesse)} Tf\n0 g\n1 0 0 1 ${f(x)} ${f(item.y)} Tm\n<${choice.hex}> Tj\nET\n`;
      placed.push({ seite, text: item.text, x, y: item.y, breite: choice.width, groesse: item.groesse, schrift: choice.label });
    }
    ops += 'Q\n';

    const prefix = upd.add(new PStream(new PDict(), ascii('q\n')));
    const suffix = upd.add(new PStream(new PDict(), ascii(ops)));
    let contents = [prefix];
    const c = pageDict.get('Contents');
    if (c !== undefined) {
      const rc = file.resolve(c);
      if (Array.isArray(rc)) contents = contents.concat(rc);
      else contents.push(c);
    }
    contents.push(suffix);
    newPage.set('Contents', contents);
    if (resourcesChanged) {
      resources.set('Font', fonts);
      newPage.set('Resources', resources);
    }
    upd.replace(pageRef, newPage);
  }
  return { data: upd.build(), placed };
}

// ---------------------------------------------------------------- Ablauf

/** Text und Grafik aller Seiten */
export function seitenDaten(file) {
  const ex = new TextExtractor(file);
  return file.pageRefs().map((ref, i) => {
    const s = ex.seite(ref);
    return { ...s, lines: layoutLines(s.glyphs, i) };
  });
}

export function linesOf(file, seiten) {
  return (seiten || seitenDaten(file)).flatMap((s) => s.lines);
}

function platzierung(feld, text, vorbild, direktLabel, kopf, spalte) {
  const label = feld.label;
  const ref = vorbild || label;
  let y = label.y;
  if (vorbild && direktLabel) y = label.y + (vorbild.y - direktLabel.y);
  let x;
  let rechts = false;
  if (feld.platzhalter) {
    x = feld.platzhalter.minX + 1;
    y = feld.platzhalter.y + 0.15 * ref.size;
  } else if (vorbild) {
    if (spalte) {
      const links = vorbild.minX - spalte.minX;
      const rechtsAbstand = spalte.maxX - vorbild.maxX;
      if (links <= rechtsAbstand + 0.5) x = vorbild.minX;
      else { x = vorbild.maxX; rechts = true; }
    } else x = vorbild.minX;
  } else if (kopf) x = kopf.minX;
  else x = label.maxX + 0.6 * label.size;
  return {
    seite: label.page, text, x, y, rechtsbuendig: rechts, groesse: ref.size,
    vorbildFontRef: ref.fontRef, vorbildFontName: ref.fontBaseName, vorbildFett: ref.fontIsBold,
  };
}

// ---------------------------------------------------------------- Zeilen einfuegen

export const NEUE_ZEILEN = ['Indirekte Stunden gesamt', 'Gesamtstunden'];

const zusammenfassen = (werte, tol) => {
  const out = [];
  for (const v of werte.slice().sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
};

/** Ist der Bereich (ohne Raender) frei von Text, Linien, Flaechen und Bildern? */
function bereichFrei(seite, x1, x2, y1, y2) {
  const ueberlappt = (a1, a2, b1, b2, c1, c2, d1, d2) => a1 < b2 && a2 > b1 && c1 < d2 && c2 > d1;
  for (const g of seite.glyphs) {
    if (!g.text || !g.text.trim()) continue;
    if (ueberlappt(Math.min(g.x, g.x2), Math.max(g.x, g.x2), x1, x2, g.y - 0.22 * g.size, g.y + 0.78 * g.size, y1, y2)) return false;
  }
  const [mx1, my1, mx2, my2] = seite.mediaBox;
  const seitenFlaeche = Math.abs((mx2 - mx1) * (my2 - my1));
  for (const g of seite.grafik) {
    const lw = g.lw ? g.lw / 2 : 0;
    const gx1 = Math.min(g.x1, g.x2) - lw, gx2 = Math.max(g.x1, g.x2) + lw;
    const gy1 = Math.min(g.y1, g.y2) - lw, gy2 = Math.max(g.y1, g.y2) + lw;
    // Seitenhintergruende ignorieren
    if (g.art === 'flaeche' && (gx2 - gx1) * (gy2 - gy1) > 0.25 * seitenFlaeche) continue;
    if (ueberlappt(gx1, gx2, x1, x2, gy1, gy2, y1, y2)) return false;
  }
  return true;
}

/**
 * Plant zwei neue Tabellenzeilen unter der Summenzeile – im Stil der vorhandenen Zeile.
 * Volle Tabellenbreite, wenn darunter Platz ist, sonst nur bis zur Stundenspalte.
 */
function einfuegePlan(n, seite, werte) {
  const d = n.direkt;
  if (!d || !d.wert) return { fehler: 'Die Zeile „Summe“ mit den direkten Stunden wurde nicht gefunden.' };
  const L = d.label, V = d.wert;
  const s = V.size || 9;
  const yb = L.y;
  const linien = seite.grafik.filter((g) => g.art === 'linie' && !g.kurve);
  const waagrecht = linien.filter((g) => Math.abs(g.y1 - g.y2) < 0.05
    && Math.min(g.x1, g.x2) <= V.minX + 0.5 && Math.max(g.x1, g.x2) >= V.maxX - 0.5);
  const oben = waagrecht.filter((g) => g.y1 > yb && g.y1 - yb < 2.5 * s).map((g) => g.y1);
  const unten = waagrecht.filter((g) => g.y1 < yb && yb - g.y1 < 1.5 * s).map((g) => g.y1);
  if (!oben.length || !unten.length) return { fehler: 'Die Tabellenlinien um die Zeile „Summe“ wurden nicht erkannt – die Zeilen können nicht sauber eingefügt werden.' };
  const top = Math.min(...oben);
  const bottom = Math.max(...unten);
  const h = top - bottom;
  if (h < s || h > 4 * s) return { fehler: 'Die Zeilenhöhe der Tabelle ist ungewöhnlich – die Zeilen werden nicht eingefügt.' };
  const ym = (top + bottom) / 2;
  // senkrechte Linien, die durch die Summenzeile laufen und an ihrer Unterkante enden
  const senkrecht = linien.filter((g) => Math.abs(g.x1 - g.x2) < 0.05 && Math.min(g.y1, g.y2) <= ym && Math.max(g.y1, g.y2) >= ym
    && Math.min(g.y1, g.y2) >= bottom - 2);
  const xs = zusammenfassen(senkrecht.map((g) => g.x1), 0.5);
  if (xs.length < 3) return { fehler: 'Die Spalten der Tabelle wurden nicht erkannt – die Zeilen werden nicht eingefügt.' };
  const lwListe = [...senkrecht, ...waagrecht].map((g) => g.lw).filter((x) => x > 0).sort((a, b) => a - b);
  const lw = lwListe.length ? lwListe[Math.floor(lwListe.length / 2)] : 0.5;
  const xLinks = xs[0];
  const xRechts = xs[xs.length - 1];
  const links = xs.filter((x) => x <= V.minX + 0.1);
  const rechts = xs.filter((x) => x >= V.maxX - 0.1);
  if (!links.length || !rechts.length) return { fehler: 'Die Stundenspalte wurde nicht erkannt – die Zeilen werden nicht eingefügt.' };
  const xWertL = Math.max(...links);
  const xWertR = Math.min(...rechts);
  if (xWertL <= xLinks + 1 || L.minX < xLinks || L.maxX > xWertL + 0.5) return { fehler: 'Der Aufbau der Summenzeile ist unerwartet – die Zeilen werden nicht eingefügt.' };

  const unterkante = bottom - 2 * h;
  if (unterkante - lw < seite.mediaBox[1] + 12) return { fehler: 'Unter der Tabelle ist kein Platz für die zwei Zeilen – bitte von Hand eintragen.' };
  const y1 = unterkante + 0.3, y2 = bottom - 0.8;
  let xEnde = null;
  if (bereichFrei(seite, xLinks + lw, xRechts - lw, y1, y2)) xEnde = xRechts;
  else if (bereichFrei(seite, xLinks + lw, xWertR - lw, y1, y2)) xEnde = xWertR;
  if (xEnde === null) return { fehler: 'Unter der Tabelle ist kein Platz für die zwei Zeilen – bitte von Hand eintragen.' };

  const seiteNr = L.page;
  const neueLinien = [];
  for (let k = 1; k <= 2; k++) {
    const y = bottom - k * h;
    neueLinien.push({ seite: seiteNr, x1: xLinks - lw / 2, y1: y, x2: xEnde + lw / 2, y2: y, lw });
  }
  const spalten = xEnde === xRechts ? zusammenfassen([xLinks, xWertL, xWertR, xRechts], 0.5) : zusammenfassen([xLinks, xWertL, xWertR], 0.5);
  for (const x of spalten) neueLinien.push({ seite: seiteNr, x1: x, y1: unterkante - lw / 2, x2: x, y2: bottom + lw / 2, lw });

  // Wert wie in der Summenzeile ausrichten (links oder rechts in der Zelle)
  const wertRechts = (V.minX - xWertL) > (xWertR - V.maxX) + 0.5;
  const texte = [];
  NEUE_ZEILEN.forEach((label, i) => {
    const y = yb - (i + 1) * h;
    texte.push({
      seite: seiteNr, text: label, x: L.maxX, y, rechtsbuendig: true, groesse: L.size,
      vorbildFontRef: L.fontRef, vorbildFontName: L.fontBaseName, vorbildFett: L.fontIsBold,
    });
    texte.push({
      seite: seiteNr, text: werte[i], x: wertRechts ? V.maxX : V.minX, y: V.y - (i + 1) * h, rechtsbuendig: wertRechts, groesse: V.size,
      vorbildFontRef: V.fontRef, vorbildFontName: V.fontBaseName, vorbildFett: V.fontIsBold,
    });
  });
  return { texte, linien: neueLinien, breit: xEnde === xRechts };
}

function pruefe(original, ausgabe, erwartet) {
  if (ausgabe.length <= original.length) throw new PDFError('verification', 'Ausgabe zu kurz');
  for (let i = 0; i < original.length; i++) if (ausgabe[i] !== original[i]) throw new PDFError('verification', 'Originalinhalt verändert');
  const neu = new PDFFile(ausgabe);
  const alt = new PDFFile(original);
  if (neu.pageRefs().length !== alt.pageRefs().length) throw new PDFError('verification', 'Seitenzahl');
  const nachweise = analyze(linesOf(neu));
  if (nachweise.length !== erwartet.length) throw new PDFError('verification', 'Anzahl Nachweise');
  nachweise.forEach((n, i) => {
    const e = erwartet[i];
    if (e.status !== 'bereit') return;
    if (wertText(n.indirekt) !== e.indirektText) throw new PDFError('verification', `indirekte Stunden nicht lesbar (${wertText(n.indirekt) || 'leer'})`);
    if (wertText(n.gesamt) !== e.gesamtText) throw new PDFError('verification', `Gesamtstunden nicht lesbar (${wertText(n.gesamt) || 'leer'})`);
  });
}

/**
 * Verarbeitet eine PDF.
 * Sind die Felder vorhanden, werden nur die Werte eingetragen. Fehlen sie (Kilanka-Vorlage nur mit „Summe“),
 * fuegt die App die zwei Zeilen unter der Summenzeile im Stil der Tabelle ein.
 * @returns {{nachweise: object[], ausgabe: Uint8Array|null, fehler: string|null, eintragungen: object[]}}
 */
export function verarbeite(data, standortId) {
  const standort = standortById(standortId);
  const ergebnis = { nachweise: [], ausgabe: null, fehler: null, eintragungen: [] };
  let file;
  try {
    file = new PDFFile(data);
  } catch (_) {
    ergebnis.fehler = 'Die Datei konnte nicht gelesen werden. Ist es eine PDF?';
    return ergebnis;
  }
  if (file.isEncrypted) {
    ergebnis.fehler = 'Die PDF ist geschützt (verschlüsselt). Bitte ohne Schutz aus Kilanka exportieren.';
    return ergebnis;
  }
  let seiten, nachweise;
  try {
    seiten = seitenDaten(file);
    nachweise = analyze(linesOf(file, seiten));
  } catch (_) {
    ergebnis.fehler = 'Der Inhalt der PDF konnte nicht gelesen werden.';
    return ergebnis;
  }
  if (!nachweise.length || !nachweise.some((n) => n.eintraege.length || n.direkt)) {
    ergebnis.fehler = 'In dieser PDF wurde kein Leistungsnachweis erkannt.';
    return ergebnis;
  }

  const eintragungen = [];
  const linien = [];
  nachweise.forEach((n, i) => {
    const tage = anwesenheitstage(n);
    const r = {
      nummer: i + 1, name: n.name, zeitraum: n.zeitraum, bewilligt: n.bewilligt, tage: tage.map(String),
      anzahlTage: tage.length, mehrfachTage: mehrfachTage(n).map((t) => t.kurz), eintraege: n.eintraege.length,
      direkt: null, direktText: null, indirekt: null, indirektText: null, gesamt: null, gesamtText: null,
      formel: null, status: 'bereit', fehlertext: null, hinweise: [], eingefuegt: false,
      seite: n.indirekt ? n.indirekt.label.page : n.direkt ? n.direkt.label.page : n.letzteSeite,
    };
    const fehler = (text) => { r.status = 'fehler'; r.fehlertext = text; ergebnis.nachweise.push(r); };

    // Direkte Stunden: Wert aus der PDF, sonst Summe der Zeilen
    const alleMitZeit = n.eintraege.length > 0 && n.eintraege.every((e) => e.minuten !== null);
    const zeilenExakt = alleMitZeit ? DE.centiFromMinutes(n.eintraege.reduce((s, e) => s + e.minuten, 0)) : null;
    const zeilenSumme = n.eintraege.reduce((s, e) => s + (e.stunden || 0), 0);
    const dWert = wertText(n.direkt);
    const hm = !!(dWert && dWert.includes(':'));
    let direkt;
    if (dWert !== null) {
      const hmMin = DE.parseHourMinute(dWert);
      direkt = DE.parseCenti(dWert);
      if (direkt === null) direkt = hmMin !== null ? DE.centiFromMinutes(hmMin) : 0;
      r.direktText = dWert;
      const abwExakt = zeilenExakt !== null ? Math.abs(zeilenExakt - direkt) : 0;
      const toleranz = 0.5 * Math.max(1, n.eintraege.length) + 0.1;
      if (n.eintraege.length && abwExakt > 1.1 && Math.abs(zeilenSumme - direkt) > toleranz) {
        r.hinweise.push(`Die Zeilen ergeben ${DE.format(zeilenExakt !== null ? zeilenExakt : zeilenSumme)} Std., in der PDF stehen ${dWert} Std. als direkte Stunden. Verwendet wird der Wert aus der PDF.`);
      }
    } else {
      direkt = zeilenExakt !== null ? zeilenExakt : zeilenSumme;
      r.direktText = DE.format(direkt);
      if (n.direkt) r.hinweise.push('Kein Wert bei den direkten Stunden gefunden – Summe der Zeilen verwendet.');
    }
    r.direkt = direkt;

    if (!tage.length) return fehler('Keine Einträge mit Stunden gefunden.');
    if (!!n.indirekt !== !!n.gesamt) {
      return fehler(`In der PDF gibt es nur das Feld ${n.indirekt ? '„Indirekte Stunden gesamt“' : '„Gesamtstunden“'} – das andere fehlt. Bitte die Vorlage prüfen.`);
    }

    const ind = standort.berechne(n, direkt);
    r.formel = ind.formel;
    r.indirekt = ind.centi;
    r.gesamt = direkt + ind.centi;
    if (hm && DE.parseHourMinute(dWert) !== null) {
      const dm = DE.parseHourMinute(dWert);
      const im = ind.minuten !== undefined ? ind.minuten : rhu(ind.centi * 60, 100);
      r.indirektText = DE.formatHourMinute(im);
      r.gesamtText = DE.formatHourMinute(dm + im);
    } else {
      r.indirektText = DE.format(ind.centi);
      r.gesamtText = DE.format(direkt + ind.centi);
    }
    if (n.bewilligt !== null && r.gesamt > n.bewilligt) {
      r.hinweise.push(`Die Gesamtstunden (${r.gesamtText}) liegen über den bewilligten ${DE.format(n.bewilligt)} Std.`);
    }

    // Felder fehlen: Zeilen einfuegen
    if (!n.indirekt && !n.gesamt) {
      const plan = einfuegePlan(n, seiten[n.direkt ? n.direkt.label.page : 0], [r.indirektText, r.gesamtText]);
      if (plan.fehler) return fehler(plan.fehler);
      r.eingefuegt = true;
      r.seite = n.direkt.label.page;
      eintragungen.push(...plan.texte);
      linien.push(...plan.linien);
      ergebnis.nachweise.push(r);
      return;
    }

    const belegt = n.indirekt.belegt || n.gesamt.belegt;
    if (belegt) {
      const welches = n.indirekt.belegt ? '„Indirekte Stunden gesamt“' : '„Gesamtstunden“';
      return fehler(`Im Feld ${welches} steht bereits „${belegt.text}“ – nichts eingetragen.`);
    }
    const vi = wertText(n.indirekt), vg = wertText(n.gesamt);
    if (vi !== null || vg !== null) {
      if (vi === r.indirektText && vg === r.gesamtText) {
        r.status = 'bereitsErgaenzt';
        ergebnis.nachweise.push(r);
        return;
      }
      return fehler(`Die Felder sind schon ausgefüllt (indirekt ${vi || 'leer'}, gesamt ${vg || 'leer'}) – nichts überschrieben.`);
    }

    const vorbild = n.direkt ? n.direkt.wert : null;
    eintragungen.push(platzierung(n.indirekt, r.indirektText, vorbild, n.direkt ? n.direkt.label : null, n.stundenKopf, n.stundenSpalte));
    eintragungen.push(platzierung(n.gesamt, r.gesamtText, vorbild, n.direkt ? n.direkt.label : null, n.stundenKopf, n.stundenSpalte));
    ergebnis.nachweise.push(r);
  });

  if (!eintragungen.length) return ergebnis;
  try {
    const { data: out, placed } = stamp(eintragungen, file, linien);
    pruefe(file.data, out, ergebnis.nachweise);
    ergebnis.ausgabe = out;
    ergebnis.eintragungen = placed.filter((p) => !NEUE_ZEILEN.includes(p.text));
  } catch (e) {
    ergebnis.fehler = `Die Werte konnten nicht sicher eingetragen werden (${e.message}). Die Datei wurde nicht verändert.`;
    for (const r of ergebnis.nachweise) if (r.status === 'bereit') { r.status = 'fehler'; r.fehlertext = 'Nicht eingetragen.'; }
  }
  return ergebnis;
}
