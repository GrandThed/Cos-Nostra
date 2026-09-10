import { Client, GatewayIntentBits, Partials } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Partials let us receive reactions on messages sent before the bot started.
  partials: [Partials.Message, Partials.Reaction],
});

client.once('clientReady', () => console.log(`Logged in as ${client.user.tag}`));

client.login(process.env.DISCORD_TOKEN);
