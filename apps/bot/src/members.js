// Is this Discord user in that guild? Asked by POST /member-guilds, which is how the backend
// learns which servers to offer in the desktop's Publish dialog, and by post.js before it posts
// a clip to a server its owner picked.
//
// `guild.members.fetch(userId)` for a single id is a REST call (GET /guilds/:id/members/:user),
// not the gateway's Request Guild Members opcode, so it works without the privileged
// GuildMembers intent that client.js deliberately does not ask for. The price of not having that
// intent is that the bot never hears a member leave: a GuildMember sitting in the cache may be
// someone who left an hour ago, which is why every check here goes past the cache.

import { RESTJSONErrorCodes } from 'discord.js';

/**
 * True when Discord's answer means "not a member" rather than "could not tell". Unknown User
 * counts too: an id that is no user at all is certainly not in the guild.
 * @param {any} err
 */
function isNotMember(err) {
  const code = Number(err?.code);
  return code === RESTJSONErrorCodes.UnknownMember || code === RESTJSONErrorCodes.UnknownUser;
}

/**
 * Whether `discordId` is a member of `guild` right now.
 *
 * Resolves false for Unknown Member. Every other failure rejects, because only the caller knows
 * what an unanswerable question should mean: both callers today treat it as "no", but they log
 * it, and a rejection is what lets them.
 *
 * @param {any} guild discord.js Guild
 * @param {string} discordId
 * @returns {Promise<boolean>}
 */
export async function isMember(guild, discordId) {
  try {
    // force: a cached member may be stale (see the header). cache: false, because a forced
    // check never reads the cache, so filling it would only grow memory.
    const member = await guild.members.fetch({ user: discordId, force: true, cache: false });
    return Boolean(member);
  } catch (err) {
    if (isNotMember(err)) return false;
    throw err;
  }
}

/**
 * The subset of `guildIds` the bot is in and `discordId` is a member of, in the order asked.
 *
 * Every guild is checked in parallel and the whole answer is bounded by `timeoutMs`: the backend
 * gives this call four seconds before it tells the desktop the bot is unavailable, so a slow
 * Discord answer for one guild must cost that guild, not the whole list. A guild still unanswered
 * at the deadline is left out, like one that errored.
 *
 * Only `client.guilds.cache` is consulted for the guild itself. The Guilds intent keeps it
 * complete for every guild the bot is in, so a miss there means the bot is not in that guild,
 * and a REST fetch would only spend the time budget learning the same thing.
 *
 * @param {object} options
 * @param {any} options.client discord.js Client
 * @param {string} options.discordId
 * @param {string[]} options.guildIds
 * @param {number} options.timeoutMs
 * @param {{ warn: Function }} options.log
 * @returns {Promise<string[]>}
 */
export async function memberGuilds({ client, discordId, guildIds, timeoutMs, log }) {
  const unique = [...new Set(guildIds)];
  const cache = client?.guilds?.cache;
  /** @type {Set<string>} */
  const confirmed = new Set();
  /** @type {Set<string>} */
  const pending = new Set();

  const checks = unique.map(async (guildId) => {
    const guild = typeof cache?.get === 'function' ? cache.get(guildId) : undefined;
    if (!guild) return;
    pending.add(guildId);
    try {
      // Every failure is caught per guild: a rejection escaping into Promise.all would leave
      // the request unanswered instead of costing one guild.
      if (await isMember(guild, discordId)) confirmed.add(guildId);
    } catch (err) {
      log.warn(
        `membership of ${discordId} in guild ${guildId} could not be checked: ${err?.message ?? err}`,
      );
    } finally {
      pending.delete(guildId);
    }
  });

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(checks), deadline]);
  clearTimeout(timer);

  if (pending.size > 0) {
    log.warn(
      `membership of ${discordId} unanswered after ${timeoutMs} ms in guild(s) ${[...pending].join(', ')}, leaving them out`,
    );
  }
  // A snapshot taken now: a check that lands after the deadline must not change an answer that
  // has already been sent.
  return unique.filter((guildId) => confirmed.has(guildId));
}
