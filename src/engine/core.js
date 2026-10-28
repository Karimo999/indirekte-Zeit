// PDF-Objektmodell, Tokenizer/Parser und Serialisierung.
// Gleiche Logik wie die getestete Swift-Fassung.

export class PDFError extends Error {
  constructor(kind, msg) {
    super(msg || kind);
    this.kind = kind;
  }
}

export class PName {
  constructor(v) { this.v = v; }
}
export class PString {
  constructor(bytes, hex = false) { this.bytes = bytes; this.hex = hex; }
}
export class PRef {
  constructor(num, gen = 0) { this.num = num; this.gen = gen; }
}
export class PStream {
  constructor(dict, data) { this.dict = dict; this.data = data; }
}
export class PDict {
  constructor(entries) { this.map = new Map(entries || []); }
  get(k) { return this.map.get(k); }
  set(k, v) {
    if (v === undefined) this.map.delete(k);
    else this.map.set(k, v);
    return this;
  }
  has(k) { return this.map.has(k); }
  delete(k) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
  entries() { return [...this.map.entries()]; }
  clone() { return new PDict(this.map); }
  get size() { return this.map.size; }
}

export const nameOf = (o) => (o instanceof PName ? o.v : undefined);
export const isNum = (o) => typeof o === 'number' && Number.isFinite(o);
export const intOf = (o) => (isNum(o) ? Math.round(o) : undefined);
export const dictOf = (o) => (o instanceof PDict ? o : o instanceof PStream ? o.dict : undefined);
export const bytesOf = (o) => (o instanceof PString ? o.bytes : undefined);

const enc = new TextEncoder();
export const ascii = (s) => enc.encode(s);

// ---------------------------------------------------------------- Lexer

const WHITE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) DELIM[c] = 1;

export const isWhite = (c) => WHITE[c] === 1;
export const isDelim = (c) => DELIM[c] === 1;
export const isRegular = (c) => WHITE[c] === 0 && DELIM[c] === 0;
export const isDigit = (c) => c >= 0x30 && c <= 0x39;

export function hexVal(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

const latin1 = (arr) => {
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return s;
};

export class Lexer {
  constructor(bytes, pos = 0, end) {
    this.b = bytes;
    this.p = pos;
    this.end = Math.min(end === undefined ? bytes.length : end, bytes.length);
    this.refsAllowed = true;
  }

  skipWS() {
    const b = this.b;
    while (this.p < this.end) {
      const c = b[this.p];
      if (WHITE[c]) this.p++;
      else if (c === 0x25) {
        while (this.p < this.end && b[this.p] !== 0x0a && b[this.p] !== 0x0d) this.p++;
      } else break;
    }
  }

  matches(word, pos) {
    if (pos < 0 || pos + word.length > this.end) return false;
    for (let i = 0; i < word.length; i++) if (this.b[pos + i] !== word.charCodeAt(i)) return false;
    return true;
  }

  next() {
    this.skipWS();
    if (this.p >= this.end) return { t: 'eof' };
    const b = this.b;
    const c = b[this.p];
    switch (c) {
      case 0x5b: this.p++; return { t: '[' };
      case 0x5d: this.p++; return { t: ']' };
      case 0x3c:
        if (this.p + 1 < this.end && b[this.p + 1] === 0x3c) { this.p += 2; return { t: '<<' }; }
        return { t: 'hex', v: this.readHex() };
      case 0x3e:
        if (this.p + 1 < this.end && b[this.p + 1] === 0x3e) { this.p += 2; return { t: '>>' }; }
        this.p++;
        return { t: 'kw', v: '>' };
      case 0x28: return { t: 'str', v: this.readLiteral() };
      case 0x2f: return { t: 'name', v: this.readName() };
      case 0x29: this.p++; return { t: 'kw', v: ')' };
      case 0x7b: this.p++; return { t: 'kw', v: '{' };
      case 0x7d: this.p++; return { t: 'kw', v: '}' };
      default:
        if (c === 0x2b || c === 0x2d || c === 0x2e || isDigit(c)) {
          const n = this.readNumber();
          if (n) return n;
        }
        return { t: 'kw', v: this.readRegular() };
    }
  }

  readNumber() {
    const b = this.b;
    let i = this.p;
    let neg = false;
    while (i < this.end && (b[i] === 0x2b || b[i] === 0x2d)) {
      if (b[i] === 0x2d) neg = !neg;
      i++;
    }
    let sawDigit = false;
    let sawDot = false;
    const start = i;
    while (i < this.end && isDigit(b[i])) { sawDigit = true; i++; }
    if (i < this.end && b[i] === 0x2e) {
      sawDot = true;
      i++;
      while (i < this.end && isDigit(b[i])) { sawDigit = true; i++; }
    }
    if (!sawDigit) return null;
    if (i < this.end && isRegular(b[i]) && b[i] !== 0x2d && b[i] !== 0x2b) return null;
    let s = latin1(b.subarray(start, i));
    this.p = i;
    if (s.startsWith('.')) s = '0' + s;
    const v = sawDot ? parseFloat(s) : parseInt(s, 10);
    const val = Number.isFinite(v) ? v : 0;
    return { t: sawDot ? 'real' : 'int', v: neg ? -val : val };
  }

  readLiteral() {
    const b = this.b;
    this.p++;
    const out = [];
    let depth = 1;
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 0x5c) {
        if (this.p >= this.end) break;
        const e = b[this.p++];
        switch (e) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x28: case 0x29: case 0x5c: out.push(e); break;
          case 0x0d: if (this.p < this.end && b[this.p] === 0x0a) this.p++; break;
          case 0x0a: break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              let n = 1;
              while (n < 3 && this.p < this.end && b[this.p] >= 0x30 && b[this.p] <= 0x37) {
                v = v * 8 + (b[this.p] - 0x30);
                this.p++;
                n++;
              }
              out.push(v & 0xff);
            } else out.push(e);
        }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); }
      else if (c === 0x0d) { out.push(0x0a); if (this.p < this.end && b[this.p] === 0x0a) this.p++; }
      else out.push(c);
    }
    return Uint8Array.from(out);
  }

  readHex() {
    const b = this.b;
    this.p++;
    const out = [];
    let hi = -1;
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi >= 0) { out.push((hi << 4) | v); hi = -1; } else hi = v;
    }
    if (hi >= 0) out.push(hi << 4);
    return Uint8Array.from(out);
  }

  readName() {
    const b = this.b;
    this.p++;
    let s = '';
    while (this.p < this.end && isRegular(b[this.p])) {
      const c = b[this.p];
      if (c === 0x23 && this.p + 2 < this.end && hexVal(b[this.p + 1]) >= 0 && hexVal(b[this.p + 2]) >= 0) {
        s += String.fromCharCode((hexVal(b[this.p + 1]) << 4) | hexVal(b[this.p + 2]));
        this.p += 3;
      } else {
        s += String.fromCharCode(c);
        this.p++;
      }
    }
    return s;
  }

  readRegular() {
    const s = this.p;
    while (this.p < this.end && isRegular(this.b[this.p])) this.p++;
    if (this.p === s) {
      this.p++;
      return String.fromCharCode(this.b[s]);
    }
    return latin1(this.b.subarray(s, this.p));
  }

  parseObject(depth = 0) {
    return this.objectFrom(this.next(), depth);
  }

  objectFrom(tok, depth = 0) {
    if (depth > 256) throw new PDFError('syntax', 'zu tief verschachtelt');
    switch (tok.t) {
      case 'int': {
        if (!this.refsAllowed) return tok.v;
        const save = this.p;
        try {
          const g = this.next();
          if (g.t === 'int') {
            const r = this.next();
            if (r.t === 'kw' && r.v === 'R') return new PRef(tok.v, g.v);
          }
        } catch (_) { /* ignorieren */ }
        this.p = save;
        return tok.v;
      }
      case 'real': return tok.v;
      case 'name': return new PName(tok.v);
      case 'str': return new PString(tok.v, false);
      case 'hex': return new PString(tok.v, true);
      case '[': {
        const arr = [];
        for (;;) {
          const t = this.next();
          if (t.t === ']') break;
          if (t.t === 'eof') throw new PDFError('syntax', 'Array nicht geschlossen');
          if (t.t === 'kw' && (t.v === 'endobj' || t.v === 'stream')) throw new PDFError('syntax', 'Array nicht geschlossen');
          arr.push(this.objectFrom(t, depth + 1));
        }
        return arr;
      }
      case '<<': {
        const d = new PDict();
        for (;;) {
          const t = this.next();
          if (t.t === '>>') break;
          if (t.t === 'eof') throw new PDFError('syntax', 'Dictionary nicht geschlossen');
          if (t.t !== 'name') {
            if (t.t === 'kw' && (t.v === 'endobj' || t.v === 'stream')) throw new PDFError('syntax', 'Dictionary nicht geschlossen');
            continue;
          }
          const vt = this.next();
          if (vt.t === '>>') break;
          d.set(t.v, this.objectFrom(vt, depth + 1));
        }
        return d;
      }
      case 'kw':
        if (tok.v === 'true') return true;
        if (tok.v === 'false') return false;
        if (tok.v === 'null') return null;
        throw new PDFError('syntax', 'unerwartetes Schlüsselwort ' + tok.v);
      case 'eof':
        throw new PDFError('syntax', 'unerwartetes Dateiende');
      default:
        throw new PDFError('syntax', 'unerwartetes Zeichen');
    }
  }
}

// ---------------------------------------------------------------- Serialisierung

export class ByteWriter {
  constructor(initial) {
    this.chunks = [];
    this.length = 0;
    if (initial) this.bytes(initial);
  }
  bytes(u8) {
    this.chunks.push(u8);
    this.length += u8.length;
  }
  str(s) { this.bytes(ascii(s)); }
  result() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

export function formatNumber(d) {
  if (!Number.isFinite(d)) return '0';
  if (Number.isInteger(d) && Math.abs(d) < 1e15) return String(d);
  let s = d.toFixed(5);
  while (s.endsWith('0')) s = s.slice(0, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === '-0') s = '0';
  return s;
}

const HEX = '0123456789ABCDEF';
export function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i] >> 4] + HEX[u8[i] & 15];
  return s;
}

function writeName(w, n) {
  let s = '/';
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c > 0xff) {
      for (const b of new TextEncoder().encode(n[i])) s += '#' + HEX[b >> 4] + HEX[b & 15];
      continue;
    }
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(n[i])) s += '#' + HEX[c >> 4] + HEX[c & 15];
    else s += n[i];
  }
  w.str(s);
}

function writeLiteral(w, bytes) {
  const out = [0x28];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c, b);
    else if (b === 0x0a) out.push(0x5c, 0x6e);
    else if (b === 0x0d) out.push(0x5c, 0x72);
    else if (b >= 0x20 && b <= 0x7e) out.push(b);
    else {
      const o = b.toString(8).padStart(3, '0');
      out.push(0x5c, o.charCodeAt(0), o.charCodeAt(1), o.charCodeAt(2));
    }
  }
  out.push(0x29);
  w.bytes(Uint8Array.from(out));
}

function writeDict(w, d) {
  w.str('<<');
  for (const [k, v] of d.entries()) {
    w.str(' ');
    writeName(w, k);
    w.str(' ');
    writeObject(w, v);
  }
  w.str(' >>');
}

export function writeObject(w, o) {
  if (o === null || o === undefined) w.str('null');
  else if (o === true) w.str('true');
  else if (o === false) w.str('false');
  else if (typeof o === 'number') w.str(formatNumber(o));
  else if (o instanceof PName) writeName(w, o.v);
  else if (o instanceof PString) {
    if (o.hex) w.str('<' + toHex(o.bytes) + '>');
    else writeLiteral(w, o.bytes);
  } else if (o instanceof PRef) w.str(`${o.num} ${o.gen} R`);
  else if (Array.isArray(o)) {
    w.str('[');
    o.forEach((e, i) => {
      if (i > 0) w.str(' ');
      writeObject(w, e);
    });
    w.str(']');
  } else if (o instanceof PDict) writeDict(w, o);
  else if (o instanceof PStream) {
    const d = o.dict.clone();
    d.set('Length', o.data.length);
    writeDict(w, d);
    w.str('\nstream\n');
    w.bytes(o.data);
    w.str('\nendstream');
  } else throw new PDFError('syntax', 'unbekannter Objekttyp');
}
