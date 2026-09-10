// Environment validation for the bot. Same contract as apps/backend/src/config.js: fail fast
// at startup and name every problem at once, which is what the railway-deploy skill tells you
// to look for when a deploy crashes on boot.
//
// Hand-rolled instead of zod on purpose: zod is a dependency of apps/backend, and the bot
// image runs `npm ci --workspace apps/bot --include-workspace-root=false` (see Dockerfile),
// so importing zod here would work locally through the hoisted root node_modules and then
// fail in production. Node builtins only.

/**
 * @typedef {object} Config
 * @property {string} DISCORD_TOKEN        bot token from the Discord application
 * @property {string} DISCORD_CLIENT_ID    application id, used to register slash commands
 * @property {string} BOT_SHARED_SECRET    shared with the backend for /internal and POST /post
 * @property {string} BACKEND_URL          base URL of the backend, no trailing slash
 * @property {number} BOT_PORT             internal HTTP server port
 * @property {string} [DISCORD_DEV_GUILD_ID] guild for instant command registration in dev
 * @property {string} LOG_LEVEL            error, warn, info or debug
 */

/**
 * Reads the environment and returns a validated config.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 * @throws {Error} with every problem listed, one per line
 */
export function loadConfig(env = process.env) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} name @param {string} message */
  const fail = (name, message) => problems.push(`  ${name}: ${message}`);

  /**
   * A required, non-empty string. Values are trimmed because Railway variables are pasted
   * by hand and a trailing newline in a token is very hard to see in a log.
   * @param {string} name
   * @param {number} [min]
   */
  const required = (name, min = 1) => {
    const raw = env[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      fail(name, 'required');
      return '';
    }
    if (value.length < min) {
      fail(name, `must be at least ${min} characters`);
      return '';
    }
    return value;
  };

  /** @param {string} name */
  const optional = (name) => {
    const raw = env[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || undefined;
  };

  const DISCORD_TOKEN = required('DISCORD_TOKEN');
  const DISCORD_CLIENT_ID = required('DISCORD_CLIENT_ID');
  const BOT_SHARED_SECRET = required('BOT_SHARED_SECRET', 16);

  // http/https only, and the trailing slash is stripped here so every caller can concatenate
  // paths without thinking about it. new URL() would normalise "http://host" to a "/" path.
  let BACKEND_URL = '';
  const rawBackendUrl = optional('BACKEND_URL');
  if (!rawBackendUrl) {
    fail('BACKEND_URL', 'required');
  } else {
    let protocol = '';
    try {
      protocol = new URL(rawBackendUrl).protocol;
    } catch {
      protocol = '';
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      fail('BACKEND_URL', 'must be an http or https URL');
    } else {
      BACKEND_URL = rawBackendUrl.replace(/\/+$/, '');
    }
  }

  let BOT_PORT = 3001;
  const rawPort = optional('BOT_PORT');
  if (rawPort !== undefined) {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      fail('BOT_PORT', 'must be an integer between 0 and 65535');
    } else {
      BOT_PORT = port;
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid environment:\n${problems.join('\n')}`);
  }

  return {
    DISCORD_TOKEN,
    DISCORD_CLIENT_ID,
    BOT_SHARED_SECRET,
    BACKEND_URL,
    BOT_PORT,
    DISCORD_DEV_GUILD_ID: optional('DISCORD_DEV_GUILD_ID'),
    LOG_LEVEL: optional('LOG_LEVEL') ?? 'info',
  };
}
