import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TOKEN = process.env.BOT_TOKEN;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(__dirname, "autodelete.json");

let config = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : { channels: {} };

function save() {
  fs.writeFileSync(dataFile, JSON.stringify(config, null, 2));
}

function parseTime(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(match[1]) * units[match[2].toLowerCase()];
}

function formatTime(ms) {
  if (ms >= 86400000) return `${ms / 86400000}d`;
  if (ms >= 3600000) return `${ms / 3600000}h`;
  if (ms >= 60000) return `${ms / 60000}m`;
  return `${ms / 1000}s`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let running = 0;
const queue = [];

function getSlot() {
  return new Promise(resolve => {
    if (running < 50) { running++; resolve(); }
    else queue.push(resolve);
  });
}

function freeSlot() {
  if (queue.length > 0) queue.shift()();
  else running--;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("autodelete")
      .setDescription("Set up auto-delete for a channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(s => s.setName("set").setDescription("Enable auto-delete in a channel")
        .addChannelOption(o => o.setName("channel").setDescription("Channel").setRequired(true))
        .addStringOption(o => o.setName("time").setDescription("Time e.g. 5m 1h 24h").setRequired(true)))
      .addSubcommand(s => s.setName("remove").setDescription("Disable auto-delete in a channel")
        .addChannelOption(o => o.setName("channel").setDescription("Channel").setRequired(true)))
      .addSubcommand(s => s.setName("list").setDescription("Show all auto-delete channels")),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("Commands registered");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "autodelete") return;

  const sub = interaction.options.getSubcommand();
  const channel = interaction.options.getChannel("channel");

  if (sub === "set") {
    const ms = parseTime(interaction.options.getString("time"));
    if (!ms) return interaction.reply({ content: "Invalid time format. Try 5m, 1h, 24h, 7d", ephemeral: true });
    config.channels[channel.id] = { guildId: interaction.guild.id, ms };
    save();
    return interaction.reply(`Auto-delete enabled in <#${channel.id}> — messages will be deleted after **${formatTime(ms)}**.`);
  }

  if (sub === "remove") {
    if (!config.channels[channel.id]) return interaction.reply({ content: "That channel doesn't have auto-delete set.", ephemeral: true });
    delete config.channels[channel.id];
    save();
    return interaction.reply(`Auto-delete disabled in <#${channel.id}>.`);
  }

  if (sub === "list") {
    const list = Object.entries(config.channels).filter(([, v]) => v.guildId === interaction.guild.id);
    if (!list.length) return interaction.reply({ content: "No channels set up.", ephemeral: true });
    return interaction.reply({ content: list.map(([id, v]) => `<#${id}> — ${formatTime(v.ms)}`).join("\n"), ephemeral: true });
  }
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  const ch = config.channels[message.channel.id];
  if (!ch) return;
  setTimeout(() => message.delete().catch(() => {}), ch.ms);
});

client.on("guildMemberRemove", async (member) => {
  await getSlot();
  try {
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
    for (const channel of member.guild.channels.cache.filter(c => c.isTextBased()).values()) {
      try {
        let lastId;
        while (true) {
          const msgs = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
          if (!msgs.size) break;
          const mine = msgs.filter(m => m.author.id === member.user.id);
          const recent = mine.filter(m => Date.now() - m.createdTimestamp < TWO_WEEKS);
          const old = mine.filter(m => Date.now() - m.createdTimestamp >= TWO_WEEKS);
          if (recent.size === 1) await recent.first().delete().catch(() => {});
          else if (recent.size > 1) await channel.bulkDelete(recent, true).catch(() => {});
          for (const msg of old.values()) { await msg.delete().catch(() => {}); await new Promise(r => setTimeout(r, 1000)); }
          if (msgs.size < 100) break;
          lastId = msgs.last().id;
        }
      } catch {}
    }
  } finally {
    freeSlot();
  }
});

process.on("unhandledRejection", err => console.error(err));
process.on("uncaughtException", err => console.error(err));

client.login(TOKEN);
