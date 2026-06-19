import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TOKEN    = process.env.BOT_TOKEN;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "autodelete.json");

// ── Persistence ───────────────────────────────────────────────
function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return { channels: {}, excluded: [] };
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();
if (!data.excluded) { data.excluded = []; saveData(data); }

// ── Client ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Slot limiter ──────────────────────────────────────────────
const MAX_CONCURRENT = 50;
let running = 0;
const waitQueue = [];
function acquireSlot() {
  return new Promise(resolve => {
    if (running < MAX_CONCURRENT) { running++; resolve(); }
    else waitQueue.push(resolve);
  });
}
function releaseSlot() {
  if (waitQueue.length > 0) waitQueue.shift()();
  else running--;
}

// ── Duration parser ───────────────────────────────────────────
const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  return parseInt(match[1]) * UNITS[match[2].toLowerCase()];
}
function fmtDuration(ms) {
  if (ms >= 86400000) return `${ms / 86400000}d`;
  if (ms >= 3600000)  return `${ms / 3600000}h`;
  if (ms >= 60000)    return `${ms / 60000}m`;
  return `${ms / 1000}s`;
}

// ── Slash commands ────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("autodelete")
    .setDescription("Manage auto-delete for channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName("set")
      .setDescription("Set a channel to auto-delete messages after a time")
      .addChannelOption(opt => opt.setName("channel").setDescription("The channel").setRequired(true))
      .addStringOption(opt => opt.setName("time").setDescription("How long to keep messages e.g. 5m, 1h, 24h").setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName("remove")
      .setDescription("Stop auto-deleting messages in a channel")
      .addChannelOption(opt => opt.setName("channel").setDescription("The channel").setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName("list")
      .setDescription("List all channels with auto-delete enabled")
    )
    .addSubcommand(sub => sub
      .setName("exclude")
      .setDescription("Exclude a channel from member-leave deletions")
      .addChannelOption(opt => opt.setName("channel").setDescription("The channel to protect").setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName("unexclude")
      .setDescription("Remove a channel from the exclusion list")
      .addChannelOption(opt => opt.setName("channel").setDescription("The channel to unprotect").setRequired(true))
    ),
].map(c => c.toJSON());

// ── Ready ─────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Auto-deleting messages", { type: 0 });

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("Slash commands registered.");
});

// ── Slash command handler ─────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "autodelete") return;

  const sub = interaction.options.getSubcommand();

  if (sub === "set") {
    const channel = interaction.options.getChannel("channel");
    const timeStr = interaction.options.getString("time");
    const delayMs = parseDuration(timeStr);
    if (!delayMs) return interaction.reply({ content: "❌ Invalid time format. Use `5m`, `1h`, `24h`, `7d` etc.", ephemeral: true });
    if (delayMs < 5000) return interaction.reply({ content: "❌ Minimum time is 5 seconds.", ephemeral: true });
    data.channels[channel.id] = { guildId: interaction.guild.id, delayMs };
    saveData(data);
    return interaction.reply(`✅ Auto-delete enabled in <#${channel.id}> — messages will be deleted after **${fmtDuration(delayMs)}**.`);
  }

  if (sub === "remove") {
    const channel = interaction.options.getChannel("channel");
    if (!data.channels[channel.id]) return interaction.reply({ content: `❌ Auto-delete is not set for <#${channel.id}>.`, ephemeral: true });
    delete data.channels[channel.id];
    saveData(data);
    return interaction.reply(`✅ Auto-delete removed from <#${channel.id}>.`);
  }

  if (sub === "list") {
    const entries = Object.entries(data.channels).filter(([, v]) => v.guildId === interaction.guild.id);
    if (entries.length === 0) return interaction.reply({ content: "No channels have auto-delete enabled.", ephemeral: true });
    const list = entries.map(([id, v]) => `<#${id}> — **${fmtDuration(v.delayMs)}**`).join("\n");
    return interaction.reply({ content: `**Auto-delete channels:**\n${list}`, ephemeral: true });
  }

  if (sub === "exclude") {
    const channel = interaction.options.getChannel("channel");
    if (data.excluded.includes(channel.id)) return interaction.reply({ content: `❌ <#${channel.id}> is already excluded.`, ephemeral: true });
    data.excluded.push(channel.id);
    saveData(data);
    return interaction.reply(`✅ <#${channel.id}> is now excluded — messages there will never be deleted when a member leaves.`);
  }

  if (sub === "unexclude") {
    const channel = interaction.options.getChannel("channel");
    if (!data.excluded.includes(channel.id)) return interaction.reply({ content: `❌ <#${channel.id}> is not in the exclusion list.`, ephemeral: true });
    data.excluded = data.excluded.filter(id => id !== channel.id);
    saveData(data);
    return interaction.reply(`✅ <#${channel.id}> removed from exclusion list.`);
  }
});

// ── Timed message auto-delete ─────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const config = data.channels[message.channel.id];
  if (!config) return;
  setTimeout(async () => {
    await message.delete().catch(() => {});
  }, config.delayMs);
});

// ── Member leave — delete all their messages ──────────────────
client.on("guildMemberRemove", async (member) => {
  await acquireSlot();
  try {
    const channels = member.guild.channels.cache.filter(c => c.isTextBased() && !data.excluded.includes(c.id));
    let totalDeleted = 0;
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

    for (const channel of channels.values()) {
      try {
        let channelDeleted = 0;
        let lastId = undefined;
        while (true) {
          const fetched = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
          if (fetched.size === 0) break;
          const userMsgs = fetched.filter(m => m.author.id === member.user.id);
          if (userMsgs.size > 0) {
            const now    = Date.now();
            const recent = userMsgs.filter(m => now - m.createdTimestamp < TWO_WEEKS);
            const old    = userMsgs.filter(m => now - m.createdTimestamp >= TWO_WEEKS);
            if (recent.size === 1) { await recent.first().delete().catch(() => {}); channelDeleted++; }
            else if (recent.size > 1) { const d = await channel.bulkDelete(recent, true).catch(() => null); channelDeleted += d?.size ?? 0; }
            for (const msg of old.values()) {
              await msg.delete().catch(() => {});
              await new Promise(r => setTimeout(r, 1000));
              channelDeleted++;
            }
          }
          if (fetched.size < 100) break;
          lastId = fetched.last().id;
        }
        if (channelDeleted > 0) { totalDeleted += channelDeleted; console.log(`#${channel.name} — ${channelDeleted} deleted`); }
      } catch { /* skip inaccessible channels */ }
    }
    console.log(`Total: ${totalDeleted} messages deleted for ${member.user.tag}`);
  } finally {
    releaseSlot();
  }
});

process.on("unhandledRejection", err => console.error("[Unhandled Rejection]", err));
process.on("uncaughtException",  err => console.error("[Uncaught Exception]", err));

client.login(TOKEN);
