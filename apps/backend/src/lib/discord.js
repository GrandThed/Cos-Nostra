// Discord OAuth2 calls. Only the `identify` scope is used: we need the id, username and
// avatar, nothing else. `config.DISCORD_API_BASE` is overridable so tests can stub Discord.

/**
 * @typedef {object} DiscordUser
 * @property {string} id
 * @property {string} username
 * @property {string | null} avatar
 */

// The device-login flow's callback. The browser-login flow (routes/login.js) uses a distinct
// path, `/login/callback`, so the two flows never share a redirect URI - each is registered
// separately in the Discord application's OAuth2 settings.
const DEFAULT_CALLBACK_PATH = '/auth/discord/callback';

/**
 * @param {import('../config.js').Config} config
 * @param {string} [path]
 */
export function redirectUri(config, path = DEFAULT_CALLBACK_PATH) {
  return `${config.PUBLIC_URL}${path}`;
}

/**
 * URL the browser is sent to so the user can approve the login.
 * @param {import('../config.js').Config} config
 * @param {string} state
 * @param {string} [callbackPath]
 */
export function authorizeUrl(config, state, callbackPath = DEFAULT_CALLBACK_PATH) {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    response_type: 'code',
    scope: 'identify',
    redirect_uri: redirectUri(config, callbackPath),
    state,
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * Exchanges the authorization code for an access token.
 * @param {import('../config.js').Config} config
 * @param {string} code
 * @param {string} [callbackPath] must match the one passed to authorizeUrl for this code
 * @returns {Promise<{ accessToken: string, tokenType: string }>}
 */
export async function exchangeCode(config, code, callbackPath = DEFAULT_CALLBACK_PATH) {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(config, callbackPath),
  });
  const res = await fetch(`${config.DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`discord token exchange failed: ${res.status} ${await safeText(res)}`);
  }
  const json = await res.json();
  if (typeof json.access_token !== 'string') {
    throw new Error('discord token exchange returned no access_token');
  }
  return { accessToken: json.access_token, tokenType: json.token_type ?? 'Bearer' };
}

/**
 * @param {import('../config.js').Config} config
 * @param {string} accessToken
 * @returns {Promise<DiscordUser>}
 */
export async function fetchUser(config, accessToken) {
  const res = await fetch(`${config.DISCORD_API_BASE}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`discord users/@me failed: ${res.status} ${await safeText(res)}`);
  }
  const json = await res.json();
  if (typeof json.id !== 'string' || typeof json.username !== 'string') {
    throw new Error('discord users/@me returned an unexpected body');
  }
  return { id: json.id, username: json.username, avatar: json.avatar ?? null };
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
