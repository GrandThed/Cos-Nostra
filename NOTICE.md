# Third-party notices

The desktop app (apps/desktop) links the following GPL-licensed software. Their source is
available at the linked repositories; this project is licensed under GPL-3.0 to comply.

- OBS Studio / libobs, GPL-2.0-or-later. https://github.com/obsproject/obs-studio
  The OBS runtime binaries (including the signed game capture hooks) are downloaded at first
  launch from https://github.com/libobs-rs/libobs-builds and are not modified.
- libobs-rs (libobs, libobs-wrapper, libobs-simple, libobs-bootstrapper), GPL-3.0.
  https://github.com/libobs-rs/libobs-rs
- FFmpeg, as bundled inside the OBS runtime, LGPL-2.1-or-later / GPL-2.0-or-later.
  https://ffmpeg.org

Rust and JavaScript dependencies carry their own permissive licenses; see the lockfiles.
