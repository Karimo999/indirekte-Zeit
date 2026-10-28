// Textextraktion: Schriften (ToUnicode, Breiten), Inhaltsstream-Interpreter und Zeilenbildung.
import { Lexer, PDict, PName, PRef, PStream, PString, nameOf, intOf, isWhite, isDelim } from './core.js';

// ---------------------------------------------------------------- Kodierungen

const WIN_ANSI_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
function winAnsi(c) {
  if (c >= 0x80 && c <= 0x9f) return WIN_ANSI_HIGH[c] ? String.fromCharCode(WIN_ANSI_HIGH[c]) : undefined;
  return String.fromCharCode(c);
}

const GLYPHS = {
  space: ' ', comma: ',', period: '.', colon: ':', semicolon: ';', hyphen: '-', minus: '-', endash: '–',
  emdash: '—', slash: '/', parenleft: '(', parenright: ')', bracketleft: '[', bracketright: ']', plus: '+',
  percent: '%', ampersand: '&', quotesingle: "'", quotedbl: '"', exclam: '!', question: '?', at: '@',
  numbersign: '#', dollar: '$', asterisk: '*', underscore: '_', equal: '=', less: '<', greater: '>',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü',
  germandbls: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', section: '§', euro: '€', quoteright: '’',
  quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotedblbase: '„', bullet: '•', ellipsis: '…',
  degree: '°', fi: 'fi', fl: 'fl',
};
function glyphUnicode(name) {
  if (GLYPHS[name]) return GLYPHS[name];
  if (name.length === 1) return name;
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return undefined;
}

const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
  556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556,
  500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556,
  722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556,
  611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556,
  556, 500, 389, 280, 389, 584];

export function standardWidths(baseFont) {
  const n = baseFont.toLowerCase();
  const out = new Map();
  if (n.includes('courier')) {
    for (let c = 32; c <= 126; c++) out.set(c, 600);
    return out;
  }
  const t = n.includes('bold') || n.includes('black') ? HELV_BOLD : HELV;
  t.forEach((w, i) => out.set(32 + i, w));
  return out;
}

// ---------------------------------------------------------------- CMap

function codeOf(bytes) {
  let c = 0;
  for (const b of bytes) c = c * 256 + b;
  return c;
}
function units(bytes) {
  const u = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) u.push((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2 === 1) u.push(bytes[bytes.length - 1]);
  return u;
}
const strOf = (u) => String.fromCharCode(...u);

export function parseCMap(data) {
  const map = new Map();
  const lx = new Lexer(data, 0);
  lx.refsAllowed = false;
  let mode = 0;
  let pending = [];
  for (;;) {
    let t;
    try { t = lx.next(); } catch (_) { break; }
    if (t.t === 'eof') break;
    if (t.t === 'kw') {
      if (t.v === 'beginbfchar') { mode = 1; pending = []; }
      else if (t.v === 'beginbfrange') { mode = 2; pending = []; }
      else if (t.v === 'endbfchar' || t.v === 'endbfrange') { mode = 0; pending = []; }
      continue;
    }
    if (mode === 1) {
      pending.push(t);
      if (pending.length === 2) {
        if (pending[0].t === 'hex') {
          if (pending[1].t === 'hex') map.set(codeOf(pending[0].v), strOf(units(pending[1].v)));
          else if (pending[1].t === 'name') {
            const u = glyphUnicode(pending[1].v);
            if (u) map.set(codeOf(pending[0].v), u);
          }
        }
        pending = [];
      }
    } else if (mode === 2) {
      if (t.t === '[') {
        const dsts = [];
        for (;;) {
          let tt;
          try { tt = lx.next(); } catch (_) { break; }
          if (tt.t === ']' || tt.t === 'eof') break;
          if (tt.t === 'hex') dsts.push(tt.v);
        }
        if (pending.length === 2 && pending[0].t === 'hex' && pending[1].t === 'hex') {
          const l = codeOf(pending[0].v), h = codeOf(pending[1].v);
          dsts.forEach((d, i) => { if (l + i <= h) map.set(l + i, strOf(units(d))); });
        }
        pending = [];
        continue;
      }
      pending.push(t);
      if (pending.length === 3) {
        if (pending[0].t === 'hex' && pending[1].t === 'hex' && pending[2].t === 'hex') {
          const l = codeOf(pending[0].v), h = codeOf(pending[1].v);
          const u = units(pending[2].v);
          if (h >= l && h - l < 65536) {
            for (let c = l; c <= h; c++) {
              map.set(c, strOf(u));
              if (u.length) u[u.length - 1] = (u[u.length - 1] + 1) & 0xffff;
            }
          }
        }
        pending = [];
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------- Schriften

export class FontInfo {
  constructor(file, dict, ref) {
    this.ref = ref;
    const bf = nameOf(dict.get('BaseFont')) || '';
    this.rawBaseFont = bf;
    const plus = bf.indexOf('+');
    this.baseFont = plus === 6 ? bf.slice(7) : bf;
    this.subtype = nameOf(dict.get('Subtype')) || '';
    this.isType0 = this.subtype === 'Type0';
    this.codeBytes = this.isType0 ? 2 : 1;
    this.widths = new Map();
    this.defaultWidth = 0;
    this.toUnicode = new Map();
    this.simpleEncoding = new Map();
    this.fontWeight = undefined;

    const tu = file.resolve(dict.get('ToUnicode'));
    if (tu instanceof PStream) {
      try { this.toUnicode = parseCMap(file.decode(tu)); } catch (_) { /* ignorieren */ }
    }
    let descriptor;
    if (this.isType0) {
      const descs = file.resolve(dict.get('DescendantFonts'));
      const desc = Array.isArray(descs) && descs.length ? file.dictionary(descs[0]) : undefined;
      descriptor = desc ? file.dictionary(desc.get('FontDescriptor')) : undefined;
      const dw = desc ? file.resolve(desc.get('DW')) : undefined;
      this.defaultWidth = typeof dw === 'number' ? dw : 1000;
      const w = desc ? file.resolve(desc.get('W')) : undefined;
      if (Array.isArray(w)) this.parseCIDWidths(w, file);
    } else {
      descriptor = file.dictionary(dict.get('FontDescriptor'));
      const mw = descriptor ? file.resolve(descriptor.get('MissingWidth')) : undefined;
      this.defaultWidth = typeof mw === 'number' ? mw : 0;
      const first = intOf(file.resolve(dict.get('FirstChar')));
      const ws = file.resolve(dict.get('Widths'));
      if (first !== undefined && Array.isArray(ws)) {
        ws.forEach((w, i) => {
          const v = file.resolve(w);
          this.widths.set(first + i, typeof v === 'number' ? v : this.defaultWidth);
        });
      } else {
        for (const [c, w] of standardWidths(this.baseFont)) this.widths.set(c, w);
        if (this.defaultWidth === 0) this.defaultWidth = 500;
      }
      this.simpleEncoding = simpleEncodingTable(file, dict.get('Encoding'));
    }
    if (descriptor) {
      const fw = intOf(file.resolve(descriptor.get('FontWeight')));
      if (fw !== undefined) this.fontWeight = fw;
    }
  }

  get isBoldLike() {
    if (this.fontWeight !== undefined) return this.fontWeight >= 600;
    const n = this.baseFont.toLowerCase();
    return ['bold', 'semibold', 'demi', 'black', 'heavy', 'extrab', 'ultrab'].some((k) => n.includes(k));
  }

  parseCIDWidths(w, file) {
    let i = 0;
    while (i < w.length) {
      const first = intOf(file.resolve(w[i]));
      if (first === undefined) break;
      const next = i + 1 < w.length ? file.resolve(w[i + 1]) : undefined;
      if (Array.isArray(next)) {
        next.forEach((v, k) => {
          const x = file.resolve(v);
          this.widths.set(first + k, typeof x === 'number' ? x : this.defaultWidth);
        });
        i += 2;
      } else if (i + 2 < w.length) {
        const last = intOf(next);
        const wv = file.resolve(w[i + 2]);
        if (last === undefined || typeof wv !== 'number') break;
        if (last >= first && last - first < 100000) for (let c = first; c <= last; c++) this.widths.set(c, wv);
        i += 3;
      } else break;
    }
  }

  codes(bytes) {
    if (this.codeBytes === 2) {
      const out = [];
      for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    return Array.from(bytes);
  }

  width(code) {
    const w = this.widths.get(code);
    return w === undefined ? this.defaultWidth : w;
  }

  unicode(code) {
    const u = this.toUnicode.get(code);
    if (u !== undefined) return u;
    if (!this.isType0) {
      const s = this.simpleEncoding.get(code);
      if (s !== undefined) return s;
      if (code >= 32 && code < 256) return String.fromCharCode(code);
    }
    return '';
  }

  /** Vorhandene Glyph-Codes fuer einen Text (nur wenn alle Zeichen vorhanden sind) */
  codesForText(text) {
    const reverse = new Map();
    for (const [code, u] of [...this.toUnicode.entries()].sort((a, b) => a[0] - b[0])) {
      if (u && !reverse.has(u)) reverse.set(u, code);
    }
    if (!this.isType0) for (const [code, u] of this.simpleEncoding) if (!reverse.has(u)) reverse.set(u, code);
    const out = [];
    for (const ch of text) {
      const c = reverse.get(ch);
      if (c === undefined) return null;
      if (this.isType0 && !this.widths.has(c)) return null;
      out.push(c);
    }
    return out;
  }
}

function simpleEncodingTable(file, encoding) {
  const t = new Map();
  let baseName;
  let differences = [];
  const e = file.resolve(encoding);
  if (e instanceof PName) baseName = e.v;
  else if (e instanceof PDict) {
    baseName = nameOf(e.get('BaseEncoding'));
    const d = file.resolve(e.get('Differences'));
    if (Array.isArray(d)) differences = d;
  }
  for (let c = 32; c < 256; c++) {
    const u = winAnsi(c);
    if (u !== undefined) t.set(c, u);
  }
  if (baseName === 'MacRomanEncoding') {
    const mac = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
    [...mac].forEach((ch, i) => t.set(128 + i, ch));
  }
  let code = 0;
  for (const d of differences) {
    if (typeof d === 'number') { code = Math.round(d); continue; }
    if (d instanceof PName) {
      const u = glyphUnicode(d.v);
      if (u) t.set(code, u);
      code++;
    }
  }
  return t;
}

// ---------------------------------------------------------------- Interpreter

const ident = () => [1, 0, 0, 1, 0, 0];
const translate = (x, y) => [1, 0, 0, 1, x, y];
// m1 * m2 (erst m1, dann m2)
function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
const apply = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

export class TextExtractor {
  constructor(file) {
    this.file = file;
    this.fontCache = new Map();
  }

  glyphs(pageRef) {
    return this.seite(pageRef).glyphs;
  }

  /** Text und Grafik (Linien, Flaechen, Bilder) einer Seite in PDF-Koordinaten */
  seite(pageRef) {
    const page = this.file.dictionary(pageRef);
    if (!page) return { glyphs: [], grafik: [], mediaBox: [0, 0, 595, 842] };
    const res = this.file.pageResources(page);
    const content = this.file.contentData(page);
    const out = [];
    const grafik = [];
    this.grafik = grafik;
    this.run(content, res, this.initialState(), 0, out);
    this.grafik = null;
    const mb = this.file.resolve(this.file.inherited(page, 'MediaBox'));
    const mediaBox = Array.isArray(mb) && mb.length === 4 ? mb.map((v) => (typeof v === 'number' ? v : 0)) : [0, 0, 595, 842];
    return { glyphs: out, grafik, mediaBox };
  }

  initialState() {
    return { ctm: ident(), font: null, fontResName: '', fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, lineWidth: 1 };
  }

  font(name, resources) {
    const fonts = this.file.dictionary(resources.get('Font'));
    if (!fonts) return null;
    const fo = fonts.get(name);
    if (fo === undefined) return null;
    const key = fo instanceof PRef ? 'r' + fo.num : 'n' + name + '-' + fonts.size;
    if (this.fontCache.has(key)) return this.fontCache.get(key);
    const fd = this.file.dictionary(fo);
    if (!fd) return null;
    const f = new FontInfo(this.file, fd, fo instanceof PRef ? fo : undefined);
    this.fontCache.set(key, f);
    return f;
  }

  run(content, resources, state, depth, out) {
    const lx = new Lexer(content, 0);
    lx.refsAllowed = false;
    let ops = [];
    let gs = { ...state };
    const stack = [];
    let tm = ident();
    let tlm = ident();
    const num = (i) => (typeof ops[i] === 'number' ? ops[i] : 0);
    const matrixOp = () => {
      if (ops.length < 6) return null;
      const v = ops.slice(-6).map((x) => (typeof x === 'number' ? x : 0));
      return v;
    };
    const show = (bytes) => {
      const font = gs.font;
      if (!font) return;
      for (const code of font.codes(bytes)) {
        const w0 = font.width(code) / 1000;
        const scale = [gs.fontSize * gs.hScale, 0, 0, gs.fontSize, 0, gs.rise];
        const trm = mul(mul(scale, tm), gs.ctm);
        const [x0, y0] = apply(trm, 0, 0);
        let tx = w0 * gs.fontSize + gs.charSpacing;
        if (font.codeBytes === 1 && code === 32) tx += gs.wordSpacing;
        tx *= gs.hScale;
        const nextTm = mul(translate(tx, 0), tm);
        const [x1] = apply(mul(mul(scale, nextTm), gs.ctm), 0, 0);
        const size = Math.sqrt(trm[2] * trm[2] + trm[3] * trm[3]);
        out.push({
          text: font.unicode(code), x: x0, y: y0, x2: x1, size,
          fontResName: gs.fontResName, fontRef: font.ref, fontBaseName: font.baseFont, fontIsBold: font.isBoldLike, code,
        });
        tm = nextTm;
      }
    };
    const nextLine = () => {
      tlm = mul(translate(0, -gs.leading), tlm);
      tm = tlm;
    };
    // Pfade (fuer Tabellenlinien und Platzpruefung)
    const grafik = this.grafik;
    let pfad = [];
    let punkt = null;
    let start = null;
    const tp = (x, y) => apply(gs.ctm, x, y);
    const strecke = (a, b, kurve) => pfad.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], kurve });
    const malen = (stroke, fill) => {
      if (grafik && pfad.length) {
        const lw = gs.lineWidth * Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]));
        if (stroke) for (const p of pfad) grafik.push({ art: 'linie', x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, lw, kurve: !!p.kurve });
        if (fill) {
          const xs = pfad.flatMap((p) => [p.x1, p.x2]), ys = pfad.flatMap((p) => [p.y1, p.y2]);
          grafik.push({ art: 'flaeche', x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) });
        }
      }
      pfad = [];
      punkt = null;
      start = null;
    };
    const bildBox = () => {
      if (!grafik) return;
      const pts = [tp(0, 0), tp(1, 0), tp(0, 1), tp(1, 1)];
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      grafik.push({ art: 'bild', x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) });
    };

    for (;;) {
      let tok;
      try { tok = lx.next(); } catch (_) { break; }
      if (tok.t === 'eof') return;
      if (tok.t === 'kw') {
        const op = tok.v;
        if (op === 'true') { ops.push(true); continue; }
        if (op === 'false') { ops.push(false); continue; }
        if (op === 'null') { ops.push(null); continue; }
        switch (op) {
          case 'q': stack.push({ ...gs }); break;
          case 'Q': if (stack.length) gs = stack.pop(); break;
          case 'cm': { const m = matrixOp(); if (m) gs.ctm = mul(m, gs.ctm); break; }
          case 'BT': tm = ident(); tlm = ident(); break;
          case 'Tf':
            if (ops.length >= 2 && ops[ops.length - 2] instanceof PName) {
              gs.fontResName = ops[ops.length - 2].v;
              gs.fontSize = typeof ops[ops.length - 1] === 'number' ? ops[ops.length - 1] : 0;
              gs.font = this.font(gs.fontResName, resources);
            }
            break;
          case 'Tc': gs.charSpacing = num(0); break;
          case 'Tw': gs.wordSpacing = num(0); break;
          case 'Tz': gs.hScale = num(0) / 100; break;
          case 'TL': gs.leading = num(0); break;
          case 'Ts': gs.rise = num(0); break;
          case 'Td': tlm = mul(translate(num(0), num(1)), tlm); tm = tlm; break;
          case 'TD': gs.leading = -num(1); tlm = mul(translate(num(0), num(1)), tlm); tm = tlm; break;
          case 'Tm': { const m = matrixOp(); if (m) { tlm = m; tm = m; } break; }
          case 'T*': nextLine(); break;
          case 'Tj': { const s = ops[ops.length - 1]; if (s instanceof PString) show(s.bytes); break; }
          case "'": { nextLine(); const s = ops[ops.length - 1]; if (s instanceof PString) show(s.bytes); break; }
          case '"':
            if (ops.length >= 3) {
              gs.wordSpacing = num(0);
              gs.charSpacing = num(1);
              nextLine();
              if (ops[2] instanceof PString) show(ops[2].bytes);
            }
            break;
          case 'TJ': {
            const arr = ops[ops.length - 1];
            if (Array.isArray(arr)) {
              for (const el of arr) {
                if (el instanceof PString) show(el.bytes);
                else if (typeof el === 'number') tm = mul(translate((-el / 1000) * gs.fontSize * gs.hScale, 0), tm);
              }
            }
            break;
          }
          case 'Do': {
            const name = ops[ops.length - 1];
            if (depth < 8 && name instanceof PName) {
              const xobjs = this.file.dictionary(resources.get('XObject'));
              const xs = xobjs ? this.file.resolve(xobjs.get(name.v)) : undefined;
              if (xs instanceof PStream && nameOf(xs.dict.get('Subtype')) === 'Image') bildBox();
              if (xs instanceof PStream && nameOf(xs.dict.get('Subtype')) === 'Form') {
                let data;
                try { data = this.file.decode(xs); } catch (_) { data = null; }
                if (data) {
                  const sub = { ...gs };
                  const m = this.file.resolve(xs.dict.get('Matrix'));
                  if (Array.isArray(m) && m.length === 6) sub.ctm = mul(m.map((x) => (typeof x === 'number' ? x : 0)), gs.ctm);
                  const res = this.file.dictionary(xs.dict.get('Resources')) || resources;
                  this.run(data, res, sub, depth + 1, out);
                }
              }
            }
            break;
          }
          case 'BI': bildBox(); skipInlineImage(lx); break;
          case 'w': gs.lineWidth = num(0); break;
          case 'm': punkt = tp(num(0), num(1)); start = punkt; break;
          case 'l': { const p = tp(num(0), num(1)); if (punkt) strecke(punkt, p); punkt = p; break; }
          case 'c': { const p = tp(num(4), num(5)); if (punkt) strecke(punkt, p, true); punkt = p; break; }
          case 'v': case 'y': { const p = tp(num(2), num(3)); if (punkt) strecke(punkt, p, true); punkt = p; break; }
          case 're': {
            const x = num(0), y = num(1), w = num(2), h = num(3);
            const a = tp(x, y), b = tp(x + w, y), c = tp(x + w, y + h), d = tp(x, y + h);
            strecke(a, b); strecke(b, c); strecke(c, d); strecke(d, a);
            punkt = a; start = a;
            break;
          }
          case 'h': if (punkt && start) strecke(punkt, start); punkt = start; break;
          case 'S': malen(true, false); break;
          case 's': if (punkt && start) strecke(punkt, start); malen(true, false); break;
          case 'f': case 'F': case 'f*': malen(false, true); break;
          case 'B': case 'B*': malen(true, true); break;
          case 'b': case 'b*': if (punkt && start) strecke(punkt, start); malen(true, true); break;
          case 'n': malen(false, false); break;
          default: break;
        }
        ops = [];
        continue;
      }
      if (tok.t === '[' || tok.t === '<<') {
        try { ops.push(lx.objectFrom(tok)); } catch (_) { return; }
      } else if (tok.t === 'int' || tok.t === 'real') ops.push(tok.v);
      else if (tok.t === 'name') ops.push(new PName(tok.v));
      else if (tok.t === 'str') ops.push(new PString(tok.v));
      else if (tok.t === 'hex') ops.push(new PString(tok.v, true));
      if (ops.length > 64) ops = ops.slice(-64);
    }
  }
}

function skipInlineImage(lx) {
  for (;;) {
    let t;
    try { t = lx.next(); } catch (_) { return; }
    if (t.t === 'eof') return;
    if (t.t === 'kw' && t.v === 'ID') break;
  }
  lx.p += 1;
  const b = lx.b;
  for (let i = lx.p; i + 1 < lx.end; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === 0 || isWhite(b[i - 1]))
      && (i + 2 >= lx.end || isWhite(b[i + 2]) || isDelim(b[i + 2]))) {
      lx.p = i + 2;
      return;
    }
  }
  lx.p = lx.end;
}

// ---------------------------------------------------------------- Zeilen

export function normalize(s) {
  let t = s.replace(/ /g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.split(/[ \t\n]+/).filter(Boolean).join(' ');
  while (t.endsWith(':') || t.endsWith(' ')) t = t.slice(0, -1);
  return t;
}

const blank = (s) => s.trim() === '';

export function layoutLines(glyphs, page) {
  const usable = glyphs.filter((g) => g.text !== '' && g.size > 0.5 && g.text !== '￿');
  if (!usable.length) return [];
  const sorted = usable.slice().sort((a, b) => (Math.abs(a.y - b.y) > 0.01 ? b.y - a.y : a.x - b.x));
  const groups = [];
  const groupY = [];
  for (const g of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(groupY[groupY.length - 1] - g.y) <= Math.max(0.3 * Math.min(last[0].size, g.size), 0.6)) {
      last.push(g);
    } else {
      groups.push([g]);
      groupY.push(g.y);
    }
  }
  const lines = [];
  for (const grp of groups) {
    const byX = grp.slice().sort((a, b) => a.x - b.x);
    const runs = [];
    let cur = [];
    let spaceBefore = [];
    const flush = () => {
      const idx = cur.map((g, i) => (blank(g.text) ? -1 : i)).filter((i) => i >= 0);
      if (!idx.length) { cur = []; spaceBefore = []; return; }
      const firstIdx = idx[0], lastIdx = idx[idx.length - 1];
      let text = '';
      for (let i = firstIdx; i <= lastIdx; i++) {
        if (i > firstIdx && spaceBefore[i] && !text.endsWith(' ')) text += ' ';
        text += cur[i].text;
      }
      text = text.split(' ').filter(Boolean).join(' ');
      const f = cur[firstIdx];
      runs.push({
        text, minX: f.x, maxX: cur[lastIdx].x2, y: f.y, size: f.size, page,
        fontResName: f.fontResName, fontRef: f.fontRef, fontBaseName: f.fontBaseName, fontIsBold: f.fontIsBold,
        normalized: normalize(text),
      });
      cur = [];
      spaceBefore = [];
    };
    for (const g of byX) {
      let prev;
      for (let i = cur.length - 1; i >= 0; i--) if (!blank(cur[i].text)) { prev = cur[i]; break; }
      if (!prev && cur.length) prev = cur[cur.length - 1];
      if (prev) {
        const gap = g.x - prev.x2;
        const em = Math.max(Math.min(prev.size, g.size), 1);
        if (gap > 0.6 * em || gap < -1.5 * em) {
          flush();
          cur.push(g);
          spaceBefore.push(false);
          continue;
        }
        cur.push(g);
        spaceBefore.push(gap > 0.15 * em);
      } else {
        cur.push(g);
        spaceBefore.push(false);
      }
    }
    flush();
    if (runs.length) lines.push({ runs, y: runs[0].y, page });
  }
  return lines;
}
