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

/// PDF oder ZIP, aber keine bereits ergaenzte Datei und keine versteckten Dateien (z. B. „._“ vom Mac)
fn ist_kandidat(p: &Path) -> bool {
    match kleingeschrieben_name(p) {
        Some(n) => !n.starts_with('.') && ((n.ends_with(".pdf") && !n.ends_with("_ergaenzt.pdf")) || n.ends_with(".zip")),
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
    if ziel == original {
        return Err("das Original darf nicht überschrieben werden".into());
    }
    if let Some(p) = ziel.parent() {
        fs::create_dir_all(p).map_err(|e| fehlertext(&e))?;
    }
    // zuerst in eine Zwischendatei schreiben, dann umbenennen: nie eine halbe Datei am Ziel
    let mut tmp = ziel.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, &daten).map_err(|e| fehlertext(&e))?;
    if let Err(e) = fs::rename(&tmp, &ziel) {
        let _ = fs::remove_file(&tmp);
        return Err(fehlertext(&e));
    }
    Ok(ziel.to_string_lossy().into_owned())
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
        .invoke_handler(tauri::generate_handler![dateien_sammeln, datei_lesen, schreiben, im_ordner_zeigen])
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
    fn kandidaten() {
        assert!(ist_kandidat(Path::new("/a/B.PDF")));
        assert!(ist_kandidat(Path::new("/a/export.zip")));
        assert!(!ist_kandidat(Path::new("/a/b_ergaenzt.pdf")));
        assert!(!ist_kandidat(Path::new("/a/._b.pdf")));
        assert!(!ist_kandidat(Path::new("/a/b.docx")));
    }
}
