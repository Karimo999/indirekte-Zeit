// Liest Excel-Dateien (.xlsx) ohne weitere Bibliotheken: ZIP entpacken, Tabellenblaetter als Zellen.
import { unzipSync, strFromU8 } from 'fflate';

const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const entschluesseln = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITAETEN[e];
});

/** Text aller <t>-Elemente (ohne phonetische Hilfen) */
function texte(xml) {
  const ohne = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(ohne))) s += m[1] ? entschluesseln(m[1]) : '';
  return s;
}

/** "AB12" -> { spalte: 27, zeile: 12 } (Spalten ab 0) */
export function zellbezug(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let spalte = 0;
  for (const c of m[1]) spalte = spalte * 26 + (c.charCodeAt(0) - 64);
  return { spalte: spalte - 1, zeile: parseInt(m[2], 10) };
}

function blattLesen(xml, sst) {
  const zeilen = new Map(); // Zeilennummer -> Array von Werten
  const re = /<c\b((?:[^>/]|\/(?!>))*)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const inner = m[2] || '';
    const r = /\br="([A-Z]+\d+)"/.exec(attrs);
    if (!r) continue;
    const ort = zellbezug(r[1]);
    if (!ort) continue;
    const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
    let wert = null;
    if (t === 'inlineStr') wert = texte(inner);
    else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (v) {
        const roh = entschluesseln(v[1]);
        if (t === 's') wert = sst[parseInt(roh, 10)] ?? null;
        else if (t === 'str' || t === 'e') wert = roh;
        else if (t === 'b') wert = roh === '1';
        else {
          const z = Number(roh);
          wert = Number.isFinite(z) ? z : roh;
        }
      }
    }
    if (wert === null || wert === '') continue;
    if (!zeilen.has(ort.zeile)) zeilen.set(ort.zeile, []);
    zeilen.get(ort.zeile)[ort.spalte] = wert;
  }
  return [...zeilen.entries()].sort((a, b) => a[0] - b[0]).map(([nr, werte]) => ({ nr, werte }));
}

/**
 * Liest alle Tabellenblaetter einer .xlsx-Datei.
 * @returns {{name: string, zeilen: {nr: number, werte: any[]}[]}[]}
 */
export function leseXlsx(bytes) {
  let dateien;
  try {
    dateien = unzipSync(bytes, { filter: (f) => f.name.startsWith('xl/') });
  } catch (_) {
    throw new Error('Die Excel-Datei konnte nicht geöffnet werden.');
  }
  const text = (pfad) => (dateien[pfad] ? strFromU8(dateien[pfad]) : null);
  const sstXml = text('xl/sharedStrings.xml');
  const sst = [];
  if (sstXml) {
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    let m;
    while ((m = re.exec(sstXml))) sst.push(m[1] ? texte(m[1]) : '');
  }
  // Blattreihenfolge aus workbook.xml, Pfade aus den Beziehungen
  const wb = text('xl/workbook.xml') || '';
  const rels = text('xl/_rels/workbook.xml.rels') || '';
  const ziele = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = (/\bId="([^"]+)"/.exec(m[0]) || [])[1];
    const ziel = (/\bTarget="([^"]+)"/.exec(m[0]) || [])[1];
    if (id && ziel) ziele.set(id, ziel.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const blaetter = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = entschluesseln((/\bname="([^"]*)"/.exec(m[0]) || [])[1] || '');
    const rid = (/\br:id="([^"]+)"/.exec(m[0]) || [])[1];
    const pfad = rid && ziele.get(rid) ? 'xl/' + ziele.get(rid) : null;
    const xml = pfad ? text(pfad) : null;
    if (xml) blaetter.push({ name, zeilen: blattLesen(xml, sst) });
  }
  if (!blaetter.length) {
    for (const pfad of Object.keys(dateien).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p)).sort()) {
      blaetter.push({ name: pfad, zeilen: blattLesen(strFromU8(dateien[pfad]), sst) });
    }
  }
  return blaetter;
}
