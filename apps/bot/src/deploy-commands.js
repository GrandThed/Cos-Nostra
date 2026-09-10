// Registers the slash commands with Discord. Run it by hand after changing commands.js:
//
//   node apps/bot/src/deploy-commands.js
//
// With DISCORD_DEV_GUILD_ID set the commands go to that one guild and appear immediately,
// which is the whole reason this script exists; without it they are registered globally and
// Discord takes its time propagating them. Both calls are a PUT: the command set sent here
// replaces whatever was registered before in that scope.
//
// Nothing imports this file. It is not part of the bot process.

import { REST, Routes } from 'discord.js';

import { loadConfig } from './config.js';
import { commands } from './commands.js';

/**
 * The three variables this script needs. loadConfig validates the whole bot environment, so
 * it fails on a machine that has a token but no BACKEND_URL; that must not stop a command
 * deploy, hence the fallback to the raw environment.
 * @returns {{ token: string, clientId: string, guildId: string | undefined }}
 */
function readEnv() {
  /** @type {Partial<import('./config.js').Config>} */
  let config = {};
  try {
    config = loadConfig();
  } catch (err) {
    console.warn(`config incomplete, using the environment directly: ${err?.message ?? err}`);
  }
  const pick = (name) => {
    const value = config[name] ?? process.env[name];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const token = pick('DISCORD_TOKEN');
  const clientId = pick('DISCORD_CLIENT_ID');
  const missing = [
    ['DISCORD_TOKEN', token],
    ['DISCORD_CLIENT_ID', clientId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`missing environment variables: ${missing.join(', ')}`);
  }
  return { token, clientId, guildId: pick('DISCORD_DEV_GUILD_ID') };
}

async function main() {
  const { token, clientId, guildId } = readEnv();
  const rest = new REST({ version: '10' }).setToken(token);

  const scope = guildId ? `guild ${guildId}` : 'globally';
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  console.log(`Registering ${commands.length} command(s) ${scope} for application ${clientId}...`);
  const result = await rest.put(route, { body: commands });

  const registered = Array.isArray(result) ? result : [];
  for (const command of registered) {
    const subs = (command.options ?? [])
      .filter((opt) => opt.type === 1)
      .map((opt) => opt.name)
      .join(', ');
    console.log(`  /${command.name}${subs ? ` (${subs})` : ''}  id ${command.id}`);
  }
  console.log(
    guildId
      ? `Done. ${registered.length} command(s) live in guild ${guildId} right now.`
      : `Done. ${registered.length} command(s) registered globally; Discord may take an hour to show them everywhere.`,
  );
}

try {
  await main();
} catch (err) {
  // A Discord REST error carries the useful part in err.rawError.
  console.error(`Command registration failed: ${err?.message ?? err}`);
  if (err?.rawError) console.error(JSON.stringify(err.rawError, null, 2));
  process.exitCode = 1;
}
// Deliberately no process.exit(): calling it while @discordjs/rest is still tearing its
// agent down aborts the process inside libuv on Windows ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)"), which turns a readable REST error into a crash
// and a useless npm exit code. Nothing here keeps the loop alive, so it exits on its own.
