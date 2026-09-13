//! The handful of strings Rust owns: the tray menu, the tray tooltip and the toasts. Everything
//! else the user reads is in the web UI, which has its own table.

use crate::settings::Language;

fn pick(language: Language, en: &'static str, es: &'static str) -> &'static str {
    match language {
        Language::En => en,
        Language::Es => es,
    }
}

pub fn tray_save_clip(l: Language) -> &'static str {
    pick(l, "Save clip", "Guardar clip")
}

pub fn tray_open(l: Language) -> &'static str {
    pick(l, "Open", "Abrir")
}

pub fn tray_quit(l: Language) -> &'static str {
    pick(l, "Quit", "Salir")
}

pub fn tray_idle(l: Language) -> String {
    pick(l, "Cos Nostra – idle", "Cos Nostra – inactivo").to_string()
}

pub fn tray_recording(l: Language, game: &str) -> String {
    format!("{} {game}", pick(l, "Cos Nostra – recording", "Cos Nostra – grabando"))
}

pub fn clip_saved(l: Language) -> &'static str {
    pick(l, "Clip saved", "Clip guardado")
}

pub fn clip_not_saved(l: Language) -> &'static str {
    pick(l, "Clip not saved", "No se pudo guardar el clip")
}

pub fn clip_uploaded(l: Language) -> &'static str {
    pick(l, "Clip uploaded", "Clip subido")
}

pub fn clip_updated(l: Language) -> &'static str {
    pick(l, "Clip updated", "Clip actualizado")
}

pub fn tray_hint_title(l: Language) -> &'static str {
    pick(l, "Still recording in the tray", "Sigue grabando en la bandeja")
}

pub fn tray_hint_body(l: Language) -> &'static str {
    pick(
        l,
        "Cos Nostra keeps running. Quit it from the tray icon.",
        "Cos Nostra sigue funcionando. Ciérralo desde el icono de la bandeja.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_string_has_both_languages() {
        for (en, es) in [
            (tray_save_clip(Language::En), tray_save_clip(Language::Es)),
            (tray_open(Language::En), tray_open(Language::Es)),
            (tray_quit(Language::En), tray_quit(Language::Es)),
            (clip_saved(Language::En), clip_saved(Language::Es)),
            (clip_not_saved(Language::En), clip_not_saved(Language::Es)),
            (clip_uploaded(Language::En), clip_uploaded(Language::Es)),
            (clip_updated(Language::En), clip_updated(Language::Es)),
            (tray_hint_title(Language::En), tray_hint_title(Language::Es)),
            (tray_hint_body(Language::En), tray_hint_body(Language::Es)),
        ] {
            assert!(!en.is_empty());
            assert!(!es.is_empty());
            assert_ne!(en, es, "{en} was never translated");
        }
        assert_ne!(tray_idle(Language::En), tray_idle(Language::Es));
        assert!(tray_recording(Language::Es, "Valorant").ends_with("Valorant"));
    }
}
