// English strings. Mirrors every key in es.js, which is the dictionary i18n.js falls back to
// when one is missing here.

export const en = {
  common: {
    unknownGame: 'Unknown',
    untitledClip: 'Untitled clip',
    someone: 'someone',
  },

  embed: {
    fieldGame: 'Game',
    fieldLength: 'Length',
    fieldReactions: 'Reactions',
    footer: 'Clipped by {user}',
  },

  setup: {
    guildOnly: 'Run this in the server you want clips posted to.',
    needsPermission: 'You need the **Manage Server** permission to change the clip channel.',
    badChannel: 'Pick a normal text channel. Clips cannot be posted to that one.',
    saved: 'New clips will be posted to <#{channel}>.',
    seedLine: ' Seed reactions: {emojis}',
    languageLine: ' Language: {language}.',
    slugLine: ' Clip site: /{slug}.',
    slugTaken: ' The URL "{slug}" is already used by another server; everything else was saved.',
    languages: {
      es: 'Spanish',
      en: 'English',
    },
  },

  config: {
    guildOnly: 'Run this in the server you want to configure.',
    needsPermission: 'You need the **Manage Server** permission to change the bot settings.',
    badEmojis: 'Give me between 1 and {max} emojis, separated by spaces.',
    needsSetupFirst: 'Run `/clips setup` first: this server has no clip channel yet.',
    current: 'Current settings for this server:',
    saved: 'Saved.',
    seedLine: '• Seed reactions: {emojis}',
    tagLine: '• Mention everyone who was in voice: {state}',
    noEmojis: 'none',
    on: 'on',
    off: 'off',
  },

  manage: {
    menu: 'Managing {clip}. **Hide** only removes this message; **delete** removes the clip everywhere.',
    hideButton: 'Hide here',
    deleteButton: 'Delete everywhere',
    confirmButton: 'Yes, delete it',
    cancelButton: 'Cancel',
    confirmPrompt:
      'Delete {clip} for good? The video, its page and every post of it go away, and nothing brings them back.',
    hidden: 'Hidden from this channel. The clip itself is untouched.',
    deleted: 'Clip deleted. It is gone from the site and from every server it was posted to.',
    notYours: 'That clip is not yours. Only whoever recorded it, or someone with **Manage Server**, can manage it.',
    gone: 'That clip does not exist any more.',
    failed: 'Something went wrong and nothing was changed. Try again in a moment.',
  },

  latest: {
    empty: 'No clips yet. Press the hotkey in a game and this will fill up.',
  },

  top: {
    guildOnly: 'Rankings are per server, so run this in one.',
    emptyGame: 'No ranked {game} clips in {year} yet.',
    empty: 'No clips have been reacted to in {year} yet.',
    title: 'Top clips of {year}',
    footer: "Filtered to {game} within this year's top 10",
    reactorsOne: '{count} reactor',
    reactorsMany: '{count} reactors',
  },

  mine: {
    empty: 'You have no uploaded clips yet. Link the desktop app with `/clips link` and save one.',
    title: 'Your clips',
    footer: 'Your {count} most recent',
    unknownDate: 'unknown date',
  },

  link: {
    open: 'Link the desktop app from the app itself: open **Cos Nostra**, go to **Settings**, and press **Link Discord**.',
    verify:
      'It opens your browser and shows an eight-character code. Check that the page shows the same code before you press Continue, and never approve a link page you did not start yourself.',
    done: 'Once it says linked, your clips upload on their own.',
  },

  errors: {
    auth: 'The bot is not allowed to talk to the Cos Nostra backend. An admin should check BOT_SHARED_SECRET.',
    notFound: 'The backend has nothing for that yet.',
    rateLimited: 'The backend is rate limiting us. Try again in a minute.',
    server: 'The Cos Nostra backend is having a moment. Try again shortly.',
    badRequest: 'The backend rejected that request, so nothing changed.',
    unreachable: 'Could not reach the Cos Nostra backend. Try again in a moment.',
  },

  post: {
    byOwner: '{title} - by {user}',
    withOthers: 'with {mentions}',
    defaultTitle: 'Clip',
  },

  commandDescriptions: {
    clips: 'Cos Nostra clips',
    setup: 'Choose the channel new clips are posted to (needs Manage Server)',
    setupChannel: 'Text channel for new clips',
    setupLanguage: 'Language the bot replies in on this server',
    setupSlug: 'URL for this server\'s public clip site, e.g. "famafia"',
    config: 'See or change the rest of the bot settings (needs Manage Server)',
    configEmojis: 'Space-separated seed emojis (max 5)',
    configTagVoiceMembers: 'Mention everyone who was in voice when the clip was recorded',
    latest: 'Show the most recent clip',
    top: 'Leaderboard of the most reacted clips',
    topYear: 'Year to rank (defaults to the current year)',
    topGame: 'Only clips from this game',
    mine: 'Show your own clips (only you see the reply)',
    link: 'How to link the Cos Nostra desktop app to your account',
  },
};
