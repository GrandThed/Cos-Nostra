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
    languages: {
      es: 'Spanish',
      en: 'English',
    },
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
    defaultTitle: 'Clip',
  },

  commandDescriptions: {
    clips: 'Cos Nostra clips',
    setup: 'Choose the channel new clips are posted to (needs Manage Server)',
    setupChannel: 'Text channel for new clips',
    setupLanguage: 'Language the bot replies in on this server',
    latest: 'Show the most recent clip',
    top: 'Leaderboard of the most reacted clips',
    topYear: 'Year to rank (defaults to the current year)',
    topGame: 'Only clips from this game',
    mine: 'Show your own clips (only you see the reply)',
    link: 'How to link the Cos Nostra desktop app to your account',
  },
};
