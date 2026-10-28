// Liest die Struktur einer PDF-Datei (Xref-Tabellen/-Streams, Objekt-Streams,
// inkrementelle Updates). Die Originalbytes werden nie veraendert.
import { unzlibSync, inflateSync } from 'fflate';
import {
  PDFError, PDict, PName, PRef, PStream, Lexer, isWhite, isRegular, isDigit, hexVal,
  nameOf, intOf, dictOf,
} from './core.js';

const FREE = 0, OFFSET = 1, COMPRESSED = 2;

function inflate(data) {
  if (data.length === 0) return data;
  try {
    const d = unzlibSync(data);
    if (d.length) return d;
  } catch (_) { /* weiter */ }
  try {
    const d = inflateSync(data);
    if (d.length) return d;
  } catch (_) { /* weiter */ }
  // abgeschnittene Streams: so viel wie moeglich lesen
  try {
    const d = inflateSync(data.subarray(2));
    if (d.length) return d;
  } catch (_) { /* weiter */ }
  throw new PDFError('decompress', 'Komprimierte Daten nicht lesbar');
}

function asciiHex(d) {
  const out = [];
  let hi = -1;
  for (const c of d) {
    if (c === 0x3e) break;
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi >= 0) { out.push((hi << 4) | v); hi = -1; } else hi = v;
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

function ascii85(d) {
  const out = [];
  let group = [];
  let start = 0;
  if (d.length >= 2 && d[0] === 0x3c && d[1] === 0x7e) start = 2;
  for (let i = start; i < d.length; i++) {
    const c = d[i];
    if (c === 0x7e) break;
    if (isWhite(c)) continue;
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) throw new PDFError('decompress');
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const full = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...full.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function unpredict(data, parms) {
  const predictor = parms ? intOf(parms.get('Predictor')) : undefined;
  if (!predictor || predictor <= 1) return data;
  const colors = Math.max(1, intOf(parms.get('Colors')) || 1);
  const bpc = Math.max(1, intOf(parms.get('BitsPerComponent')) || 8);
  const columns = Math.max(1, intOf(parms.get('Columns')) || 1);
  const bpp = Math.max(1, Math.floor((colors * bpc + 7) / 8));
  const rowLen = Math.floor((columns * colors * bpc + 7) / 8);
  if (predictor === 2) {
    if (bpc !== 8) throw new PDFError('unsupported', 'TIFF-Prädiktor');
    const out = Uint8Array.from(data);
    for (let i = 0; i < out.length; i += rowLen) {
      const rowEnd = Math.min(i + rowLen, out.length);
      for (let k = i + bpp; k < rowEnd; k++) out[k] = (out[k] + out[k - bpp]) & 255;
    }
    return out;
  }
  const out = [];
  let prev = new Uint8Array(rowLen);
  let i = 0;
  while (i < data.length) {
    const ft = data[i++];
    const row = new Uint8Array(rowLen);
    const n = Math.min(rowLen, data.length - i);
    for (let k = 0; k < n; k++) row[k] = data[i + k];
    i += rowLen;
    for (let k = 0; k < rowLen; k++) {
      const left = k >= bpp ? row[k - bpp] : 0;
      const up = prev[k];
      const upLeft = k >= bpp ? prev[k - bpp] : 0;
      switch (ft) {
        case 0: break;
        case 1: row[k] = (row[k] + left) & 255; break;
        case 2: row[k] = (row[k] + up) & 255; break;
        case 3: row[k] = (row[k] + ((left + up) >> 1)) & 255; break;
        case 4: {
          const pa = Math.abs(up - upLeft);
          const pb = Math.abs(left - upLeft);
          const pc = Math.abs(left + up - 2 * upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          row[k] = (row[k] + pred) & 255;
          break;
        }
        default: throw new PDFError('unsupported', 'PNG-Filter ' + ft);
      }
    }
    for (const v of row) out.push(v);
    prev = row;
  }
  return Uint8Array.from(out);
}

export class PDFFile {
  constructor(data) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.b = this.data;
    this.trailer = new PDict();
    this.startXref = 0;
    this.lastXrefIsStream = false;
    this.wasReconstructed = false;
    this.xref = new Map(); // num -> {type, a, b}
    this.cache = new Map();
    this.objStreams = new Map();
    this.resolving = new Set();

    if (this.b.length <= 32) throw new PDFError('syntax', 'Datei ist leer');
    if (this.indexOf('%PDF-', 0, Math.min(this.b.length, 1024)) < 0) throw new PDFError('syntax', 'keine PDF-Datei');
    try {
      this.loadXref();
    } catch (_) {
      this.reconstruct();
    }
    if (!this.trailer.get('Root') || !this.dictionary(this.trailer.get('Root'))) this.reconstruct();
    if (!this.trailer.get('Root')) throw new PDFError('syntax', 'Katalog fehlt');
  }

  get isEncrypted() { return this.trailer.has('Encrypt'); }

  get nextObjectNumber() {
    let max = 0;
    for (const k of this.xref.keys()) if (k > max) max = k;
    return Math.max(intOf(this.trailer.get('Size')) || 0, max + 1);
  }

  // ------------------------------------------------------------ Suche

  indexOf(pattern, from, to) {
    const b = this.b;
    const stop = Math.min(to === undefined ? b.length : to, b.length) - pattern.length;
    const first = pattern.charCodeAt(0);
    for (let i = Math.max(0, from); i <= stop; i++) {
      if (b[i] !== first) continue;
      let ok = true;
      for (let k = 1; k < pattern.length; k++) if (b[i + k] !== pattern.charCodeAt(k)) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  lastIndexOf(pattern, before, after = 0) {
    const b = this.b;
    for (let i = Math.min(before, b.length) - pattern.length; i >= after; i--) {
      if (b[i] !== pattern.charCodeAt(0)) continue;
      let ok = true;
      for (let k = 1; k < pattern.length; k++) if (b[i + k] !== pattern.charCodeAt(k)) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  matchesAt(word, pos) {
    if (pos < 0 || pos + word.length > this.b.length) return false;
    for (let k = 0; k < word.length; k++) if (this.b[pos + k] !== word.charCodeAt(k)) return false;
    return true;
  }

  // ------------------------------------------------------------ Xref

  loadXref() {
    const sx = this.lastIndexOf('startxref', this.b.length, Math.max(0, this.b.length - 4096));
    if (sx < 0) throw new PDFError('syntax', 'startxref fehlt');
    const lx = new Lexer(this.b, sx + 9);
    const t = lx.next();
    if (t.t !== 'int') throw new PDFError('syntax', 'startxref ungültig');
    this.startXref = t.v;
    const visited = new Set();
    let next = t.v;
    let first = true;
    while (next !== undefined && !visited.has(next)) {
      visited.add(next);
      const { entries, trailer, isStream } = this.readXrefSection(next);
      if (first) {
        this.trailer = trailer.clone();
        this.lastXrefIsStream = isStream;
        if (isStream) this.cleanTrailer();
        first = false;
      }
      for (const [num, e] of entries) if (!this.xref.has(num)) this.xref.set(num, e);
      const xs = intOf(trailer.get('XRefStm'));
      if (!isStream && xs !== undefined && !visited.has(xs)) {
        visited.add(xs);
        try {
          const sec = this.readXrefSection(xs);
          for (const [num, e] of sec.entries) if (!this.xref.has(num)) this.xref.set(num, e);
        } catch (_) { /* ignorieren */ }
      }
      next = intOf(trailer.get('Prev'));
    }
  }

  cleanTrailer() {
    for (const k of ['Type', 'W', 'Index', 'Length', 'Filter', 'DecodeParms', 'Prev', 'XRefStm']) this.trailer.delete(k);
  }

  looksLikeObjectHeader(pos) {
    const lx = new Lexer(this.b, pos);
    lx.refsAllowed = false;
    try {
      const a = lx.next(), b = lx.next(), c = lx.next();
      return a.t === 'int' && b.t === 'int' && c.t === 'kw' && c.v === 'obj';
    } catch (_) {
      return false;
    }
  }

  readXrefSection(rawOffset) {
    let off = rawOffset;
    const probe = new Lexer(this.b, off);
    probe.skipWS();
    if (!probe.matches('xref', probe.p) && !this.looksLikeObjectHeader(probe.p)) {
      const x = this.indexOf('xref', Math.max(0, rawOffset - 64), Math.min(this.b.length, rawOffset + 64));
      if (x < 0) throw new PDFError('syntax', 'Xref-Offset ungültig');
      off = x;
    } else off = probe.p;

    const lx = new Lexer(this.b, off);
    if (lx.matches('xref', off)) {
      lx.p = off + 4;
      const entries = [];
      for (;;) {
        lx.skipWS();
        if (lx.matches('trailer', lx.p)) { lx.p += 7; break; }
        const s = lx.next(), c = lx.next();
        if (s.t !== 'int' || c.t !== 'int' || c.v < 0 || c.v > 10_000_000) throw new PDFError('syntax', 'Xref-Tabelle');
        for (let i = 0; i < c.v; i++) {
          const o = lx.next(), g = lx.next(), k = lx.next();
          if (o.t !== 'int' || g.t !== 'int' || k.t !== 'kw') throw new PDFError('syntax', 'Xref-Eintrag');
          entries.push([s.v + i, k.v === 'n' && o.v > 0 ? { type: OFFSET, a: o.v, b: g.v } : { type: FREE }]);
        }
      }
      const tr = lx.parseObject();
      if (!(tr instanceof PDict)) throw new PDFError('syntax', 'Trailer');
      return { entries, trailer: tr, isStream: false };
    }

    const [, obj] = this.parseIndirect(off);
    if (!(obj instanceof PStream) || nameOf(obj.dict.get('Type')) !== 'XRef') throw new PDFError('syntax', 'Xref-Stream erwartet');
    const dec = this.decode(obj);
    const w = (obj.dict.get('W') || []).map(intOf);
    if (w.length < 3 || w.some((x) => x === undefined)) throw new PDFError('syntax', 'Xref-Stream /W');
    const size = intOf(obj.dict.get('Size')) || 0;
    let index = (obj.dict.get('Index') || []).map(intOf).filter((x) => x !== undefined);
    if (!index.length) index = [0, size];
    const rowLen = w[0] + w[1] + w[2];
    if (rowLen <= 0) throw new PDFError('syntax', 'Xref-Stream /W');
    const entries = [];
    let pos = 0;
    const field = (width) => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + (pos < dec.length ? dec[pos++] : (pos++, 0));
      return v;
    };
    for (let k = 0; k + 1 < index.length; k += 2) {
      const start = index[k], count = index[k + 1];
      for (let i = 0; i < Math.max(0, count); i++) {
        if (pos + rowLen > dec.length) break;
        const type = w[0] === 0 ? 1 : field(w[0]);
        const f2 = field(w[1]);
        const f3 = field(w[2]);
        if (type === 1) entries.push([start + i, f2 > 0 ? { type: OFFSET, a: f2, b: f3 } : { type: FREE }]);
        else if (type === 2) entries.push([start + i, { type: COMPRESSED, a: f2, b: f3 }]);
        else entries.push([start + i, { type: FREE }]);
      }
    }
    return { entries, trailer: obj.dict, isStream: true };
  }

  reconstruct() {
    this.wasReconstructed = true;
    this.xref = new Map();
    this.cache = new Map();
    this.objStreams = new Map();
    this.trailer = new PDict();
    const trailers = [];
    const b = this.b;
    const n = b.length;
    for (let i = 1; i < n - 3; i++) {
      const c = b[i];
      if (c === 0x6f && b[i + 1] === 0x62 && b[i + 2] === 0x6a && isWhite(b[i - 1]) && (i + 3 >= n || !isRegular(b[i + 3]))) {
        let j = i - 1;
        while (j >= 0 && isWhite(b[j])) j--;
        const genEnd = j + 1;
        while (j >= 0 && isDigit(b[j])) j--;
        const genStart = j + 1;
        if (genStart < genEnd) {
          while (j >= 0 && isWhite(b[j])) j--;
          const numEnd = j + 1;
          while (j >= 0 && isDigit(b[j])) j--;
          const numStart = j + 1;
          if (numStart < numEnd && numEnd - numStart < 10 && (j < 0 || !isRegular(b[j]))) {
            const num = parseInt(String.fromCharCode(...b.subarray(numStart, numEnd)), 10);
            const gen = parseInt(String.fromCharCode(...b.subarray(genStart, genEnd)), 10) || 0;
            if (num > 0) this.xref.set(num, { type: OFFSET, a: numStart, b: gen });
          }
        }
        i += 2;
        continue;
      }
      if (c === 0x74 && this.matchesAt('trailer', i)) {
        try {
          const lx = new Lexer(b, i + 7);
          const d = lx.parseObject();
          if (d instanceof PDict) trailers.push(d);
        } catch (_) { /* ignorieren */ }
      }
    }
    const withRoot = trailers.filter((t) => t.get('Root'));
    if (withRoot.length) this.trailer = withRoot[withRoot.length - 1].clone();
    const nums = [...this.xref.keys()].sort((a, c) => a - c);
    for (const num of nums) {
      const e = this.xref.get(num);
      if (e.type !== OFFSET) continue;
      const o = this.object(new PRef(num));
      if (!(o instanceof PStream)) continue;
      const type = nameOf(o.dict.get('Type'));
      if (type === 'ObjStm') {
        try {
          const os = this.loadObjectStream(num);
          let idx = 0;
          for (const [objNum] of [...os.offsets.entries()].sort((x, y) => x[1] - y[1])) {
            if (!this.xref.has(objNum)) this.xref.set(objNum, { type: COMPRESSED, a: num, b: idx });
            idx++;
          }
        } catch (_) { /* ignorieren */ }
      } else if (type === 'XRef' && !this.trailer.get('Root')) {
        this.trailer = o.dict.clone();
        this.cleanTrailer();
      }
    }
    if (!this.trailer.get('Root')) {
      for (const num of [...this.xref.keys()].sort((a, c) => a - c)) {
        const d = dictOf(this.object(new PRef(num)));
        if (d && nameOf(d.get('Type')) === 'Catalog') {
          this.trailer.set('Root', new PRef(num));
          break;
        }
      }
    }
    let max = 0;
    for (const k of this.xref.keys()) if (k > max) max = k;
    this.trailer.set('Size', max + 1);
    this.trailer.delete('Prev');
    this.trailer.delete('XRefStm');
    this.lastXrefIsStream = [...this.xref.values()].some((e) => e.type === COMPRESSED);
    this.cache = new Map();
  }

  allEntries() {
    return [...this.xref.entries()].sort((a, b) => a[0] - b[0]);
  }

  // ------------------------------------------------------------ Objekte

  parseIndirect(off) {
    const lx = new Lexer(this.b, off);
    lx.refsAllowed = false;
    const a = lx.next(), g = lx.next(), k = lx.next();
    if (a.t !== 'int' || g.t !== 'int' || k.t !== 'kw' || k.v !== 'obj') throw new PDFError('syntax', 'Objekt erwartet bei ' + off);
    lx.refsAllowed = true;
    const obj = lx.parseObject();
    if (obj instanceof PDict) {
      const save = lx.p;
      lx.skipWS();
      if (lx.matches('stream', lx.p)) {
        lx.p += 6;
        if (lx.p < this.b.length && this.b[lx.p] === 0x0d) lx.p++;
        if (lx.p < this.b.length && this.b[lx.p] === 0x0a) lx.p++;
        const start = lx.p;
        let length = -1;
        const lo = obj.get('Length');
        if (typeof lo === 'number') length = Math.round(lo);
        else if (lo instanceof PRef) {
          const l = this.object(lo);
          if (typeof l === 'number') length = Math.round(l);
        }
        let valid = false;
        if (length >= 0 && start + length <= this.b.length) {
          let q = start + length;
          while (q < this.b.length && isWhite(this.b[q])) q++;
          valid = this.matchesAt('endstream', q);
        }
        if (!valid) {
          const e = this.indexOf('endstream', start);
          if (e < 0) throw new PDFError('syntax', 'endstream fehlt');
          let stop = e;
          if (stop > start && this.b[stop - 1] === 0x0a) stop--;
          if (stop > start && this.b[stop - 1] === 0x0d) stop--;
          length = stop - start;
        }
        return [new PRef(a.v, g.v), new PStream(obj, this.b.subarray(start, start + length))];
      }
      lx.p = save;
    }
    return [new PRef(a.v, g.v), obj];
  }

  loadObjectStream(num) {
    if (this.objStreams.has(num)) return this.objStreams.get(num);
    const s = this.object(new PRef(num));
    if (!(s instanceof PStream)) throw new PDFError('notFound', 'Objekt-Stream ' + num);
    const dec = this.decode(s);
    const n = intOf(s.dict.get('N')) || 0;
    const first = intOf(s.dict.get('First')) || 0;
    const lx = new Lexer(dec, 0);
    lx.refsAllowed = false;
    const offsets = new Map();
    for (let i = 0; i < n; i++) {
      const on = lx.next(), oo = lx.next();
      if (on.t !== 'int' || oo.t !== 'int') break;
      offsets.set(on.v, first + oo.v);
    }
    const os = { bytes: dec, offsets };
    this.objStreams.set(num, os);
    return os;
  }

  object(ref) {
    const num = ref.num;
    if (this.cache.has(num)) return this.cache.get(num);
    if (this.resolving.has(num)) return null;
    this.resolving.add(num);
    let result = null;
    try {
      const e = this.xref.get(num);
      if (e && e.type === OFFSET) {
        try {
          const [r, o] = this.parseIndirect(e.a);
          if (r.num === num) result = o;
          else throw new Error('falsches Objekt');
        } catch (_) {
          const fixed = this.searchHeader(num, e.a);
          if (fixed >= 0) {
            try { result = this.parseIndirect(fixed)[1]; } catch (_) { /* ignorieren */ }
          }
        }
      } else if (e && e.type === COMPRESSED) {
        try {
          const os = this.loadObjectStream(e.a);
          const off = os.offsets.get(num);
          if (off !== undefined) result = new Lexer(os.bytes, off).parseObject();
        } catch (_) { /* ignorieren */ }
      }
    } finally {
      this.resolving.delete(num);
    }
    this.cache.set(num, result);
    return result;
  }

  searchHeader(num, near) {
    const pat = num + ' ';
    const lo = Math.max(0, near - 512), hi = Math.min(this.b.length, near + 512);
    let i = lo;
    for (;;) {
      const k = this.indexOf(pat, i, hi);
      if (k < 0) return -1;
      if ((k === 0 || !isRegular(this.b[k - 1])) && this.looksLikeObjectHeader(k)) {
        const t = new Lexer(this.b, k).next();
        if (t.t === 'int' && t.v === num) return k;
      }
      i = k + 1;
    }
  }

  resolve(o) {
    if (o instanceof PRef) return this.object(o);
    return o;
  }

  dictionary(o) {
    return dictOf(this.resolve(o));
  }

  // ------------------------------------------------------------ Streams

  decode(s) {
    let filters = [];
    let parms = [];
    const f = this.resolve(s.dict.get('Filter'));
    if (f instanceof PName) filters = [f.v];
    else if (Array.isArray(f)) filters = f.map((x) => nameOf(this.resolve(x))).filter(Boolean);
    const dp = this.resolve(s.dict.get('DecodeParms') ?? s.dict.get('DP'));
    if (dp instanceof PDict) parms = [dp];
    else if (Array.isArray(dp)) parms = dp.map((x) => this.dictionary(x));
    let data = s.data;
    filters.forEach((name, i) => {
      const p = parms[i];
      switch (name) {
        case 'FlateDecode':
        case 'Fl':
          data = unpredict(inflate(data), p);
          break;
        case 'ASCIIHexDecode':
        case 'AHx':
          data = asciiHex(data);
          break;
        case 'ASCII85Decode':
        case 'A85':
          data = ascii85(data);
          break;
        default:
          throw new PDFError('unsupported', 'Filter ' + name);
      }
    });
    return data;
  }

  // ------------------------------------------------------------ Seiten

  pageRefs() {
    const root = this.dictionary(this.trailer.get('Root'));
    if (!root || !root.get('Pages')) return [];
    const out = [];
    const seen = new Set();
    const walk = (o, depth) => {
      if (depth > 64 || !(o instanceof PRef) || seen.has(o.num)) return;
      seen.add(o.num);
      const d = dictOf(this.object(o));
      if (!d) return;
      const type = nameOf(d.get('Type'));
      const kids = this.resolve(d.get('Kids'));
      if (type !== 'Page' && Array.isArray(kids)) {
        for (const k of kids) walk(k, depth + 1);
      } else if (type === 'Page' || d.get('Contents') || d.get('MediaBox') || type === undefined) {
        out.push(o);
      }
    };
    walk(root.get('Pages'), 0);
    return out;
  }

  inherited(page, key) {
    let d = page;
    let depth = 0;
    while (d && depth < 64) {
      if (d.has(key)) return d.get(key);
      d = this.dictionary(d.get('Parent'));
      depth++;
    }
    return undefined;
  }

  pageResources(page) {
    return this.dictionary(this.inherited(page, 'Resources')) || new PDict();
  }

  contentData(page) {
    const c = page.get('Contents');
    if (!c) return new Uint8Array(0);
    let items = [c];
    const rc = this.resolve(c);
    if (Array.isArray(rc)) items = rc;
    const parts = [];
    let total = 0;
    for (const it of items) {
      const s = this.resolve(it);
      if (!(s instanceof PStream)) continue;
      try {
        const d = this.decode(s);
        parts.push(d);
        total += d.length + 1;
      } catch (_) { /* ignorieren */ }
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
      out[o++] = 0x0a;
    }
    return out;
  }
}

export const XREF = { FREE, OFFSET, COMPRESSED };
