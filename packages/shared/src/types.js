// JSDoc typedefs mirroring the data model in docs/PLAN.md (phase 3). Import this module for
// its types; the only runtime export is the clip status list.

/**
 * @typedef {'pending' | 'ready' | 'failed' | 'deleted'} ClipStatus
 */

/** @type {readonly ClipStatus[]} */
export const CLIP_STATUSES = Object.freeze(['pending', 'ready', 'failed', 'deleted']);

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
 */

/**
 * Body of POST /clips.
 * @typedef {object} CreateClipBody
 * @property {string} game
 * @property {string} [title]
 * @property {number} durationMs
 * @property {number} width
 * @property {number} height
 * @property {number} sizeAv1
 * @property {number} sizeH264
 * @property {string} recordedAt  ISO 8601
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
 * @property {string} code
 * @property {string} verificationUrl  open this in the browser
 * @property {number} expiresIn  seconds
 * @property {number} interval  suggested poll interval in seconds
 */

/**
 * Response of GET /auth/device/:code.
 * @typedef {object} DeviceLoginPoll
 * @property {'pending' | 'linked' | 'expired'} status
 * @property {string} [token]  present when status is "linked"
 * @property {User} [user]
 * @property {Device} [device]
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
