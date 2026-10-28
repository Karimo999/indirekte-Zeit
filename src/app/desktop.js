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

/** Relativer Zielpfad neben dem Original: Datei_ergaenzt.pdf bzw. Export_ergaenzt/Datei_ergaenzt.pdf bei ZIP */
function relativerZiel(eintrag) {
  const q = eintrag.datei.quelle;
  if (q.zip) return q.zip.replace(/\.zip$/i, '') + '_ergaenzt/' + eintrag.name;
  return eintrag.name;
}

async function schreiben(eintrag, ordner) {
  return invoke('schreiben', {
    original: eintrag.datei.quelle.pfad,
    relativ: relativerZiel(eintrag),
    ordner: ordner || null,
    daten: Array.from(eintrag.daten),
  });
}

async function speichern(liste) {
  const gespeichert = [];
  let offen = [];
  let letzterFehler = '';
  for (const e of liste) {
    try {
      gespeichert.push({ datei: e.datei, ziel: await schreiben(e, null) });
    } catch (err) {
      letzterFehler = String(err);
      offen.push(e);
    }
  }
  // Ordner nicht beschreibbar: anderen Ordner waehlen lassen
  if (offen.length) {
    const ordner = await dialog.open({
      directory: true,
      title: `Neben dem Original kann nicht gespeichert werden – Ordner wählen (${offen.length} ${offen.length === 1 ? 'Datei' : 'Dateien'})`,
    });
    if (ordner) {
      const nochOffen = [];
      for (const e of offen) {
        try {
          gespeichert.push({ datei: e.datei, ziel: await schreiben(e, ordner) });
        } catch (err) {
          letzterFehler = String(err);
          nochOffen.push(e);
        }
      }
      offen = nochOffen;
    }
  }
  const fehler = offen.map((e) => ({ datei: e.datei, text: `${e.name} (${letzterFehler})` }));
  const text = gespeichert.length === 1
    ? `Gespeichert als ${dateiname(gespeichert[0].ziel)}`
    : `${gespeichert.length} Dateien gespeichert`;
  return { gespeichert, fehler, text };
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
