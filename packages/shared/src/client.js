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
   * @param {{ body?: unknown, auth?: 'user' | 'bot' | 'none' }} [opts]
   */
  async function request(method, path, opts = {}) {
    const headers = { accept: 'application/json' };
    const auth = opts.auth ?? 'user';
    const bearer = auth === 'bot' ? botToken : auth === 'user' ? userToken : undefined;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
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
    /** @param {string} code @returns {Promise<import('./types.js').DeviceLoginPoll>} */
    pollDeviceLogin: (code) =>
      request('GET', `/auth/device/${encodeURIComponent(code)}`, { auth: 'none' }),
    /** @returns {Promise<import('./types.js').User>} */
    me: () => request('GET', '/auth/me'),

    // Clips (desktop and web)
    /** @param {import('./types.js').CreateClipBody} body @returns {Promise<import('./types.js').CreateClipResponse>} */
    createClip: (body) => request('POST', '/clips', { body }),
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
    /** @param {string} id @returns {Promise<import('./types.js').Clip>} */
    internalClip: (id) =>
      request('GET', `/internal/clips/${encodeURIComponent(id)}`, { auth: 'bot' }),
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
     * Per-guild bot configuration: clip channel and seed emojis.
     * @param {string} guildId
     * @returns {Promise<{ guildId: string, channelId: string | null, seedEmojis: string[] }>}
     */
    getGuild: (guildId) =>
      request('GET', `/internal/guilds/${encodeURIComponent(guildId)}`, { auth: 'bot' }),
    /**
     * @param {string} guildId
     * @param {{ channelId?: string | null, seedEmojis?: string[] }} body
     * @returns {Promise<{ guildId: string, channelId: string | null, seedEmojis: string[] }>}
     */
    putGuild: (guildId, body) =>
      request('PUT', `/internal/guilds/${encodeURIComponent(guildId)}`, { body, auth: 'bot' }),
    /** @returns {Promise<{ items: { guildId: string, channelId: string | null, seedEmojis: string[] }[] }>} */
    listGuilds: () => request('GET', '/internal/guilds', { auth: 'bot' }),
  };
}
