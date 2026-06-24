import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TOKEN    = process.env.BOT_TOKEN;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "autodelete.json");

function loadData() {
  if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  return { excluded: [] };
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();
if (!data.excluded) { data.excluded = []; saveData(data); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

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

const commands = [
  new SlashCommandBuilder()
    .setName("autodelete")
    .setDescription("Manage auto-delete settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName("exclude")
      .setDescription("Exclude a channel from member-leave deletions")
      .addChannelOption(opt => opt.setName("channel").setDescription("The channel to protect").setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName("unexclude")
      .setDescription("Remove a channel from the exclusion list")
      .addChannelOption(opt => opt.setName("channel").setDescription("The channel to unprotect").setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName("list")
      .setDescription("List all excluded channels")
    ),
].map(c => c.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity("Auto-deleting messages", { type: 0 });
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("Slash commands registered.");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "autodelete") return;
  const sub = interaction.options.getSubcommand();

  if (sub === "exclude") {
    const channel = interaction.options.getChannel("channel");
    if (data.excluded.includes(channel.id)) return interaction.reply({ content: `❌ <#${channel.id}> is already excluded.`, flags: 64 });
    data.excluded.push(channel.id);
    saveData(data);
    return interaction.reply({ content: `✅ <#${channel.id}> is now excluded — messages there will never be deleted when a member leaves.`, flags: 64 });
  }

  if (sub === "unexclude") {
    const channel = interaction.options.getChannel("channel");
    if (!data.excluded.includes(channel.id)) return interaction.reply({ content: `❌ <#${channel.id}> is not in the exclusion list.`, flags: 64 });
    data.excluded = data.excluded.filter(id => id !== channel.id);
    saveData(data);
    return interaction.reply({ content: `✅ <#${channel.id}> removed from exclusion list.`, flags: 64 });
  }

  if (sub === "list") {
    if (data.excluded.length === 0) return interaction.reply({ content: "No channels are currently excluded.", flags: 64 });
    const list = data.excluded.map(id => `<#${id}>`).join("\n");
    return interaction.reply({ content: `**Excluded channels:**\n${list}`, flags: 64 });
  }
});

client.on("guildMemberRemove", async (member) => {
  const userId = member.user?.id ?? member.id;
  const userTag = member.user?.tag ?? userId;
  console.log(`[guildMemberRemove] ${userTag} left/was banned`);

  if (!userId) { console.log("Could not resolve user ID, skipping."); return; }

  await acquireSlot();
  try {
    const allChannels = await member.guild.channels.fetch();
    const channels = allChannels.filter(c => c && c.isTextBased() && !data.excluded.includes(c.id));
    console.log(`Scanning ${channels.size} channels for messages from ${userTag}...`);
    let totalDeleted = 0;
    const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

    for (const channel of channels.values()) {
      try {
        let channelDeleted = 0;
        let lastId = undefined;

        while (true) {
          const fetched = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
          if (fetched.size === 0) break;

          const userMsgs = fetched.filter(m => m.author.id === userId);
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
      } catch (err) { console.log(`Skipped #${channel.name}: ${err.message}`); }
    }
    console.log(`Total: ${totalDeleted} messages deleted for ${userTag}`);
  } finally {
    releaseSlot();
  }
});

process.on("unhandledRejection", err => console.error("[Unhandled Rejection]", err));
process.on("uncaughtException",  err => console.error("[Uncaught Exception]", err));

client.login(TOKEN);
