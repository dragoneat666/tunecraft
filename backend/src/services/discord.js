const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { db } = require('../db');
const { scanForNewRadioPlaylists, buildPlaylist } = require('./playlistEngine');

let client = null;

function isEnabled() {
  return !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('tunecraft')
      .setDescription('Tunecraft playlist commands')
      .addSubcommand(sub =>
        sub.setName('scan')
          .setDescription('Scan Plex for new Radio: playlists and process them')
      )
      .addSubcommand(sub =>
        sub.setName('rebuild')
          .setDescription('Rebuild a managed playlist')
      ),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, process.env.DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log('[Discord] Slash commands registered');
}

async function startBot() {
  if (!isEnabled()) {
    console.log('[Discord] Bot not configured, skipping');
    return;
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);
    await registerCommands();
  });

  client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'tunecraft') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'scan') {
        await interaction.deferReply();
        try {
          const results = await scanForNewRadioPlaylists();
          if (!results.length) {
            await interaction.editReply('✅ No new Radio: playlists found in Plex.');
          } else {
            const list = results.map(r => `• **${r.name}**`).join('\n');
            await interaction.editReply(`✅ Processed ${results.length} new playlist(s):\n${list}`);
          }
        } catch (err) {
          await interaction.editReply(`❌ Scan failed: ${err.message}`);
        }
      }

      if (sub === 'rebuild') {
        const playlists = db.prepare('SELECT id, name FROM playlists ORDER BY name').all();
        if (!playlists.length) {
          await interaction.reply({ content: '❌ No managed playlists found.', ephemeral: true });
          return;
        }

        const options = playlists.slice(0, 25).map(p => ({
          label: p.name,
          value: String(p.id),
        }));

        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('tunecraft_rebuild_select')
            .setPlaceholder('Select a playlist to rebuild')
            .addOptions(options)
        );

        await interaction.reply({
          content: '🎵 Which playlist would you like to rebuild?',
          components: [row],
          ephemeral: true,
        });
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'tunecraft_rebuild_select') {
      const playlistId = parseInt(interaction.values[0]);
      const playlist = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId);

      await interaction.update({ content: `🔄 Rebuilding **${playlist?.name}**...`, components: [] });

      try {
        const result = await buildPlaylist(playlistId);
        await interaction.editReply(
          `✅ **${playlist?.name}** rebuilt — ${result.trackCount} tracks, ${result.similarArtistsFound} similar artists found.`
        );
      } catch (err) {
        await interaction.editReply(`❌ Rebuild failed: ${err.message}`);
      }
    }
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

function stopBot() {
  if (client) {
    client.destroy();
    client = null;
  }
}

module.exports = { startBot, stopBot, isEnabled };
