// Entry point. Loads and validates the environment, builds the Discord client and the
// backend client, wires the four feature modules together and starts the internal HTTP
// server the backend calls after an upload.
//
// The module graph is deliberately flat: this file is the only place that knows about all
// of the parts, so post.js, reactions.js, commands.js and outbox.js stay independently
// testable with fakes.

import { Client, GatewayIntentBits, Partials } from 'discord.js';

import { loadConfig } from './config.js';
import { createBackend } from './backend.js';
import { createServer } from './server.js';
import { createPoster } from './post.js';
import { createOutbox } from './outbox.js';
import { registerReactions } from './reactions.js';
import { registerCommands } from './commands.js';

// Reaction writes are retried on this schedule so a backend deploy (a minute or so of 502s)
// never loses a vote. The same shape as the backend's notifyBot retries, with a longer tail.
const OUTBOX_DELAYS = [1_000, 3_000, 9_000, 27_000, 60_000];

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

/**
 * Console logger with levels. A dependency for this would be silly: Railway captures stdout
 * and stderr and adds the timestamps itself.
 * @param {string} level
 */
function createLog(level) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  /** @param {keyof typeof LEVELS} name @param {(...args: unknown[]) => void} write */
  const at = (name, write) =>
    /** @param {...unknown} args */
    (...args) => {
      if (LEVELS[name] <= threshold) write(`[${name}]`, ...args);
    };
  return {
    error: at('error', console.error),
    warn: at('warn', console.warn),
    info: at('info', console.log),
    debug: at('debug', console.log),
  };
}

/** @type {import('./config.js').Config} */
let config;
try {
  config = loadConfig();
} catch (err) {
  // Every problem at once, so one look at the crash log is enough to fix the deploy.
  console.error(err.message);
  process.exit(1);
}

const log = createLog(config.LOG_LEVEL);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Partials let us receive reactions on messages sent before the bot started.
  partials: [Partials.Message, Partials.Reaction],
});

const backend = createBackend({
  baseUrl: config.BACKEND_URL,
  botToken: config.BOT_SHARED_SECRET,
});

// Reactions go through the outbox, never straight to the backend, so a write that fails is
// retried instead of dropped on the floor.
const outbox = createOutbox({
  send: (job) => backend.recordReaction(job),
  // onError fires only after the last retry, so this line means a vote was dropped.
  // Argument order is (job, error), matching createOutbox.
  onError: (job, err) =>
    log.error(`reaction write dropped after every retry: ${err?.message ?? String(err)}`, job ?? ''),
  delays: OUTBOX_DELAYS,
});

const poster = createPoster({ client, backend, log });

registerReactions({ client, backend, outbox, log });
registerCommands({ client, backend, log });

const server = createServer({ config, poster, log });

client.once('clientReady', () => log.info(`Logged in as ${client.user.tag}`));

let shuttingDown = false;
/**
 * Releases the port and the gateway connection, then lets the event loop drain. Calling
 * process.exit() while the discord.js WebSocket is still closing aborts the process inside
 * libuv on Windows, so exiting is left to the loop with a forced exit as the backstop.
 * @param {NodeJS.Signals} signal
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  try {
    await server.close();
    outbox.stop();
    await client.destroy();
  } catch (err) {
    log.error(`shutdown failed: ${err?.message ?? String(err)}`);
  }
  // Unref'd, so it never delays a clean exit; it only fires if something is still holding
  // the loop open, which must not turn into a hung Railway deploy.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A bot that dies on one stray rejection is worse than a bot that logs it: Discord state is
// all remote and the backend is the source of truth for votes.
process.on('unhandledRejection', (reason) => {
  log.error(`unhandled rejection: ${reason?.stack ?? reason?.message ?? String(reason)}`);
});

try {
  await client.login(config.DISCORD_TOKEN);
  await server.listen();
} catch (err) {
  // A bad token or a taken port is fatal, but tear down first: see shutdown() above.
  log.error(`startup failed: ${err?.stack ?? err?.message ?? String(err)}`);
  process.exitCode = 1;
  shuttingDown = true;
  await server.close().catch(() => {});
  outbox.stop();
  await client.destroy().catch(() => {});
  setTimeout(() => process.exit(1), 5_000).unref();
}
