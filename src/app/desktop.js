// Desktop-App (Tauri, Mac und Windows): Dateien lesen/schreiben ueber Rust-Befehle, Updates ueber GitHub Releases.
import { starte } from './ui.js';

const T = window.__TAURI__;
const invoke = T.core.invoke;
const dialog = T.dialog;

const dateiname = (pfad) => pfad.split(/[\\/]/).pop();

function alsBytes(r) {
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (ArrayBuffer.isView(r)) return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
  if (Array.isArray(r)) return Uint8Array.from(r);
  throw new Error('Unerwartete Antwort beim Lesen');
}

/** Pfade (Dateien oder Ordner) einlesen */
async function lesen(pfade) {
  if (!pfade || !pfade.length) return null;
  const dateien = [];
  const fehler = [];
  let liste;
  try {
    liste = await invoke('dateien_sammeln', { pfade });
  } catch (e) {
    return { dateien: [], fehler: [String(e)] };
  }
  for (const pfad of liste) {
    const name = dateiname(pfad);
    if (!/\.(pdf|zip)$/i.test(name)) {
      fehler.push(`${name} ist keine PDF- oder ZIP-Datei.`);
      continue;
    }
    try {
      const bytes = alsBytes(await invoke('datei_lesen', { pfad }));
      dateien.push({ name, bytes, quelle: { pfad }, schluessel: pfad });
    } catch (e) {
      fehler.push(`${name} konnte nicht gelesen werden.`);
    }
  }
  if (!liste.length && !fehler.length) fehler.push('Keine PDF- oder ZIP-Dateien gefunden.');
  return { dateien, fehler };
}

const ordnerVon = (pfad) => {
  const i = Math.max(pfad.lastIndexOf('/'), pfad.lastIndexOf('\\'));
  return i > 0 ? pfad.slice(0, i) : pfad;
};
const verbinden = (ordner, name) => ordner + (ordner.includes('\\') && !ordner.includes('/') ? '\\' : '/') + name;

// zuletzt gewaehlter Speicherort (Dialog startet dort)
const SPEICHERORT = 'speicherort';
const letzterOrdner = () => { try { return localStorage.getItem(SPEICHERORT); } catch (_) { return null; } };
const merkeOrdner = (o) => { try { localStorage.setItem(SPEICHERORT, o); } catch (_) { /* egal */ } };

/** gleiche Namen in einem Speichervorgang unterscheiden: Datei_ergaenzt.pdf, Datei_ergaenzt (2).pdf … */
function eindeutig(namen) {
  const zaehler = new Map();
  return namen.map((n) => {
    const k = n.toLowerCase();
    const z = (zaehler.get(k) || 0) + 1;
    zaehler.set(k, z);
    return z === 1 ? n : n.replace(/\.pdf$/i, ` (${z}).pdf`);
  });
}

/** Speichern: eine Datei ueber „Speichern unter“, mehrere in einen gewaehlten Ordner */
async function speichern(liste) {
  const start = letzterOrdner() || ordnerVon(liste[0].datei.quelle.pfad);
  if (liste.length === 1) {
    const e = liste[0];
    const ziel = await dialog.save({
      title: 'Ergänzte Datei speichern',
      defaultPath: verbinden(start, e.name),
      filters: [{ name: 'PDF-Dokument', extensions: ['pdf'] }],
    });
    if (!ziel) return null;
    try {
      const pfad = await invoke('schreiben_als', { ziel, original: e.datei.quelle.pfad, daten: Array.from(e.daten) });
      merkeOrdner(ordnerVon(pfad));
      return { gespeichert: [{ datei: e.datei, ziel: pfad }], fehler: [], text: `Gespeichert als ${dateiname(pfad)}` };
    } catch (err) {
      return { gespeichert: [], fehler: [{ datei: e.datei, text: `${e.name} (${err})` }] };
    }
  }

  const ordner = await dialog.open({
    directory: true,
    title: `Ordner für ${liste.length} ergänzte Dateien wählen`,
    defaultPath: start,
  });
  if (!ordner) return null;
  const namen = eindeutig(liste.map((e) => e.name));
  let vorhanden = [];
  try { vorhanden = await invoke('vorhandene_dateien', { ordner, namen }); } catch (_) { vorhanden = []; }
  if (vorhanden.length) {
    const frage = vorhanden.length === 1
      ? `„${vorhanden[0]}“ gibt es in diesem Ordner schon. Ersetzen?`
      : `${vorhanden.length} der Dateien gibt es in diesem Ordner schon. Ersetzen?`;
    const ok = await dialog.ask(frage, { title: 'Indirekte Zeit', kind: 'warning', okLabel: 'Ersetzen', cancelLabel: 'Abbrechen' });
    if (!ok) return null;
  }
  const gespeichert = [];
  const fehler = [];
  for (let i = 0; i < liste.length; i++) {
    const e = liste[i];
    try {
      const ziel = await invoke('schreiben', { original: e.datei.quelle.pfad, relativ: namen[i], ordner, daten: Array.from(e.daten) });
      gespeichert.push({ datei: e.datei, ziel });
    } catch (err) {
      fehler.push({ datei: e.datei, text: `${namen[i]} (${err})` });
    }
  }
  if (gespeichert.length) merkeOrdner(ordner);
  return { gespeichert, fehler, text: `${gespeichert.length} Dateien gespeichert in ${dateiname(ordner) || ordner}` };
}

async function main() {
  let version = '';
  try { version = await T.app.getVersion(); } catch (_) { /* egal */ }

  starte({
    versionText: version ? `Version ${version}` : '',
    pdfjsQuellen: () => [{
      lib: new URL('vendor/pdf.min.mjs', document.baseURI).href,
      worker: new URL('vendor/pdf.worker.min.mjs', document.baseURI).href,
    }],
    async oeffnen() {
      const auswahl = await dialog.open({
        multiple: true,
        title: 'Leistungsnachweise öffnen',
        filters: [{ name: 'PDF oder ZIP', extensions: ['pdf', 'PDF', 'zip', 'ZIP'] }],
      });
      if (!auswahl) return null;
      return lesen(Array.isArray(auswahl) ? auswahl : [auswahl]);
    },
    ziehenEinrichten(cb) {
      T.webview.getCurrentWebview().onDragDropEvent((event) => {
        const typ = event.payload.type;
        if (typ === 'enter' || typ === 'over') cb.hinein();
        else if (typ === 'leave') cb.hinaus();
        else if (typ === 'drop') cb.ablegen(() => lesen(event.payload.paths));
      });
      // Browser-Verhalten (Datei im Fenster oeffnen) unterbinden
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => e.preventDefault());
    },
    speichern,
    speichernMitDialog: true,
    zeigen: (pfad) => invoke('im_ordner_zeigen', { pfad }).catch(() => {}),
    updatesEinrichten(ui) {
      let update = null;
      let laeuft = false;
      const pruefen = async () => {
        if (laeuft) return;
        try {
          const u = await T.updater.check();
          if (u && !laeuft) {
            update = u;
            ui.anzeigen(`Version ${u.version} ist verfügbar.`);
          }
        } catch (_) { /* offline oder Server nicht erreichbar */ }
      };
      ui.knopf.addEventListener('click', async () => {
        if (!update || laeuft) return;
        const offen = ui.ungespeichert();
        if (offen) {
          const ok = await dialog.ask(
            `${offen === 1 ? 'Eine ergänzte Datei ist' : `${offen} ergänzte Dateien sind`} noch nicht gespeichert. Trotzdem jetzt aktualisieren?`,
            { title: 'Indirekte Zeit', kind: 'warning', okLabel: 'Aktualisieren', cancelLabel: 'Abbrechen' },
          );
          if (!ok) return;
        }
        laeuft = true;
        let gesamt = 0;
        let geladen = 0;
        ui.fortschritt('Update wird geladen …');
        try {
          await update.downloadAndInstall((ev) => {
            if (ev.event === 'Started') gesamt = ev.data.contentLength || 0;
            else if (ev.event === 'Progress') {
              geladen += ev.data.chunkLength || 0;
              if (gesamt) ui.fortschritt(`Update wird geladen … ${Math.min(100, Math.round((geladen * 100) / gesamt))} %`);
            } else if (ev.event === 'Finished') ui.fortschritt('Update wird installiert …');
          });
          ui.fortschritt('Wird neu gestartet …');
          await T.process.relaunch();
        } catch (_) {
          laeuft = false;
          ui.fehler('Das Update konnte nicht installiert werden. Bitte später erneut versuchen.');
        }
      });
      setTimeout(pruefen, 2000);
      setInterval(pruefen, 3 * 60 * 60 * 1000);
    },
  });
}

main();
