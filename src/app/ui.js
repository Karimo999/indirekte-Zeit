// Oberflaeche von „Indirekte Zeit“ – gemeinsam fuer die Desktop-App und die Testversion im Browser.
// Plattformabhaengiges (Dateien oeffnen/speichern, Updates) kommt ueber das Objekt `p`.
import { unzipSync } from 'fflate';
import { verarbeite, STANDORTE, standortById, DE, Tag, pinnebergGrenze } from '../engine/nachweis.js';
import { leseZeitnachweis, berechneZeitnachweis } from '../engine/zeitnachweis.js';

export const SUFFIX = '_ergaenzt';

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const pause = () => new Promise((r) => setTimeout(r, 0));
const speicher = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* egal */ } },
};
const anzahl = (n, eins, mehr) => `${n} ${n === 1 ? eins : mehr}`;
const pad = (n) => String(n).padStart(2, '0');
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** letztes Datum im Zeitraum („01.10.2026 - 31.10.2026“ -> 31.10.2026) */
function endeDatum(zeitraum) {
  const alle = [...String(zeitraum || '').matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)];
  if (!alle.length) return null;
  const [, t, m, j] = alle[alle.length - 1];
  const tag = +t, monat = +m, jahr = +j;
  if (monat < 1 || monat > 12) return null;
  return { tag, monat, jahr, wert: jahr * 10000 + monat * 100 + tag, text: `${pad(tag)}.${pad(monat)}.${jahr}` };
}

/**
 * Indirekte Stunden je Mitarbeiter (betreuende Fachkraft laut Nachweis) und Monat –
 * fuer die manuelle Buchung im Stundenkonto in Kilanka.
 */
export function mitarbeiterGruppen(dateien, standortId) {
  const gruppen = new Map();
  const gesehen = new Map(); // gleicher Nachweis in mehreren Dateien (z. B. Original und _ergaenzt) nur einmal zaehlen
  for (const d of dateien) {
    for (const n of d.ergebnis.nachweise) {
      if (n.indirekt === null || n.indirekt === undefined) continue;
      const ende = endeDatum(n.zeitraum);
      const fachkraft = (n.fachkraft || '').replace(/\s+/g, ' ').trim() || 'Ohne Angabe im Nachweis';
      const monat = ende ? `${ende.jahr}-${pad(ende.monat)}` : '?';
      const key = `${fachkraft}|${monat}`;
      let g = gruppen.get(key);
      if (!g) {
        g = {
          key, fachkraft, monatText: ende ? `${MONATE[ende.monat - 1]} ${ende.jahr}` : 'Zeitraum unbekannt',
          stichtag: null, stichtagWert: 0, direkt: 0, indirekt: 0, gesamt: 0, nachweise: [], doppelt: [],
        };
        gruppen.set(key, g);
      }
      const kennung = [fachkraft, n.name, n.zeitraum, n.direkt, n.anzahlTage].join('|');
      if (gesehen.has(kennung)) {
        g.doppelt.push({ d, n, wie: gesehen.get(kennung) });
        continue;
      }
      gesehen.set(kennung, d.name);
      g.direkt += n.direkt || 0;
      g.indirekt += n.indirekt;
      g.gesamt += n.gesamt || 0;
      g.nachweise.push({ d, n });
      const r = n.zeitraum ? Tag.parseRange(n.zeitraum) : null;
      if (r) {
        if (!g.von || r[0].key < g.von.key) g.von = r[0];
        if (!g.bis || r[1].key > g.bis.key) g.bis = r[1];
      }
      if (ende && ende.wert > g.stichtagWert) { g.stichtagWert = ende.wert; g.stichtag = ende.text; }
    }
  }
  // Zeitnachweise (Excel) je Mitarbeiter: sie enthalten alle Buchungen und ersetzen fuer diesen Monat
  // die Werte aus den Leistungsnachweisen (sonst wuerde doppelt gebucht)
  const ausExcel = new Map();
  for (const d of dateien) {
    if (d.art !== 'zeitnachweis' || !d.zn) continue;
    const zn = d.zeitnachweis;
    const fachkraft = (zn.mitarbeiter || '').replace(/\s+/g, ' ').trim() || 'Ohne Angabe im Zeitnachweis';
    const ende = { tag: zn.bis.day, monat: zn.bis.month, jahr: zn.bis.year, wert: zn.bis.key, text: String(zn.bis) };
    const key = `${fachkraft}|${ende.jahr}-${pad(ende.monat)}`;
    let g = ausExcel.get(key);
    if (!g) {
      g = {
        key, fachkraft, monatText: `${MONATE[ende.monat - 1]} ${ende.jahr}`, quelle: 'zeitnachweis',
        stichtag: null, stichtagWert: 0, direkt: 0, indirekt: 0, gesamt: 0, zeitnachweise: [], nachweise: [], doppelt: [], ersetzt: 0,
      };
      ausExcel.set(key, g);
    }
    if (g.zeitnachweise.some((x) => x.d.bytes.length === d.bytes.length && x.zn.zeitraum === zn.zeitraum && x.d.zn.indirekt === d.zn.indirekt)) {
      g.doppelt.push({ d, n: { name: d.name }, wie: g.zeitnachweise[0].d.name });
      continue;
    }
    g.zeitnachweise.push({ d, zn });
    g.direkt += d.zn.direkt;
    g.indirekt += d.zn.indirekt;
    g.gesamt += d.zn.gesamt;
    if (d.zn.kappung) g.kappung = d.zn.kappung;
    if (ende.wert > g.stichtagWert) { g.stichtagWert = ende.wert; g.stichtag = ende.text; }
  }
  // Pinneberg: die Obergrenze gilt auch fuer den Mitarbeiter insgesamt (Zeitraum aller seiner Nachweise im Monat)
  if (standortId === 'pinneberg') {
    for (const g of gruppen.values()) {
      if (!g.von || !g.bis) continue;
      const { grenze, text } = pinnebergGrenze({ zeitraum: `${g.von} - ${g.bis}` });
      if (g.indirekt > grenze) {
        g.kappung = { vorher: g.indirekt, grenze, text };
        g.gesamt -= g.indirekt - grenze;
        g.indirekt = grenze;
      }
    }
  }
  for (const [key, g] of ausExcel) {
    const pdf = gruppen.get(key);
    if (pdf) g.ersetzt = pdf.nachweise.length;
    gruppen.set(key, g);
  }
  return [...gruppen.values()].sort((a, b) => a.fachkraft.localeCompare(b.fachkraft, 'de') || a.key.localeCompare(b.key));
}

async function kopieren(text, knopf) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (_) { /* Rueckfall unten */ }
  if (!ok) {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.append(t);
    t.select();
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    t.remove();
  }
  knopf.textContent = ok ? 'Kopiert' : 'Nicht möglich';
  setTimeout(() => { knopf.textContent = 'Kopieren'; }, 1500);
}

/** Dateiname ohne Endung + Suffix */
export function zielName(name) {
  return name.replace(/\.pdf$/i, '') + SUFFIX + '.pdf';
}
export const istErgaenzt = (name) => /_ergaenzt\.pdf$/i.test(name);

/**
 * Wandelt gelesene Dateien in Eingaenge um. ZIP-Dateien werden entpackt.
 * @param {{name:string, bytes:Uint8Array, quelle:object, schluessel:string}[]} dateien
 */
const istExcel = (name) => /\.xlsx$/i.test(name) && !name.split('/').pop().startsWith('~$');
const istZeitnachweis = (d) => d.art === 'zeitnachweis';

export function entpacken(dateien) {
  const eingaenge = [];
  const fehler = [];
  for (const d of dateien) {
    if (/\.zip$/i.test(d.name)) {
      let inhalt;
      try {
        inhalt = unzipSync(d.bytes, { filter: (x) => (/\.pdf$/i.test(x.name) || istExcel(x.name)) && !x.name.startsWith('__MACOSX') });
      } catch (_) {
        fehler.push(`${d.name} konnte nicht entpackt werden.`);
        continue;
      }
      const namen = Object.keys(inhalt).sort((a, b) => a.localeCompare(b, 'de'));
      if (!namen.length) fehler.push(`In ${d.name} ist keine PDF- oder Excel-Datei.`);
      for (const n of namen) {
        const name = n.split('/').pop();
        if (istErgaenzt(name)) continue;
        eingaenge.push({
          name, bytes: inhalt[n], quelle: { ...d.quelle, zip: d.name, eintrag: n }, schluessel: d.schluessel + '#' + n,
          art: istExcel(name) ? 'zeitnachweis' : 'nachweis',
        });
      }
    } else if (/\.pdf$/i.test(d.name)) {
      eingaenge.push({ ...d, art: 'nachweis' });
    } else if (istExcel(d.name)) {
      eingaenge.push({ ...d, art: 'zeitnachweis' });
    } else {
      fehler.push(`${d.name} ist keine PDF-, Excel- oder ZIP-Datei.`);
    }
  }
  return { eingaenge, fehler };
}

export function starte(p) {
  const state = {
    standort: standortById(speicher.get('standort') || 'segeberg').id,
    dateien: [],
    auswahl: null, // { id, nachweis }
    ansicht: 'nachweise', // oder 'stundenkonto'
    maAuswahl: null, // Schluessel der gewaehlten Mitarbeiter-Gruppe
    beschaeftigt: false,
    zuletzt: null, // zuletzt gespeicherte Datei (fuer „Im Ordner zeigen“)
  };
  let naechsteId = 1;

  // ---------------------------------------------------------------- Status
  function status(text, fehler = false) {
    const s = $('status');
    s.textContent = text || '';
    s.title = text || '';
    s.classList.toggle('fehler', !!fehler);
  }
  function standardStatus(gruppen) {
    $('btn-zeigen').hidden = true;
    if (!state.dateien.length) return status('');
    if (state.ansicht === 'stundenkonto') {
      const g = gruppen || mitarbeiterGruppen(state.dateien, state.standort);
      if (!g.length) return status('');
      const leute = new Set(g.map((x) => x.fachkraft)).size;
      return status(`${anzahl(leute, 'Mitarbeiter', 'Mitarbeiter')} · zusammen ${DE.format(g.reduce((s, x) => s + x.indirekt, 0))} Std.`);
    }
    const zeilen = pdfDateien().flatMap((d) => (d.ergebnis.nachweise.length ? d.ergebnis.nachweise.map((n) => ({ d, n })) : [{ d, n: null }]));
    const bereit = zeilen.filter(({ d, n }) => n && n.status === 'bereit' && !d.gespeichert).length;
    const gespeichert = zeilen.filter(({ d, n }) => n && n.status === 'bereit' && d.gespeichert).length;
    const schon = zeilen.filter(({ n }) => n && n.status === 'bereitsErgaenzt').length;
    const fehler = zeilen.filter(({ n }) => !n || n.status === 'fehler').length;
    const teile = [];
    if (bereit) teile.push(`${bereit} ${bereit === 1 ? 'Nachweis' : 'Nachweise'} bereit`);
    if (gespeichert) teile.push(`${gespeichert} gespeichert`);
    if (schon) teile.push(`${schon} bereits ergänzt`);
    if (fehler) teile.push(`${fehler} nicht eingetragen`);
    status(teile.join(' · '));
  }

  // ---------------------------------------------------------------- Dateien
  async function hinzufuegen(laden) {
    if (state.beschaeftigt) return;
    state.beschaeftigt = true;
    status('Dateien werden gelesen …');
    let gelesen;
    try {
      gelesen = await laden();
    } catch (e) {
      state.beschaeftigt = false;
      status(e && e.message ? e.message : 'Die Dateien konnten nicht gelesen werden.', true);
      return;
    }
    if (!gelesen) { state.beschaeftigt = false; standardStatus(); return; }
    const { eingaenge, fehler } = entpacken(gelesen.dateien || []);
    fehler.push(...(gelesen.fehler || []));
    let erste = null;
    let neueZeitnachweise = 0;
    let neueNachweise = 0;
    for (let i = 0; i < eingaenge.length; i++) {
      const e = eingaenge[i];
      if (eingaenge.length > 3) status(`Wird gelesen … ${i + 1} von ${eingaenge.length}`);
      const leeresErgebnis = { nachweise: [], ausgabe: null, fehler: null, eintragungen: [] };
      let datei;
      if (e.art === 'zeitnachweis') {
        let zn;
        try { zn = leseZeitnachweis(e.bytes); } catch (_) { zn = { fehler: 'Die Excel-Datei konnte nicht gelesen werden.' }; }
        if (zn.fehler) { fehler.push(`${e.name}: ${zn.fehler}`); continue; }
        datei = {
          id: naechsteId++, art: 'zeitnachweis', name: e.name, bytes: e.bytes, quelle: e.quelle, schluessel: e.schluessel,
          zeitnachweis: zn, zn: berechneZeitnachweis(zn, state.standort), ergebnis: leeresErgebnis, gespeichert: null,
        };
        neueZeitnachweise++;
      } else {
        let ergebnis;
        try {
          ergebnis = verarbeite(e.bytes, state.standort);
        } catch (_) {
          ergebnis = { ...leeresErgebnis, fehler: 'Unerwarteter Fehler beim Lesen dieser Datei.' };
        }
        datei = { id: naechsteId++, art: 'nachweis', name: e.name, bytes: e.bytes, quelle: e.quelle, schluessel: e.schluessel, ergebnis, gespeichert: null };
        neueNachweise++;
        if (!erste) erste = datei;
      }
      const vorhanden = state.dateien.findIndex((d) => d.schluessel === e.schluessel);
      if (vorhanden >= 0) state.dateien[vorhanden] = datei;
      else state.dateien.push(datei);
      if (i % 4 === 3) await pause();
    }
    state.beschaeftigt = false;
    if (erste) state.auswahl = { id: erste.id, nachweis: 0 };
    // nur eine Art abgelegt: deren Reiter zeigen
    if (neueZeitnachweise && !neueNachweise) state.ansicht = 'stundenkonto';
    if (neueNachweise && !neueZeitnachweise) state.ansicht = 'nachweise';
    renderAlles();
    if (fehler.length) status(fehler.join(' '), true);
    else if (!eingaenge.length) status('Keine PDF- oder Excel-Dateien gefunden.', true);
  }

  function standortSetzen(id) {
    if (state.standort === id) return;
    state.standort = id;
    speicher.set('standort', id);
    for (const d of state.dateien) {
      if (istZeitnachweis(d)) d.zn = berechneZeitnachweis(d.zeitnachweis, id);
      else d.ergebnis = verarbeite(d.bytes, id);
      d.gespeichert = null;
    }
    dokumente.clear();
    renderAlles();
  }

  function offeneDateien() {
    return state.dateien.filter((d) => d.ergebnis.ausgabe && !d.gespeichert);
  }
  const pdfDateien = () => state.dateien.filter((d) => !istZeitnachweis(d));

  async function speichern() {
    const liste = offeneDateien();
    if (!liste.length || state.beschaeftigt) return;
    state.beschaeftigt = true;
    $('btn-speichern').disabled = true;
    status('Wird gespeichert …');
    let r;
    try {
      r = await p.speichern(liste.map((d) => ({ datei: d, name: zielName(d.name), daten: d.ergebnis.ausgabe })));
    } catch (e) {
      r = { gespeichert: [], fehler: [{ text: (e && e.message) || String(e) }] };
    }
    state.beschaeftigt = false;
    if (!r) { renderAlles(); return; } // abgebrochen
    for (const g of r.gespeichert) g.datei.gespeichert = g.ziel || true;
    renderAlles();
    const ok = r.gespeichert.length;
    if (r.fehler.length) {
      status(`${ok ? anzahl(ok, 'Datei', 'Dateien') + ' gespeichert. ' : ''}Nicht gespeichert: ${r.fehler.map((f) => f.text).join('; ')}`, true);
    } else {
      status(r.text || `${anzahl(ok, 'Datei', 'Dateien')} gespeichert.`);
      const letzte = r.gespeichert[r.gespeichert.length - 1];
      state.zuletzt = letzte && typeof letzte.ziel === 'string' ? letzte.ziel : null;
      $('btn-zeigen').hidden = !(p.zeigen && state.zuletzt);
    }
  }

  // ---------------------------------------------------------------- Darstellung
  function renderStandort() {
    const st = standortById(state.standort);
    for (const s of STANDORTE) $('st-' + s.id).setAttribute('aria-checked', String(s.id === st.id));
    $('regel').textContent = st.kurz;
  }

  function aktuell() {
    if (!state.auswahl) return {};
    const d = state.dateien.find((x) => x.id === state.auswahl.id && !istZeitnachweis(x));
    if (!d) return {};
    return { d, n: d.ergebnis.nachweise[state.auswahl.nachweis] || null };
  }

  function statusZeile(n, d) {
    if (!n) return { text: 'Nicht lesbar', fehler: true };
    if (n.status === 'fehler') return { text: 'Nicht eingetragen', fehler: true };
    if (n.status === 'bereitsErgaenzt') return { text: 'Bereits ergänzt' };
    if (d.gespeichert) return { text: 'Gespeichert' };
    return null;
  }

  function renderListe() {
    const liste = $('liste');
    liste.replaceChildren();
    const pdfs = pdfDateien();
    if (!pdfs.length) liste.append(el('div', 'liste-hinweis', 'Keine Leistungsnachweise geladen. Die Zeitnachweise stehen unter „Stundenkonto“.'));
    for (const d of pdfs) {
      const nachweise = d.ergebnis.nachweise.length ? d.ergebnis.nachweise : [null];
      nachweise.forEach((n, i) => {
        const z = el('button', 'zeile');
        z.type = 'button';
        z.setAttribute('role', 'option');
        const sel = state.auswahl && state.auswahl.id === d.id && state.auswahl.nachweis === i;
        z.setAttribute('aria-selected', String(!!sel));
        const links = el('div', 'links');
        links.append(el('div', 'name', (n && n.name) || d.name));
        const info = [n && n.zeitraum, d.name].filter(Boolean).join(' · ');
        const infoEl = el('div', 'info', info);
        infoEl.title = d.quelle && d.quelle.zip ? `${d.quelle.zip} → ${d.name}` : d.name;
        links.append(infoEl);
        const s = statusZeile(n, d);
        if (s) links.append(el('div', 'meldung' + (s.fehler ? ' fehler' : ''), s.text));
        z.append(links);
        // nicht eingetragene (nur berechnete) Werte grau
        const grau = n && n.status === 'fehler' ? ' leise' : '';
        z.append(el('div', 'zahl direkt', n && n.direktText ? n.direktText : '–'));
        z.append(el('div', 'zahl' + grau, n && n.indirektText ? n.indirektText : '–'));
        z.append(el('div', 'zahl gesamt' + grau, n && n.gesamtText ? n.gesamtText : '–'));
        z.addEventListener('click', () => {
          state.auswahl = { id: d.id, nachweis: i };
          renderListe();
          renderDetail();
        });
        liste.append(z);
      });
    }
    renderSpeichern();
  }

  function renderSpeichern() {
    const offen = offeneDateien().length;
    const btn = $('btn-speichern');
    btn.disabled = !offen || state.beschaeftigt;
    const punkte = p.speichernMitDialog ? ' …' : '';
    btn.textContent = (offen > 1 ? `${offen} Dateien speichern` : 'Speichern') + punkte;
  }

  // ---------------------------------------------------------------- Reiter
  function renderReiter(gruppen) {
    const sk = state.ansicht === 'stundenkonto';
    $('tab-nachweise').setAttribute('aria-selected', String(!sk));
    $('tab-stundenkonto').setAttribute('aria-selected', String(sk));
    const zahlNachweise = pdfDateien().reduce((s, d) => s + Math.max(1, d.ergebnis.nachweise.length), 0);
    $('anz-nachweise').textContent = String(zahlNachweise);
    $('anz-stundenkonto').textContent = String(gruppen.length);
    $('liste-bereich').classList.toggle('stundenkonto', sk);
    const kopf = $('liste-kopf');
    kopf.replaceChildren();
    if (sk) kopf.append(el('span', null, 'Mitarbeiter'), el('span', null, 'Indirekt'));
    else kopf.append(el('span', null, 'Klient'), el('span', 'direkt', 'Direkt'), el('span', null, 'Indirekt'), el('span', null, 'Gesamt'));
    $('liste').setAttribute('aria-label', sk ? 'Stundenkonto je Mitarbeiter' : 'Leistungsnachweise');
    $('detail-kopf').hidden = sk;
    $('vorschau').hidden = sk;
    $('ma-detail').hidden = !sk;
  }

  function renderStundenkonto(gruppen) {
    if (!gruppen.some((g) => g.key === state.maAuswahl)) state.maAuswahl = gruppen.length ? gruppen[0].key : null;
    const liste = $('liste');
    liste.replaceChildren();
    if (!gruppen.length) liste.append(el('div', 'liste-hinweis', 'Für keinen Mitarbeiter konnte die indirekte Zeit berechnet werden.'));
    for (const g of gruppen) {
      const z = el('button', 'zeile');
      z.type = 'button';
      z.setAttribute('role', 'option');
      z.setAttribute('aria-selected', String(g.key === state.maAuswahl));
      const links = el('div', 'links');
      links.append(el('div', 'name', g.fachkraft));
      const herkunft = g.quelle === 'zeitnachweis'
        ? (g.zeitnachweise.length > 1 ? `aus ${g.zeitnachweise.length} Zeitnachweisen` : 'aus dem Zeitnachweis')
        : (g.nachweise.length > 1 ? `aus ${g.nachweise.length} Leistungsnachweisen` : 'aus dem Leistungsnachweis');
      links.append(el('div', 'info', `${g.monatText} · ${herkunft}`));
      z.append(links, el('div', 'zahl gesamt', DE.format(g.indirekt)));
      z.addEventListener('click', () => {
        state.maAuswahl = g.key;
        renderStundenkonto(gruppen);
      });
      liste.append(z);
    }

    const box = $('ma-detail');
    box.replaceChildren();
    const g = gruppen.find((x) => x.key === state.maAuswahl);
    if (!g) return;
    const herkunft = g.quelle === 'zeitnachweis'
      ? `Zeitnachweis ${g.zeitnachweise.map((x) => x.zn.zeitraum).join(', ')}`
      : (g.nachweise.length > 1 ? `${g.nachweise.length} Leistungsnachweise` : 'Leistungsnachweis');
    box.append(el('p', 'titel', g.fachkraft), el('p', 'leise', `${g.monatText} · ${herkunft}`));

    box.append(el('p', 'abschnitt', 'In Kilanka als manuelle Buchung eintragen'));
    box.append(el('p', 'leise', 'Mitarbeiter → Konten → Stundenkonto → Plus oben rechts'));
    const tabelle = el('table', 'buchung');
    const zeile = (label, wert, gross) => {
      const tr = el('tr');
      const k = el('button', 'link', 'Kopieren');
      k.type = 'button';
      k.addEventListener('click', () => kopieren(wert, k));
      const td = el('td');
      td.append(k);
      tr.append(el('th', null, label), el('td', gross ? 'wert gross' : 'wert', wert), td);
      tabelle.append(tr);
    };
    zeile('Stichtag', g.stichtag || '');
    zeile('Buchungswert', DE.format(g.indirekt), true);
    zeile('Bemerkung', `Indirekte Zeit ${g.monatText}`);
    box.append(tabelle);

    // So wurde gerechnet
    box.append(el('p', 'abschnitt', 'So berechnet'));
    const rechnung = el('table', 'rechnung');
    const posten = (titel, erklaerung, wert) => {
      const tr = el('tr');
      const td = el('td');
      td.append(el('div', null, titel));
      if (erklaerung) td.append(el('div', 'leise', erklaerung));
      tr.append(td, el('td', 'zahl', wert));
      rechnung.append(tr);
    };
    for (const { d } of g.zeitnachweise || []) {
      for (const k of d.zn.klienten) posten(k.name, k.formel, `${DE.format(k.indirekt)} Std.`);
    }
    for (const { d, n } of g.nachweise) {
      const fehlt = n.status === 'fehler' ? ' · in der PDF nicht eingetragen, hier trotzdem mitgezählt' : '';
      posten(n.name || d.name, `${[n.zeitraum, n.formel].filter(Boolean).join(' · ')}${fehlt}`, `${n.indirektText} Std.`);
    }
    if (g.kappung) {
      posten('Obergrenze für den Mitarbeiter insgesamt', `zusammen ${DE.format(g.kappung.vorher)} Std., höchstens ${DE.format(g.kappung.grenze)} Std. (${g.kappung.text})`, `${DE.format(g.kappung.grenze)} Std.`);
    }
    box.append(rechnung);

    const notizen = [];
    for (const { d, zn } of g.zeitnachweise || []) {
      if (!d.zn.klienten.length) notizen.push(`${d.name}: keine Einträge mit Klient.`);
      if (d.zn.ohneKlient) notizen.push(`${anzahl(d.zn.ohneKlient, 'Eintrag', 'Einträge')} ohne Klient (z. B. Krank, Termine) ${d.zn.ohneKlient === 1 ? 'zählt' : 'zählen'} nicht${g.zeitnachweise.length > 1 ? ` (${d.name}, ${zn.zeitraum})` : ''}.`);
    }
    for (const { d, n, wie } of g.doppelt) {
      notizen.push(d.art === 'zeitnachweis'
        ? `${d.name} ist derselbe Zeitnachweis wie ${wie} und zählt nur einmal.`
        : `${n.name || d.name} in ${d.name} ist derselbe Nachweis wie in ${wie} und zählt nur einmal.`);
    }
    if (g.quelle === 'zeitnachweis') {
      if (g.ersetzt) notizen.push(`Für diesen Monat ${g.ersetzt === 1 ? 'ist auch ein Leistungsnachweis' : `sind auch ${g.ersetzt} Leistungsnachweise`} dieses Mitarbeiters geladen. Gezählt wird nur der Zeitnachweis, damit nichts doppelt gebucht wird.`);
    } else {
      if (g.fachkraft.startsWith('Ohne Angabe')) notizen.push('In diesen Nachweisen steht keine betreuende Fachkraft.');
      notizen.push('Grundlage ist die betreuende Fachkraft im Nachweis. Vertretungen stehen nicht in der PDF.');
    }
    for (const t of notizen) box.append(el('p', 'leise notiz', t));
  }

  function renderDetail() {
    const { d, n } = aktuell();
    const kopf = $('detail-kopf');
    kopf.replaceChildren();
    if (!d) {
      $('vorschau').replaceChildren();
      return;
    }
    kopf.append(el('p', 'titel', (n && n.name) || d.name));
    const meta = [n && n.zeitraum, n && n.fachkraft ? `Fachkraft: ${n.fachkraft}` : null].filter(Boolean);
    kopf.append(el('p', 'leise', meta.length ? meta.join(' · ') : d.name));
    if (n && n.indirektText) {
      kopf.append(el('p', 'werte', `Indirekt ${n.indirektText} Std. · Gesamt ${n.gesamtText} Std.`));
    }
    if (n && n.formel && n.indirektText) kopf.append(el('p', 'leise', `Berechnung: ${n.formel}`));
    if (!n) kopf.append(el('p', 'fehler', d.ergebnis.fehler || 'Kein Leistungsnachweis erkannt.'));
    else if (n.status === 'fehler') kopf.append(el('p', 'fehler', `Nicht in die PDF eingetragen: ${n.fehlertext}`));
    else if (n.status === 'bereitsErgaenzt') kopf.append(el('p', 'leise', 'Diese Datei ist bereits ergänzt – es gibt nichts zu speichern.'));
    if (n) for (const h of n.hinweise) kopf.append(el('p', 'leise', h));
    if (d.ergebnis.fehler && n) kopf.append(el('p', 'fehler', d.ergebnis.fehler));
    if (typeof d.gespeichert === 'string') kopf.append(el('p', 'leise', 'Gespeichert: ' + d.gespeichert));
    renderVorschau(d, n);
  }

  function renderAlles() {
    const leer = state.dateien.length === 0;
    $('leer').hidden = !leer;
    $('arbeit').hidden = leer;
    $('reiter').hidden = leer;
    $('btn-oeffnen').hidden = leer;
    $('btn-leeren').hidden = leer;
    $('btn-speichern').hidden = leer || state.ansicht !== 'nachweise';
    renderStandort();
    let gruppen = [];
    if (!leer) {
      gruppen = mitarbeiterGruppen(state.dateien, state.standort);
      if (!aktuell().d) {
        const erstePdf = pdfDateien()[0];
        state.auswahl = erstePdf ? { id: erstePdf.id, nachweis: 0 } : null;
      }
      renderReiter(gruppen);
      if (state.ansicht === 'stundenkonto') renderStundenkonto(gruppen);
      else {
        renderListe();
        renderDetail();
      }
    }
    renderSpeichern();
    standardStatus(gruppen);
  }

  // ---------------------------------------------------------------- Vorschau (pdf.js)
  let pdfjs = null;
  function pdfjsLaden() {
    if (!pdfjs) {
      pdfjs = (async () => {
        for (const q of p.pdfjsQuellen()) {
          try {
            const lib = await import(/* webpackIgnore: true */ q.lib);
            lib.GlobalWorkerOptions.workerSrc = q.worker;
            return lib;
          } catch (_) { /* naechste Quelle */ }
        }
        throw new Error('pdf.js nicht verfügbar');
      })();
      pdfjs.catch(() => { pdfjs = null; });
    }
    return pdfjs;
  }
  const dokumente = new Map(); // id -> Promise<PDFDocumentProxy>
  function dokument(lib, d) {
    let doc = dokumente.get(d.id);
    if (!doc || doc.ergebnis !== d.ergebnis) {
      const bytes = (d.ergebnis.ausgabe || d.bytes).slice();
      doc = { ergebnis: d.ergebnis, promise: lib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise };
      dokumente.set(d.id, doc);
    }
    return doc.promise;
  }

  let renderToken = 0;
  let letzteBreite = 0;
  async function renderVorschau(d, n) {
    const box = $('vorschau');
    const token = ++renderToken;
    const hinweis = el('div', 'hinweis', 'Vorschau wird geladen …');
    box.replaceChildren(hinweis);
    let lib, doc;
    try {
      lib = await pdfjsLaden();
    } catch (_) {
      if (token === renderToken) hinweis.textContent = 'Vorschau nicht verfügbar.';
      return;
    }
    try {
      doc = await dokument(lib, d);
    } catch (_) {
      if (token === renderToken) hinweis.textContent = 'Diese Datei kann nicht angezeigt werden.';
      return;
    }
    if (token !== renderToken) return;
    const breite = Math.max(260, Math.min(box.clientWidth - 34, 900));
    letzteBreite = box.clientWidth;
    const seiten = [];
    const frag = document.createDocumentFragment();
    for (let nr = 1; nr <= doc.numPages; nr++) {
      const page = await doc.getPage(nr);
      if (token !== renderToken) return;
      const vp = page.getViewport({ scale: breite / page.getViewport({ scale: 1 }).width });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const wrap = el('div', 'seite');
      wrap.style.width = vp.width + 'px';
      wrap.style.height = vp.height + 'px';
      const canvas = el('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      wrap.append(canvas);
      frag.append(wrap);
      seiten.push({ page, vp, canvas, dpr, wrap, index: nr - 1 });
    }
    box.replaceChildren(frag);
    // zur Summe des gewaehlten Nachweises scrollen
    const zielIndex = n && typeof n.seite === 'number' ? n.seite : 0;
    const ziel = seiten.find((s) => s.index === zielIndex) || seiten[0];
    if (ziel) {
      const marke = n ? d.ergebnis.eintragungen.find((e) => e.seite === zielIndex && e.text === n.indirektText) : null;
      const y = marke ? ziel.vp.convertToViewportPoint(0, marke.y)[1] : 0;
      box.scrollTop = Math.max(0, ziel.wrap.offsetTop - 16 + (marke ? y - box.clientHeight * 0.45 : 0));
    }
    const reihenfolge = ziel ? [ziel, ...seiten.filter((s) => s !== ziel)] : seiten;
    for (const s of reihenfolge) {
      if (token !== renderToken) return;
      try {
        await s.page.render({
          canvasContext: s.canvas.getContext('2d'), viewport: s.vp,
          transform: s.dpr !== 1 ? [s.dpr, 0, 0, s.dpr, 0, 0] : undefined,
        }).promise;
      } catch (_) { /* Seite auslassen */ }
    }
  }

  // ---------------------------------------------------------------- Bedienung
  $('version').textContent = p.versionText || '';
  for (const s of STANDORTE) $('st-' + s.id).addEventListener('click', () => standortSetzen(s.id));
  $('standort').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = STANDORTE.findIndex((s) => s.id === state.standort);
    const n = STANDORTE[(i + (e.key === 'ArrowRight' ? 1 : STANDORTE.length - 1)) % STANDORTE.length];
    standortSetzen(n.id);
    $('st-' + n.id).focus();
  });
  const oeffnen = () => hinzufuegen(() => p.oeffnen());
  $('btn-oeffnen').addEventListener('click', oeffnen);
  $('btn-oeffnen-leer').addEventListener('click', oeffnen);
  const ansichtSetzen = (a) => {
    if (state.ansicht === a) return;
    state.ansicht = a;
    renderAlles();
  };
  $('tab-nachweise').addEventListener('click', () => ansichtSetzen('nachweise'));
  $('tab-stundenkonto').addEventListener('click', () => ansichtSetzen('stundenkonto'));
  $('reiter').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const a = state.ansicht === 'nachweise' ? 'stundenkonto' : 'nachweise';
    ansichtSetzen(a);
    $(a === 'nachweise' ? 'tab-nachweise' : 'tab-stundenkonto').focus();
  });
  $('btn-speichern').addEventListener('click', speichern);
  $('btn-leeren').addEventListener('click', () => {
    state.dateien = [];
    state.auswahl = null;
    dokumente.clear();
    renderAlles();
  });
  $('btn-zeigen').addEventListener('click', () => { if (state.zuletzt && p.zeigen) p.zeigen(state.zuletzt); });

  p.ziehenEinrichten({
    hinein: () => document.body.classList.add('ziehen'),
    hinaus: () => document.body.classList.remove('ziehen'),
    ablegen: (laden) => {
      document.body.classList.remove('ziehen');
      hinzufuegen(laden);
    },
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); oeffnen(); }
    if (k === 's') { e.preventDefault(); if (state.ansicht === 'nachweise') speichern(); }
  });

  if (window.ResizeObserver) {
    let t;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        const w = $('vorschau').clientWidth;
        if (w && Math.abs(w - letzteBreite) > 40 && !$('arbeit').hidden) {
          const { d, n } = aktuell();
          if (d) renderVorschau(d, n);
        }
      }, 250);
    }).observe($('vorschau'));
  }

  // Updates (nur Desktop)
  if (p.updatesEinrichten) {
    p.updatesEinrichten({
      anzeigen(text) {
        $('update-text').textContent = text;
        $('btn-update').hidden = false;
        $('btn-update').disabled = false;
        $('update').hidden = false;
      },
      fortschritt(text) {
        $('update-text').textContent = text;
        $('btn-update').hidden = true;
        $('update').hidden = false;
      },
      fehler(text) {
        $('update-text').textContent = text;
        $('btn-update').hidden = false;
        $('btn-update').disabled = false;
      },
      ungespeichert: () => offeneDateien().length,
      knopf: $('btn-update'),
    });
  }

  renderAlles();
  return { hinzufuegen, state };
}
