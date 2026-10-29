// Indirekte Zeit – Desktop-Rahmen (Tauri).
// Die eigentliche Arbeit (PDF lesen, rechnen, eintragen) macht die Oberflaeche in JavaScript.
// Hier stehen nur die Dateizugriffe: Dateien sammeln, lesen und die ergaenzte Fassung neben das Original schreiben.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// Wie tief Ordner beim Ablegen durchsucht werden
const MAX_TIEFE: usize = 8;
/// Groesste Datei, die gelesen wird (Leistungsnachweise sind wenige hundert KB)
const MAX_GROESSE: u64 = 300 * 1024 * 1024;

fn fehlertext(e: &std::io::Error) -> String {
    match e.kind() {
        ErrorKind::PermissionDenied => "keine Schreibberechtigung oder Datei ist in einem anderen Programm geöffnet".into(),
        ErrorKind::NotFound => "nicht gefunden".into(),
        _ => e.to_string(),
    }
}

fn kleingeschrieben_name(p: &Path) -> Option<String> {
    p.file_name().and_then(|n| n.to_str()).map(|n| n.to_lowercase())
}

/// PDF, Excel oder ZIP, aber keine bereits ergaenzte Datei, keine versteckten Dateien (z. B. „._“ vom Mac)
/// und keine Sperrdateien von Excel („~$…“)
fn ist_kandidat(p: &Path) -> bool {
    match kleingeschrieben_name(p) {
        Some(n) => {
            !n.starts_with('.')
                && !n.starts_with("~$")
                && ((n.ends_with(".pdf") && !n.ends_with("_ergaenzt.pdf")) || n.ends_with(".zip") || n.ends_with(".xlsx"))
        }
        None => false,
    }
}

fn sammeln(p: &Path, tiefe: usize, out: &mut Vec<PathBuf>) {
    if p.is_dir() {
        if tiefe >= MAX_TIEFE {
            return;
        }
        let mut eintraege: Vec<PathBuf> = match fs::read_dir(p) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => return,
        };
        eintraege.sort();
        for e in eintraege {
            sammeln(&e, tiefe + 1, out);
        }
    } else if ist_kandidat(p) {
        out.push(p.to_path_buf());
    }
}

/// Ersetzt Ordner durch die darin enthaltenen PDF- und ZIP-Dateien. Einzelne Dateien bleiben, wie sie sind.
#[tauri::command]
fn dateien_sammeln(pfade: Vec<String>) -> Vec<String> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in pfade {
        let pfad = PathBuf::from(p);
        if pfad.is_dir() {
            sammeln(&pfad, 0, &mut out);
        } else {
            out.push(pfad);
        }
    }
    let mut gesehen = std::collections::HashSet::new();
    out.retain(|p| gesehen.insert(p.clone()));
    out.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Liest eine Datei (als Bytes an die Oberflaeche)
#[tauri::command]
fn datei_lesen(pfad: String) -> Result<tauri::ipc::Response, String> {
    let meta = fs::metadata(&pfad).map_err(|e| fehlertext(&e))?;
    if meta.len() > MAX_GROESSE {
        return Err("Datei ist zu groß".into());
    }
    fs::read(&pfad).map(tauri::ipc::Response::new).map_err(|e| fehlertext(&e))
}

/// Zielpfad aus Basisordner und relativem Pfad („Datei_ergaenzt.pdf“ oder „Export_ergaenzt/Datei_ergaenzt.pdf“)
fn zielpfad(basis: &Path, relativ: &str) -> Result<PathBuf, String> {
    let mut ziel = basis.to_path_buf();
    for teil in relativ.split('/') {
        let mut c = Path::new(teil).components();
        match (c.next(), c.next()) {
            (Some(Component::Normal(_)), None) => ziel.push(teil),
            _ => return Err("ungültiger Dateiname".into()),
        }
    }
    match kleingeschrieben_name(&ziel) {
        Some(n) if n.ends_with(".pdf") => Ok(ziel),
        _ => Err("ungültiger Dateiname".into()),
    }
}

/// Schreibt die ergaenzte PDF neben das Original (oder in den gewaehlten Ordner). Das Original wird nie ueberschrieben.
#[tauri::command]
fn schreiben(original: String, relativ: String, ordner: Option<String>, daten: Vec<u8>) -> Result<String, String> {
    if !daten.starts_with(b"%PDF") {
        return Err("keine PDF-Daten".into());
    }
    let original = PathBuf::from(original);
    let basis = match ordner {
        Some(o) => PathBuf::from(o),
        None => original.parent().map(Path::to_path_buf).ok_or("Ordner des Originals unbekannt")?,
    };
    let ziel = zielpfad(&basis, &relativ)?;
    if gleiche_datei(&original, &ziel) {
        return Err("das Original kann nicht überschrieben werden".into());
    }
    atomar_schreiben(&ziel, &daten)?;
    Ok(ziel.to_string_lossy().into_owned())
}

/// Schreibt die ergaenzte PDF an den im Speichern-Dialog gewaehlten Ort. Das Original wird nie ueberschrieben.
#[tauri::command]
fn schreiben_als(ziel: String, original: Option<String>, daten: Vec<u8>) -> Result<String, String> {
    if !daten.starts_with(b"%PDF") {
        return Err("keine PDF-Daten".into());
    }
    let mut ziel = PathBuf::from(ziel);
    if !matches!(kleingeschrieben_name(&ziel), Some(n) if n.ends_with(".pdf")) {
        let mut s = ziel.into_os_string();
        s.push(".pdf");
        ziel = PathBuf::from(s);
    }
    if let Some(o) = original {
        if gleiche_datei(Path::new(&o), &ziel) {
            return Err("das Original kann nicht überschrieben werden – bitte einen anderen Namen wählen".into());
        }
    }
    atomar_schreiben(&ziel, &daten)?;
    Ok(ziel.to_string_lossy().into_owned())
}

/// Welche dieser Dateinamen gibt es im Ordner schon?
#[tauri::command]
fn vorhandene_dateien(ordner: String, namen: Vec<String>) -> Vec<String> {
    let basis = PathBuf::from(ordner);
    namen.into_iter().filter(|n| basis.join(n).exists()).collect()
}

fn gleiche_datei(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// zuerst in eine Zwischendatei schreiben, dann umbenennen: nie eine halbe Datei am Ziel
fn atomar_schreiben(ziel: &Path, daten: &[u8]) -> Result<(), String> {
    if let Some(p) = ziel.parent() {
        fs::create_dir_all(p).map_err(|e| fehlertext(&e))?;
    }
    let mut tmp = ziel.to_path_buf().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, daten).map_err(|e| fehlertext(&e))?;
    if let Err(e) = fs::rename(&tmp, ziel) {
        let _ = fs::remove_file(&tmp);
        return Err(fehlertext(&e));
    }
    Ok(())
}

/// Zeigt die Datei im Finder bzw. Explorer
#[tauri::command]
fn im_ordner_zeigen(pfad: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&pfad).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            dateien_sammeln,
            datei_lesen,
            schreiben,
            schreiben_als,
            vorhandene_dateien,
            im_ordner_zeigen
        ])
        .run(tauri::generate_context!())
        .expect("Indirekte Zeit konnte nicht gestartet werden");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zielpfad_prueft_namen() {
        let b = Path::new("/tmp/x");
        assert!(zielpfad(b, "a_ergaenzt.pdf").is_ok());
        assert!(zielpfad(b, "Export_ergaenzt/a_ergaenzt.pdf").is_ok());
        assert!(zielpfad(b, "../a.pdf").is_err());
        assert!(zielpfad(b, "/etc/a.pdf").is_err());
        assert!(zielpfad(b, "a.exe").is_err());
        assert!(zielpfad(b, "").is_err());
    }

    #[test]
    fn schreiben_als_schuetzt_original_und_ergaenzt_endung() {
        let dir = std::env::temp_dir().join(format!("iz-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join("Nachweis.pdf");
        fs::write(&original, b"%PDF-original").unwrap();
        let o = Some(original.to_string_lossy().into_owned());
        // Original als Ziel wird abgelehnt und bleibt unveraendert
        assert!(schreiben_als(original.to_string_lossy().into_owned(), o.clone(), b"%PDF-neu".to_vec()).is_err());
        assert_eq!(fs::read(&original).unwrap(), b"%PDF-original");
        // fehlende Endung wird ergaenzt
        let ziel = schreiben_als(dir.join("Ergebnis").to_string_lossy().into_owned(), o.clone(), b"%PDF-neu".to_vec()).unwrap();
        assert!(ziel.ends_with("Ergebnis.pdf"));
        assert_eq!(fs::read(&ziel).unwrap(), b"%PDF-neu");
        // keine PDF-Daten
        assert!(schreiben_als(dir.join("x.pdf").to_string_lossy().into_owned(), o, b"kein pdf".to_vec()).is_err());
        // vorhandene Dateien
        let v = vorhandene_dateien(dir.to_string_lossy().into_owned(), vec!["Ergebnis.pdf".into(), "fehlt.pdf".into()]);
        assert_eq!(v, vec!["Ergebnis.pdf".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kandidaten() {
        assert!(ist_kandidat(Path::new("/a/B.PDF")));
        assert!(ist_kandidat(Path::new("/a/export.zip")));
        assert!(!ist_kandidat(Path::new("/a/b_ergaenzt.pdf")));
        assert!(!ist_kandidat(Path::new("/a/._b.pdf")));
        assert!(!ist_kandidat(Path::new("/a/b.docx")));
        assert!(ist_kandidat(Path::new("/a/Zeitnachweis_Mai.xlsx")));
        assert!(!ist_kandidat(Path::new("/a/~$Zeitnachweis_Mai.xlsx")));
    }
}
