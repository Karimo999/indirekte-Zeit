// Oberflaeche von „Indirekte Zeit“ – gemeinsam fuer die Desktop-App und die Testversion im Browser.
// Plattformabhaengiges (Dateien oeffnen/speichern, Updates) kommt ueber das Objekt `p`.
import { unzipSync } from 'fflate';
import { verarbeite, STANDORTE, standortById } from '../engine/nachweis.js';

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

/** Dateiname ohne Endung + Suffix */
export function zielName(name) {
  return name.replace(/\.pdf$/i, '') + SUFFIX + '.pdf';
}
export const istErgaenzt = (name) => /_ergaenzt\.pdf$/i.test(name);

/**
 * Wandelt gelesene Dateien in Eingaenge um. ZIP-Dateien werden entpackt.
 * @param {{name:string, bytes:Uint8Array, quelle:object, schluessel:string}[]} dateien
 */
export function entpacken(dateien) {
  const eingaenge = [];
  const fehler = [];
  for (const d of dateien) {
    if (/\.zip$/i.test(d.name)) {
      let inhalt;
      try {
        inhalt = unzipSync(d.bytes, { filter: (x) => /\.pdf$/i.test(x.name) && !x.name.startsWith('__MACOSX') });
      } catch (_) {
        fehler.push(`${d.name} konnte nicht entpackt werden.`);
        continue;
      }
      const namen = Object.keys(inhalt).sort((a, b) => a.localeCompare(b, 'de'));
      if (!namen.length) fehler.push(`In ${d.name} ist keine PDF-Datei.`);
      for (const n of namen) {
        const name = n.split('/').pop();
        if (istErgaenzt(name)) continue;
        eingaenge.push({ name, bytes: inhalt[n], quelle: { ...d.quelle, zip: d.name, eintrag: n }, schluessel: d.schluessel + '#' + n });
      }
    } else if (/\.pdf$/i.test(d.name)) {
      eingaenge.push(d);
    } else {
      fehler.push(`${d.name} ist keine PDF- oder ZIP-Datei.`);
    }
  }
  return { eingaenge, fehler };
}

export function starte(p) {
  const state = {
    standort: standortById(speicher.get('standort') || 'segeberg').id,
    dateien: [],
    auswahl: null, // { id, nachweis }
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
  function standardStatus() {
    $('btn-zeigen').hidden = true;
    const alle = state.dateien.flatMap((d) => (d.ergebnis.nachweise.length ? d.ergebnis.nachweise : [null]));
    if (!alle.length) return status('');
    const fehler = alle.filter((n) => !n || n.status === 'fehler').length;
    const teile = [anzahl(alle.length, 'Nachweis', 'Nachweise')];
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
    for (let i = 0; i < eingaenge.length; i++) {
      const e = eingaenge[i];
      if (eingaenge.length > 3) status(`Wird gelesen … ${i + 1} von ${eingaenge.length}`);
      let ergebnis;
      try {
        ergebnis = verarbeite(e.bytes, state.standort);
      } catch (_) {
        ergebnis = { nachweise: [], ausgabe: null, fehler: 'Unerwarteter Fehler beim Lesen dieser Datei.', eintragungen: [] };
      }
      const datei = { id: naechsteId++, name: e.name, bytes: e.bytes, quelle: e.quelle, schluessel: e.schluessel, ergebnis, gespeichert: null };
      const vorhanden = state.dateien.findIndex((d) => d.schluessel === e.schluessel);
      if (vorhanden >= 0) state.dateien[vorhanden] = datei;
      else state.dateien.push(datei);
      if (!erste) erste = datei;
      if (i % 4 === 3) await pause();
    }
    state.beschaeftigt = false;
    if (erste) state.auswahl = { id: erste.id, nachweis: 0 };
    renderAlles();
    if (fehler.length) status(fehler.join(' '), true);
    else if (!eingaenge.length) status('Keine PDF-Dateien gefunden.', true);
  }

  function standortSetzen(id) {
    if (state.standort === id) return;
    state.standort = id;
    speicher.set('standort', id);
    for (const d of state.dateien) {
      d.ergebnis = verarbeite(d.bytes, id);
      d.gespeichert = null;
    }
    dokumente.clear();
    renderAlles();
  }

  function offeneDateien() {
    return state.dateien.filter((d) => d.ergebnis.ausgabe && !d.gespeichert);
  }

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
    const d = state.dateien.find((x) => x.id === state.auswahl.id);
    if (!d) return {};
    return { d, n: d.ergebnis.nachweise[state.auswahl.nachweis] || null };
  }

  function statusZeile(n, d) {
    if (!n) return { text: d.ergebnis.fehler || 'Kein Leistungsnachweis erkannt.', fehler: true };
    if (n.status === 'fehler') return { text: n.fehlertext, fehler: true };
    if (n.status === 'bereitsErgaenzt') return { text: 'Bereits ergänzt' };
    if (d.gespeichert) return { text: 'Gespeichert' };
    return null;
  }

  function renderListe() {
    const liste = $('liste');
    liste.replaceChildren();
    for (const d of state.dateien) {
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
        z.append(el('div', 'zahl', n && n.direktText ? n.direktText : '–'));
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
    const offen = offeneDateien().length;
    const btn = $('btn-speichern');
    btn.disabled = !offen || state.beschaeftigt;
    btn.textContent = offen > 1 ? `${offen} Dateien speichern` : 'Speichern';
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
    const quelle = d.quelle && d.quelle.zip ? `${d.quelle.zip} → ${d.name}` : d.name;
    kopf.append(el('p', 'leise', [n && n.zeitraum, quelle].filter(Boolean).join(' · ')));
    if (n && n.formel && n.indirektText) {
      kopf.append(el('p', null, `Indirekt: ${n.formel} = ${n.indirektText} Std. · Gesamt: ${n.gesamtText} Std.`));
    }
    if (!n) kopf.append(el('p', 'fehler', d.ergebnis.fehler || 'Kein Leistungsnachweis erkannt.'));
    else if (n.status === 'fehler') kopf.append(el('p', 'fehler', 'Nicht eingetragen: ' + n.fehlertext));
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
    $('btn-leeren').hidden = leer;
    renderStandort();
    if (!leer) {
      if (!aktuell().d) state.auswahl = { id: state.dateien[0].id, nachweis: 0 };
      renderListe();
      renderDetail();
    } else {
      $('btn-speichern').disabled = true;
      $('btn-speichern').textContent = 'Speichern';
    }
    standardStatus();
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
    if (k === 's') { e.preventDefault(); speichern(); }
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
