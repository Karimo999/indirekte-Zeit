// Zeitnachweis eines Mitarbeiters (Excel-Export aus Kilanka): indirekte Stunden fuer das Stundenkonto.
// Gezaehlt werden Eintraege mit Klient (ein Eintrag mit Klient ist ein Klienteneinsatz):
//   Segeberg: 12 Min. pro Eintrag mit Klient
//   Pinneberg: 20 % der Stunden je Klient, Obergrenze (3 Std./Woche, 13,02 Std./Monat) je Klient
//              und zusaetzlich fuer den Mitarbeiter insgesamt
import { leseXlsx } from './xlsx.js';
import { Tag, DE, standortById, anwesenheitstage, pinnebergGrenze } from './nachweis.js';

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ');
const leer = (v) => v === undefined || v === null || String(v).trim() === '';

/** Excel-Datumszahl (1900-System) -> Tag */
function excelDatum(zahl) {
  const d = new Date(Math.round((zahl - 25569) * 86400000));
  return new Tag(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
function alsTag(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return excelDatum(v);
  if (typeof v === 'string') return Tag.parseAtStart(v);
  return null;
}
/** Stunden als Dezimalzahl (5.4166), Text ("5,42") oder Uhrzeit ("5:25") -> Minuten */
function alsMinuten(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 60);
  if (typeof v === 'string' && v.trim()) {
    const hm = DE.parseHourMinute(v.trim());
    if (hm !== null) return hm;
    const c = DE.parseCenti(v.trim());
    if (c !== null) return Math.round((c * 60) / 100);
  }
  return null;
}

const KOPF = {
  datum: ['datum', 'tag'],
  stunden: ['stunden', 'std', 'dauer', 'arbeitsstunden', 'stunden gesamt'],
  klient: ['klient', 'klientin', 'klient/in', 'klient*in', 'klienten', 'junger mensch'],
  arbeitszeit: ['arbeitszeit', 'zeit', 'uhrzeit', 'zeitraum'],
  kommentar: ['kommentar', 'bemerkung', 'bemerkungen'],
};

function interpretieren(zeilen) {
  let kopf = null;
  for (const z of zeilen) {
    const n = z.werte.map(norm);
    const finde = (namen) => n.findIndex((x) => namen.includes(x));
    const k = { nr: z.nr, datum: finde(KOPF.datum), stunden: finde(KOPF.stunden), klient: finde(KOPF.klient), arbeitszeit: finde(KOPF.arbeitszeit), kommentar: finde(KOPF.kommentar) };
    if (k.datum >= 0 && k.stunden >= 0 && k.klient >= 0) { kopf = k; break; }
  }
  if (!kopf) return null;

  // Angaben ueber der Tabelle: Mitarbeiter, Von, Bis (Wert steht rechts neben der Beschriftung)
  let mitarbeiter = null;
  let von = null;
  let bis = null;
  for (const z of zeilen) {
    if (z.nr >= kopf.nr) break;
    z.werte.forEach((v, i) => {
      const n = norm(v);
      const rechts = () => z.werte.slice(i + 1).find((x) => !leer(x));
      if (['mitarbeiter', 'mitarbeiterin', 'mitarbeitende', 'mitarbeiter/in'].includes(n) && mitarbeiter === null) {
        const r = rechts();
        if (r !== undefined) mitarbeiter = String(r).trim();
      } else if (['von', 'zeitraum von', 'beginn'].includes(n) && von === null) {
        const r = rechts();
        if (r !== undefined) von = alsTag(r);
      } else if (['bis', 'zeitraum bis', 'ende'].includes(n) && bis === null) {
        const r = rechts();
        if (r !== undefined) bis = alsTag(r);
      }
    });
  }

  const eintraege = [];
  for (const z of zeilen) {
    if (z.nr <= kopf.nr) continue;
    if (norm(z.werte[0]).startsWith('übersicht') || norm(z.werte[0]).startsWith('unterschrift')) break;
    const tag = alsTag(z.werte[kopf.datum]);
    if (!tag) continue;
    let minuten = alsMinuten(z.werte[kopf.stunden]);
    if (minuten === null && kopf.arbeitszeit >= 0) minuten = DE.parseTimeRange(String(z.werte[kopf.arbeitszeit] ?? ''));
    eintraege.push({
      tag,
      minuten: minuten || 0,
      klient: leer(z.werte[kopf.klient]) ? '' : String(z.werte[kopf.klient]).trim(),
      kommentar: kopf.kommentar >= 0 && !leer(z.werte[kopf.kommentar]) ? String(z.werte[kopf.kommentar]).trim() : '',
    });
  }
  if (!eintraege.length) return null;
  const sortiert = eintraege.map((e) => e.tag).sort((a, b) => a.key - b.key);
  if (!von) von = sortiert[0];
  if (!bis) bis = sortiert[sortiert.length - 1];
  const imZeitraum = eintraege.filter((e) => e.tag.key >= von.key && e.tag.key <= bis.key);
  return { mitarbeiter, von, bis, zeitraum: `${von} - ${bis}`, eintraege: imZeitraum };
}

/**
 * Liest einen Zeitnachweis aus einer .xlsx-Datei.
 * @returns {{mitarbeiter: string|null, von: Tag, bis: Tag, zeitraum: string, eintraege: object[]} | {fehler: string}}
 */
export function leseZeitnachweis(bytes) {
  let blaetter;
  try {
    blaetter = leseXlsx(bytes);
  } catch (e) {
    return { fehler: e.message || 'Die Excel-Datei konnte nicht gelesen werden.' };
  }
  for (const b of blaetter) {
    const r = interpretieren(b.zeilen);
    if (r) return r;
  }
  return { fehler: 'In dieser Excel-Datei wurde kein Zeitnachweis erkannt (es fehlen die Spalten „Datum“, „Stunden“ und „Klient“).' };
}

/** Indirekte Stunden aus einem gelesenen Zeitnachweis, je Klient nach den Regeln des Standorts */
export function berechneZeitnachweis(zn, standortId) {
  const st = standortById(standortId);
  const proKlient = new Map();
  let ohneKlient = 0;
  for (const e of zn.eintraege) {
    if (!e.klient) { ohneKlient++; continue; }
    if (!(e.minuten > 0)) continue;
    if (!proKlient.has(e.klient)) proKlient.set(e.klient, []);
    proKlient.get(e.klient).push(e);
  }
  const klienten = [];
  for (const [name, liste] of proKlient) {
    const n = {
      zeitraum: zn.zeitraum,
      eintraege: liste.map((e) => ({ tag: e.tag, minuten: e.minuten, stunden: DE.centiFromMinutes(e.minuten) })),
    };
    const direkt = DE.centiFromMinutes(liste.reduce((s, e) => s + e.minuten, 0));
    let ind;
    if (st.id === 'segeberg') {
      // jeder Eintrag mit Klient ist ein Einsatz
      ind = { centi: liste.length * 20, formel: `${liste.length} ${liste.length === 1 ? 'Eintrag' : 'Einträge'} × 12 Min.` };
    } else ind = st.berechne(n, direkt);
    klienten.push({ name, eintraege: liste.length, tage: anwesenheitstage(n).length, direkt, indirekt: ind.centi, formel: ind.formel });
  }
  klienten.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const direkt = klienten.reduce((s, k) => s + k.direkt, 0);
  let indirekt = klienten.reduce((s, k) => s + k.indirekt, 0);
  // Pinneberg: Obergrenze gilt auch fuer den Mitarbeiter insgesamt
  let kappung = null;
  if (st.id === 'pinneberg') {
    const { grenze, text } = pinnebergGrenze({ zeitraum: zn.zeitraum });
    if (indirekt > grenze) {
      kappung = { vorher: indirekt, grenze, text };
      indirekt = grenze;
    }
  }
  return {
    klienten, direkt, indirekt, gesamt: direkt + indirekt, ohneKlient, kappung,
    eintraegeMitKlient: klienten.reduce((s, k) => s + k.eintraege, 0),
    indirektText: DE.format(indirekt),
  };
}
