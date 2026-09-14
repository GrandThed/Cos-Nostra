// Thin fetch wrapper over the backend API. Used by the desktop app (device token) and the bot
// (shared secret). Every method resolves to the parsed JSON body and throws ApiError on a
// non-2xx status. No dependencies: it runs unchanged in Node 24 and in the Tauri webview.

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {unknown} body  parsed JSON when the response was JSON, otherwise the raw text
   * @param {string} [message]
   */
  constructor(status, body, message) {
    super(message ?? `API request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @typedef {object} ClientOptions
 * @property {string} baseUrl  e.g. https://cosnostra.benja.ar, trailing slash ignored
 * @property {string} [token]  device token for user routes
 * @property {string} [botToken]  BOT_SHARED_SECRET for /internal routes
 * @property {typeof globalThis.fetch} [fetch]  injectable for tests
 */

/**
 * Builds a query string from an object, skipping undefined and null values.
 * @param {Record<string, unknown> | undefined} query
 */
function qs(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** @param {ClientOptions} options */
export function createClient(options) {
  if (!options?.baseUrl) throw new TypeError('createClient: baseUrl is required');
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const userToken = options.token;
  const botToken = options.botToken;

  /**
   * @param {'GET' | 'POST' | 'PUT' | 'DELETE'} method
   * @param {string} path
   * @param {{ body?: unknown, auth?: 'user' | 'bot' | 'none', bearer?: string }} [opts]
   *   `bearer` overrides the configured token for a single call, for one-off credentials such as
   *   the device-login poll secret that are not the client's own token.
   */
  async function request(method, path, opts = {}) {
    const headers = { accept: 'application/json' };
    const auth = opts.auth ?? 'user';
    const token =
      opts.bearer ?? (auth === 'bot' ? botToken : auth === 'user' ? userToken : undefined);
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed = text;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed === 'object' && typeof parsed.message === 'string'
          ? parsed.message
          : undefined;
      throw new ApiError(res.status, parsed, message);
    }
    return text ? parsed : null;
  }

  return {
    // Auth (desktop)
    /** @param {string} deviceName @returns {Promise<import('./types.js').DeviceLoginStart>} */
    startDeviceLogin: (deviceName) =>
      request('POST', '/auth/device', { body: { deviceName }, auth: 'none' }),
    /**
     * Polls a pending device login. The `pollSecret` from startDeviceLogin goes on the wire as a
     * bearer token: the code alone is not enough to collect the device token, and a wrong or
     * missing secret is a 401 whether or not the code exists.
     * @param {string} code
     * @param {string} pollSecret  the `pollSecret` field of the startDeviceLogin response
     * @returns {Promise<import('./types.js').DeviceLoginPoll>}
     */
    pollDeviceLogin: (code, pollSecret) =>
      request('GET', `/auth/device/${encodeURIComponent(code)}`, {
        auth: 'none',
        bearer: pollSecret,
      }),
    /** @returns {Promise<import('./types.js').User>} */
    me: () => request('GET', '/auth/me'),
    /**
     * Who is in the caller's Discord voice channel right now, asked at capture time so the
     * ids can ride along with createClip as `participantDiscordIds`. Always resolves: if the
     * bot is unreachable the backend answers with an empty list rather than an error.
     * @returns {Promise<import('./types.js').VoiceSnapshot>}
     */
    voiceSnapshot: () => request('POST', '/discord/voice-snapshot'),
    /**
     * The servers the Publish dialog may offer: set up with the bot, and confirmed by the bot to
     * have the caller as a member. Rejects with ApiError 503 (`bot_unavailable`) when the bot
     * cannot answer, which is different from an empty list.
     * @returns {Promise<{ items: import('./types.js').PublishGuild[] }>}
     */
    listPublishGuilds: () => request('GET', '/discord/guilds'),

    // Clips (desktop and web)
    /**
     * Creates the clip record and mints its three upload URLs. `participantDiscordIds` on the
     * body is what voiceSnapshot() returned; it is stored on the clip and only ever read back
     * through internalClip(), never through the public clip JSON. `guildIds` is where the first
     * complete posts it; see CreateClipBody.
     * @param {import('./types.js').CreateClipBody} body
     * @returns {Promise<import('./types.js').CreateClipResponse>}
     */
    createClip: (body) => request('POST', '/clips', { body }),
    /**
     * Posts a published clip to more servers. Ids that are not set up, or that already show a
     * live post of the clip, are dropped; `queued` is what is left, and posting it happens in
     * the background. ApiError 409 (`not_ready`) until the clip has finished uploading.
     * @param {string} id
     * @param {string[]} guildIds  1 to 25 guild ids
     * @returns {Promise<import('./types.js').AddClipPostsResponse>}
     */
    addClipPosts: (id, guildIds) =>
      request('POST', `/clips/${encodeURIComponent(id)}/posts`, { body: { guildIds } }),
    /**
     * Every live Discord post of the caller's ready clips, oldest first.
     * @returns {Promise<{ items: import('./types.js').MyPost[] }>}
     */
    myPosts: () => request('GET', '/me/posts'),
    /** @param {string} id @returns {Promise<import('./types.js').Clip>} */
    completeClip: (id) => request('POST', `/clips/${encodeURIComponent(id)}/complete`),
    /** @param {string} id @returns {Promise<import('./types.js').Clip>} */
    getClip: (id) => request('GET', `/clips/${encodeURIComponent(id)}`),
    /** @param {import('./types.js').ClipListQuery} [query] @returns {Promise<import('./types.js').ClipList>} */
    listClips: (query) => request('GET', `/clips${qs(query)}`),
    /** @param {string} id @returns {Promise<null | { ok: true }>} */
    deleteClip: (id) => request('DELETE', `/clips/${encodeURIComponent(id)}`),
    /** @param {import('./types.js').RankingsQuery} query @returns {Promise<import('./types.js').Ranking[]>} */
    rankings: (query) => request('GET', `/rankings${qs(query)}`),

    // Internal (bot, authenticated with botToken)
    /** @param {{ clipId: string, guildId: string, channelId: string, messageId: string }} body @returns {Promise<import('./types.js').Post>} */
    internalPost: (body) => request('POST', '/internal/posts', { body, auth: 'bot' }),
    /**
     * @deprecated use recordReaction; the backend expects action: 'add' | 'remove'.
     * @param {{ messageId: string, userDiscordId: string, emoji: string, removed: boolean }} body
     */
    internalReaction: (body) => request('POST', '/internal/reactions', { body, auth: 'bot' }),
    /**
     * The bot's view of a clip: adds `participants`, the Discord ids of whoever was in voice
     * with the owner at capture time, plus where the clip is meant to be and already is posted
     * (`targetGuildIds`, `posts`). The public clip JSON carries none of them.
     * @param {string} id
     * @returns {Promise<import('./types.js').InternalClip>}
     */
    internalClip: (id) =>
      request('GET', `/internal/clips/${encodeURIComponent(id)}`, { auth: 'bot' }),
    /**
     * Marks the post behind a Discord message as taken down, after the bot's Hide button
     * deleted it. The row is kept for the site and the rankings; it only stops being live.
     * ApiError 404 (`unknown_message`) when no post has that message id.
     * @param {string} messageId
     * @returns {Promise<null>}
     */
    internalRemovePost: (messageId) =>
      request('DELETE', `/internal/posts/${encodeURIComponent(messageId)}`, { auth: 'bot' }),
    /**
     * Takes a clip down on the owner's behalf, for the manage menu on a Discord post. Same
     * outcome as the owner's own deleteClip: the three objects are removed from the bucket and
     * the row is marked deleted but kept, so posts and reactions still resolve.
     * @param {string} id
     * @returns {Promise<null>}
     */
    internalDeleteClip: (id) =>
      request('DELETE', `/internal/clips/${encodeURIComponent(id)}`, { auth: 'bot' }),
    /**
     * One reaction add or remove. Rows are append-only, so "remove" closes the open row
     * rather than deleting it.
     * @param {{ messageId: string, userDiscordId: string, emoji: string, action: 'add' | 'remove' }} body
     * @returns {Promise<{ ok: true, open: number }>}
     */
    recordReaction: (body) => request('POST', '/internal/reactions', { body, auth: 'bot' }),
    /**
     * The post a Discord message belongs to, with its current open reaction count.
     * @param {string} messageId
     * @returns {Promise<import('./types.js').Post & { open: number }>}
     */
    getPost: (messageId) =>
      request('GET', `/internal/posts/${encodeURIComponent(messageId)}`, { auth: 'bot' }),
    /**
     * Per-guild bot configuration: clip channel, seed emojis and reply language.
     * @param {string} guildId
     * @returns {Promise<import('./types.js').GuildSettings>}
     */
    getGuild: (guildId) =>
      request('GET', `/internal/guilds/${encodeURIComponent(guildId)}`, { auth: 'bot' }),
    /**
     * @param {string} guildId
     * Any field but channelId may be omitted, and omitting one leaves the stored value alone.
     * @param {{ channelId?: string | null, seedEmojis?: string[], locale?: import('./types.js').Locale, tagVoiceMembers?: boolean, name?: string, icon?: string | null, slug?: string }} body
     * @returns {Promise<import('./types.js').GuildSettings>}
     */
    putGuild: (guildId, body) =>
      request('PUT', `/internal/guilds/${encodeURIComponent(guildId)}`, { body, auth: 'bot' }),
    /** @returns {Promise<{ items: import('./types.js').GuildSettings[] }>} */
    listGuilds: () => request('GET', '/internal/guilds', { auth: 'bot' }),
  };
}
