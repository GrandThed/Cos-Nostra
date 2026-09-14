# Changelog

Each release's section becomes its GitHub release notes (`.github/workflows/desktop-release.yml`
reads the `## vX.Y.Z` heading that matches the tag), so the newest version goes on top.

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
