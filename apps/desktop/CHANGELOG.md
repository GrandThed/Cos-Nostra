# Changelog

Each release's section becomes its GitHub release notes (`.github/workflows/desktop-release.yml`
reads the `## vX.Y.Z` heading that matches the tag), so the newest version goes on top.

## v0.3.0 — 2026-09-15

### Audio y micrófono

- **Graba tu micrófono**, en Ajustes → Audio: eliges el micrófono, el volumen y la supresión de
  ruido. Va en una pista aparte, así que al publicar o exportar un clip puedes **dejar tu voz
  fuera** con la casilla "Incluir mi micrófono".
- **Elige qué sonido se graba**: todo lo que oyes (como hasta ahora), solo el juego (Discord y la
  música quedan fuera), o el juego y las apps que elijas (por ejemplo Discord.exe).

### Marcar momentos

- **Atajo para marcar un momento** (`Alt+F11`, se puede cambiar o desactivar): deja una marca en
  la línea de tiempo del juego que se está grabando, con un sonido distinto al de guardar un clip.
  En Partidas, el ✂ de la marca selecciona los 25 segundos anteriores.

### Grabación en segundo plano

- **Grabar también cualquier otro juego** (desactivado por defecto, en Ajustes → Comportamiento):
  cualquier juego que se capture queda grabado en partes de 15 minutos, para sacar clips después
  aunque no pulsaras el atajo. Solo se guardan las horas más recientes (2 por defecto, hasta 48);
  las partes más antiguas se borran solas. Si abres Valorant, League o Counter-Strike, su grabación
  normal toma el relevo.

### Exportar

- **Botón Exportar…** en cada clip: guarda un MP4 donde quieras, **tal cual** (sin perder calidad),
  **que ocupe como mucho** 10, 50 o 500 MB (baja la resolución y los fotogramas si hace falta para
  adjuntarlo en Discord) o **a medida** (H.264, H.265 o AV1, resolución, fotogramas y calidad).
- **Ajustes de grabación**: resolución máxima, 30 o 60 fotogramas por segundo y calidad Baja,
  Media, Alta (la de siempre) o Ultra.

### Partidas

- **Línea de tiempo nueva**: regla con minutos, marcas por tipo de evento, un fotograma de
  vista previa al pasar el cursor, filtros por bajas, muertes, objetivos y rondas, y tus clips
  como barras abajo. Arrastra para elegir un tramo o marca entrada y salida con I y O.
- **Ajustar sincronización**: si los eventos no coinciden con el video, se pueden mover todos a
  la vez desde la partida.
- Los mapas, modos y objetivos de League y Valorant aparecen en español.

### Reproductor

- **Las mismas teclas en todos los videos**, como en YouTube: Espacio o K, J/L 10 s, ←/→ 5 s,
  `,` y `.` un fotograma, `<` y `>` velocidad, M silencia, 0–9 saltan, F pantalla completa (la
  ventana entera se pone en pantalla completa).

### Arreglos

- **Las partidas de League ya no quedan adelantadas** unos 20 segundos: la pantalla de carga ya no
  cuenta como inicio de la partida. Las grabadas antes siguen igual; usa "Ajustar sincronización".
- El búfer ya no se acorta sin avisar con una calidad de grabación alta.

### A tener en cuenta

- H.265 solo aparece al exportar si tu tarjeta gráfica tiene codificador; H.264 y AV1 funcionan
  en cualquier PC.
- "Solo el juego" necesita Windows 10 2004 o más nuevo; en uno anterior se graba todo el sonido.
- La grabación de otros juegos ocupa unos 9 GB por hora de juego mientras no se borran las partes
  antiguas.
- **No vuelvas a instalar una versión anterior**: las mismas razones que en 0.2.0.

<details>
<summary>English</summary>

**Audio and microphone.** Settings → Audio records your microphone (device, volume, noise
suppression) on a track of its own, so publishing or exporting a clip can leave your voice out.
You also choose the sound: everything you hear (as before), only the game, or the game plus apps
you pick.

**Markers.** A mark-the-moment hotkey (`Alt+F11`, changeable or off) drops a marker on the
timeline of the game being recorded, with a sound unlike a save's. Its ✂ in Matches selects the
25 seconds before it.

**Background recording.** Off by default: any other game that gets captured is recorded in
15-minute parts so you can clip it afterwards, keeping only the most recent hours (2 by default,
up to 48). Valorant, League or Counter-Strike starting takes over with their normal recording.

**Export.** Every clip has Export…: as recorded (no quality lost), at most 10, 50 or 500 MB
(resolution and frame rate come down to fit a Discord attachment), or custom (H.264, H.265 or
AV1, resolution, frame rate, quality). Settings adds a recording resolution cap, 30 or 60 fps and
Low/Medium/High/Ultra recording quality (High is what it always was).

**Matches.** A new timeline with a ruler, event markers, a hover preview frame, filters and your
clips as bars; drag to pick a range or set in and out with I and O. "Adjust sync" moves every event
of a match at once. League and Valorant maps, modes and objectives are translated.

**Player.** Every video shares YouTube's keys (Space/K, J/L, ←/→, `,`/`.`, `<`/`>`, M, 0–9, F), and
fullscreen takes the whole window.

**Fixes.** League matches are no longer about 20 seconds early: the loading screen no longer counts
as the start. Matches recorded before stay as they are; use "Adjust sync". A high recording quality
no longer silently shortens the buffer.

**Heads-up.** H.265 export is only offered with a hardware encoder; H.264 and AV1 work on any PC. "Only the game" needs Windows 10 2004 or newer and falls back to all
sound. Background recording costs about 9 GB per hour played until old parts are deleted. Do not
reinstall an older version, for the same reasons as 0.2.0.

</details>

## v0.2.0 — 2026-09-14

### Tú decides qué se publica

- **Los clips se quedan en tu PC hasta que los publicas.** Ya no se sube nada solo: guardar un
  clip (con la tecla o desde una partida) lo deja solo en la app.
- **Botón Publicar**: eliges el título, el juego y en qué servidores de Discord se postea (solo
  aparecen los servidores donde estás). Si no marcas ninguno, el clip tiene solo su página web.
- **Después de publicar** puedes postearlo en más servidores, despublicarlo (se borran los
  mensajes de Discord y la página, el clip se queda en tu PC y si lo vuelves a publicar tendrá
  un enlace nuevo) o eliminarlo en todas partes. Si lo editas, se reemplaza con el mismo enlace.
- **Cada clip muestra un círculo de estado** (local, procesando, publicado, con error) y los
  íconos de los servidores donde está posteado.
- Eliminar un clip desde cualquier lado ahora borra también sus mensajes en Discord.

### Partidas y editor

- **Tus clips aparecen en la línea de tiempo de su partida**, y la biblioteca tiene "Ver en la
  partida".
- **El editor ahora es un solo rango sobre la partida**: arrastras el inicio y el final, incluso
  más allá de los 30 segundos que guardó la tecla. Ya no se puede dividir un clip en partes.
- Se graban partidas de **Teamfight Tactics**.
- **Counter-Strike** marca rondas y el final de la partida, si copias
  `gamestate_integration_cosnostra.cfg` a la carpeta `csgo\cfg` del juego.
- **Valorant** intenta poner tus kills y muertes en la línea de tiempo (todavía sin probar en
  una partida real).
- Límite de espacio para partidas grabadas, en Almacenamiento.

### Carpetas e imágenes

- **Carpetas por juego**: los clips nuevos se guardan en `<carpeta de clips>\<Juego>\Clips` y
  las partidas nuevas en `<Juego>\Matches`. Los clips que ya tenías no se mueven. Renombrar o
  unir un juego mueve los clips de su carpeta.
- **Imágenes de cada juego** en la biblioteca y en Partidas, tomadas de Discord y Steam. Haz
  clic en la imagen del juego para elegir la tuya.

### Discord

- Los posts mencionan al dueño del clip y a quienes estaban en su canal de voz cuando lo grabó
  (cada servidor puede apagarlo con `/clips config`).
- Botón ⚙️ Gestionar en cada post: Ocultar (borra solo ese mensaje) o Eliminar en todas partes.

### Arreglos

- Clic izquierdo en el ícono de la bandeja abre la ventana; el menú sigue en clic derecho.
- En Configuración, el botón Guardar desaparece después de guardar y la página ya no salta
  arriba al elegir una opción.
- Instalador más liviano: trae un ffmpeg reducido y ya no incluye ffprobe.

### A tener en cuenta

- **No vuelvas a instalar una versión anterior.** Subiría y postearía todos tus clips locales,
  y los clips guardados en carpetas por juego no se reproducirían.
- La opción "Subir clips automáticamente" ya no existe.
- Un servidor puede aparecer como "Servidor sin nombre" hasta que un admin vuelva a usar
  `/clips setup` en él.
- Los clips sacados de partidas con versiones anteriores pueden aparecer un poco antes de lo
  real en la línea de tiempo.
- Elegir una imagen de juego de más de 10 MB, o que no sea PNG, JPEG o WebP, no hace nada.

<details>
<summary>English</summary>

**You decide what gets published.** Clips stay on your PC until you press Publish, which picks
the title, the game and which Discord servers get the post (only servers you are in; none means a
web page only). Afterwards you can post to more servers, unpublish (the Discord posts and the page
go away, the clip stays, publishing again gives a new link), or delete it everywhere; editing a
published clip replaces it under the same link. Clips show a status circle and the icons of the
servers they are posted in. Deleting a clip from anywhere now also deletes its Discord messages.

**Matches and the editor.** Clips appear on their match's timeline, with "Show in match" in the
library. The editor is one range on the match that can reach past the saved 30 seconds; splitting
a clip into parts is gone. Teamfight Tactics sessions are recorded, Counter-Strike marks rounds
through Game State Integration (copy the `.cfg` into the game's `csgo\cfg`), Valorant tries to
place kills and deaths (unverified on a real match), and recorded matches get a storage limit.

**Folders and pictures.** New clips go to `<clip folder>\<Game>\Clips` and new matches to
`<Game>\Matches`; existing clips are not moved, and renaming or merging a game moves its folder's
clips. Game pictures from Discord and Steam show in the library and Matches; click one to choose
your own.

**Discord.** Posts mention the owner and whoever was in their voice channel (`/clips config`
turns it off), and every post has a ⚙️ Manage button to hide it or delete the clip everywhere.

**Fixes.** Left-clicking the tray icon opens the window. In Settings the Save button goes away
after saving and the page no longer jumps to the top. The installer ships a minimal ffmpeg and no
ffprobe.

**Heads-up.** Do not reinstall an older version: it would upload and post every local clip, and
clips in game folders would not play. "Upload clips automatically" is gone. A server can show as
"Unnamed server" until an admin runs `/clips setup` again. Clips taken from matches on older
versions may sit slightly early on the timeline. Choosing a game picture over 10 MB, or not PNG,
JPEG or WebP, silently does nothing.

</details>
