// Spanish strings. This is the primary dictionary: DEFAULT_LOCALE is 'es' and i18n.js falls
// back here for any key an other locale is missing, so every key the bot uses must exist in
// this file.
//
// `{name}` placeholders are filled by t(); anything else is literal Discord markdown.

export const es = {
  common: {
    unknownGame: 'Desconocido',
    untitledClip: 'Clip sin título',
    someone: 'alguien',
  },

  embed: {
    fieldGame: 'Juego',
    fieldLength: 'Duración',
    fieldReactions: 'Reacciones',
    footer: 'Clipeado por {user}',
  },

  setup: {
    guildOnly: 'Ejecutá esto en el servidor donde querés que se publiquen los clips.',
    needsPermission:
      'Necesitás el permiso **Gestionar servidor** para cambiar el canal de clips.',
    badChannel: 'Elegí un canal de texto normal. Los clips no se pueden publicar en ese.',
    saved: 'Los clips nuevos se van a publicar en <#{channel}>.',
    seedLine: ' Reacciones iniciales: {emojis}',
    languageLine: ' Idioma: {language}.',
    slugLine: ' Sitio de clips: /{slug}.',
    slugTaken: ' La URL "{slug}" ya la usa otro servidor; el resto se guardó igual.',
    languages: {
      es: 'Español',
      en: 'Inglés',
    },
  },

  config: {
    guildOnly: 'Ejecutá esto en el servidor que querés configurar.',
    needsPermission:
      'Necesitás el permiso **Gestionar servidor** para cambiar la configuración del bot.',
    badEmojis: 'Pasame entre 1 y {max} emojis, separados por espacios.',
    needsSetupFirst: 'Primero corré `/clips setup`: este servidor todavía no tiene canal de clips.',
    current: 'Configuración actual de este servidor:',
    saved: 'Listo, guardado.',
    seedLine: '• Reacciones iniciales: {emojis}',
    tagLine: '• Mencionar a los que estaban en la llamada: {state}',
    noEmojis: 'ninguna',
    on: 'sí',
    off: 'no',
  },

  manage: {
    menu: 'Gestionando {clip}. **Ocultar** solo borra este mensaje; **borrar** elimina el clip de todos lados.',
    hideButton: 'Ocultar acá',
    deleteButton: 'Borrar de todos lados',
    confirmButton: 'Sí, borralo',
    cancelButton: 'Cancelar',
    confirmPrompt:
      '¿Borrar {clip} para siempre? Se van el video, su página y todas las publicaciones, y no hay vuelta atrás.',
    hidden: 'Oculto de este canal. El clip queda intacto.',
    deleted: 'Clip borrado. Ya no está en el sitio ni en ningún servidor donde se publicó.',
    notYours:
      'Ese clip no es tuyo. Solo lo puede gestionar quien lo grabó o alguien con **Gestionar servidor**.',
    gone: 'Ese clip ya no existe.',
    failed: 'Algo salió mal y no se cambió nada. Probá de nuevo en un momento.',
  },

  latest: {
    empty: 'Todavía no hay clips. Apretá la tecla rápida en una partida y esto se va a llenar.',
  },

  top: {
    guildOnly: 'Los rankings son por servidor, así que ejecutá esto en uno.',
    emptyGame: 'Todavía no hay clips de {game} rankeados en {year}.',
    empty: 'Todavía nadie reaccionó a un clip de {year}.',
    title: 'Mejores clips de {year}',
    footer: 'Filtrado por {game} dentro del top 10 del año',
    reactorsOne: '{count} persona',
    reactorsMany: '{count} personas',
  },

  mine: {
    empty:
      'Todavía no subiste ningún clip. Vinculá la app de escritorio con `/clips link` y guardá uno.',
    title: 'Tus clips',
    footer: 'Tus {count} más recientes',
    unknownDate: 'fecha desconocida',
  },

  link: {
    open: 'Vinculá la app de escritorio desde la app misma: abrí **Cos Nostra**, andá a **Configuración** y apretá **Vincular Discord**.',
    verify:
      'Se abre el navegador y la app muestra un código de ocho caracteres. Fijate que la página muestre el mismo código antes de apretar Continuar, y nunca apruebes una página de vinculación que no hayas empezado vos.',
    done: 'Cuando diga que quedó vinculada, tus clips se suben solos.',
  },

  errors: {
    auth: 'El bot no tiene permiso para hablar con el backend de Cos Nostra. Un admin debería revisar BOT_SHARED_SECRET.',
    notFound: 'El backend todavía no tiene nada de eso.',
    rateLimited: 'El backend nos está limitando. Probá de nuevo en un minuto.',
    server: 'El backend de Cos Nostra está teniendo un mal momento. Probá de nuevo en un rato.',
    badRequest: 'El backend rechazó esa petición, así que no cambió nada.',
    unreachable: 'No se pudo contactar al backend de Cos Nostra. Probá de nuevo en un momento.',
  },

  post: {
    byOwner: '{title} - por {user}',
    withOthers: 'con {mentions}',
    defaultTitle: 'Clip',
  },

  commandDescriptions: {
    clips: 'Clips de Cos Nostra',
    setup: 'Elegí el canal donde se publican los clips nuevos (necesita Gestionar servidor)',
    setupChannel: 'Canal de texto para los clips nuevos',
    setupLanguage: 'Idioma en el que el bot responde en este servidor',
    setupSlug: 'URL del sitio público de clips de este servidor, ej. "famafia"',
    config: 'Ver o cambiar el resto de la configuración del bot (necesita Gestionar servidor)',
    configEmojis: 'Reacciones iniciales, separadas por espacios (máx. 5)',
    configTagVoiceMembers:
      'Mencionar a todos los que estaban en la llamada cuando se grabó el clip',
    latest: 'Mostrar el clip más reciente',
    top: 'Ranking de los clips con más reacciones',
    topYear: 'Año a rankear (por defecto, el año actual)',
    topGame: 'Solo clips de este juego',
    mine: 'Mostrar tus propios clips (la respuesta la ves solo vos)',
    link: 'Cómo vincular la app de escritorio de Cos Nostra con tu cuenta',
  },
};
