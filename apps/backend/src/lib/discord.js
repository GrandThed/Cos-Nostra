// Discord OAuth2 calls. Only the `identify` scope is used: we need the id, username and
// avatar, nothing else. `config.DISCORD_API_BASE` is overridable so tests can stub Discord.

/**
 * @typedef {object} DiscordUser
 * @property {string} id
 * @property {string} username
 * @property {string | null} avatar
 */

/** @param {import('../config.js').Config} config */
export function redirectUri(config) {
  return `${config.PUBLIC_URL}/auth/discord/callback`;
}

/**
 * URL the browser is sent to so the user can approve the login.
 * @param {import('../config.js').Config} config
 * @param {string} state
 */
export function authorizeUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    response_type: 'code',
    scope: 'identify',
    redirect_uri: redirectUri(config),
    state,
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * Exchanges the authorization code for an access token.
 * @param {import('../config.js').Config} config
 * @param {string} code
 * @returns {Promise<{ accessToken: string, tokenType: string }>}
 */
export async function exchangeCode(config, code) {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(config),
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
