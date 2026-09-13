// JSDoc typedefs mirroring the data model in docs/PLAN.md (phase 3). Import this module for
// its types; the only runtime exports are the clip status and locale lists.

/**
 * @typedef {'pending' | 'ready' | 'failed' | 'deleted'} ClipStatus
 */

/** @type {readonly ClipStatus[]} */
export const CLIP_STATUSES = Object.freeze(['pending', 'ready', 'failed', 'deleted']);

/**
 * A language the bot and desktop app can display. Add a code here, plus a locale file in each
 * app, to support a new language everywhere that reads this list.
 * @typedef {'en' | 'es'} Locale
 */

/** @type {readonly Locale[]} */
export const SUPPORTED_LOCALES = Object.freeze(['en', 'es']);

/** The bot's reply language when a guild has not set one. The community is Spanish-speaking. */
export const DEFAULT_LOCALE = 'es';

/**
 * Per-guild bot configuration: where clips get posted, which emojis it seeds on every post,
 * and what language it replies in.
 * @typedef {object} GuildSettings
 * @property {string} guildId
 * @property {string | null} channelId
 * @property {string[]} seedEmojis
 * @property {Locale} locale
 * @property {boolean} tagVoiceMembers  @mention everyone who was in voice with the clip owner
 *   when it was captured. On unless a guild turned it off with `/clips config`.
 * @property {string | null} name  Discord server name, backing the public clip site (phase 5)
 * @property {string | null} icon  Discord CDN icon hash, a bare hash like `avatar`, never a URL
 * @property {string | null} slug  the clip site's URL segment (e.g. "famafia"), set once by a
 *   human via `/clips setup`; null until someone picks one
 */

/**
 * @typedef {object} User
 * @property {string} id
 * @property {string} discordId
 * @property {string} username
 * @property {string | null} avatar
 * @property {string} createdAt  ISO 8601
 */

/**
 * @typedef {object} Device
 * @property {string} id
 * @property {string} userId
 * @property {string} name
 * @property {string | null} lastSeen  ISO 8601
 */

/**
 * @typedef {object} Clip
 * @property {string} id
 * @property {string} userId
 * @property {string} game
 * @property {string | null} title
 * @property {number} durationMs
 * @property {number} width
 * @property {number} height
 * @property {number | null} sizeAv1
 * @property {number | null} sizeH264
 * @property {string | null} keyAv1
 * @property {string | null} keyH264
 * @property {string | null} keyThumb
 * @property {string} recordedAt  ISO 8601
 * @property {string | null} uploadedAt  ISO 8601
 * @property {ClipStatus} status
 * @property {string[]} [participants]  Discord ids of whoever was in voice with the owner when
 *   the clip was captured. Only GET /internal/clips/:id returns this; the public clip JSON
 *   leaves it out, so it is optional on the shared type rather than a second typedef.
 */

/**
 * Body of POST /clips.
 * @typedef {object} CreateClipBody
 * @property {string} game
 * @property {string} [title]
 * @property {number} durationMs
 * @property {number} width
 * @property {number} height
 * @property {number} sizeAv1   exact byte length of the AV1 file; signed into its upload URL
 * @property {number} sizeH264  exact byte length of the H.264 file
 * @property {number} sizeThumb exact byte length of the thumbnail
 * @property {string} recordedAt  ISO 8601
 * @property {string[]} [participantDiscordIds]  who was in voice with the owner at capture
 *   time, from voiceSnapshot(). At most 50; omitted or null means nobody was.
 */

/**
 * Response of POST /discord/voice-snapshot: the other members of the caller's Discord voice
 * channel, right now. Empty whenever the bot cannot answer, never an error.
 * @typedef {object} VoiceSnapshot
 * @property {string[]} participants  Discord user ids
 */

/**
 * Response of POST /clips: the pending clip plus presigned PUT URLs.
 * @typedef {object} CreateClipResponse
 * @property {Clip} clip
 * @property {{ av1: string, h264: string, thumb: string }} uploadUrls
 */

/**
 * @typedef {object} Post
 * @property {string} id
 * @property {string} clipId
 * @property {string} guildId
 * @property {string} channelId
 * @property {string} messageId
 * @property {string} postedAt  ISO 8601
 */

/**
 * One row of GET /rankings.
 * @typedef {object} Ranking
 * @property {number} rank
 * @property {Clip} clip
 * @property {Pick<User, 'id' | 'discordId' | 'username' | 'avatar'>} owner
 * @property {number} reactions  distinct reacting users with removed_at null
 */

/**
 * Response of POST /auth/device.
 * @typedef {object} DeviceLoginStart
 * @property {string} code  8 characters, shown to the user so they can check it in the browser
 * @property {string} verifyUrl  open this in the browser; it carries the code
 * @property {string} pollSecret  send as `Authorization: Bearer` when polling. Shown once, never
 *   put in a URL or on screen: it is what proves a poll comes from the app that started the login
 * @property {number} expiresIn  seconds
 */

/**
 * Response of GET /auth/device/:code. Requires the pollSecret as a bearer token; a missing or
 * wrong secret is a 401, whether or not the code exists.
 * @typedef {object} DeviceLoginPoll
 * @property {'pending' | 'ready'} status
 * @property {string} [token]  the device token, present exactly once, when status is "ready"
 * @property {User | null} [user]
 */

/**
 * @typedef {object} ClipListQuery
 * @property {string} [user]
 * @property {string} [game]
 * @property {number} [year]
 * @property {'newest' | 'oldest' | 'top'} [sort]
 * @property {string} [cursor]
 * @property {number} [limit]
 */

/**
 * @typedef {object} ClipList
 * @property {Clip[]} items
 * @property {string | null} nextCursor
 */

/**
 * @typedef {object} RankingsQuery
 * @property {string} guild
 * @property {number} [year]
 * @property {number} [limit]
 */
