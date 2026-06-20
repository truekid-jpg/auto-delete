import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TOKEN = process.env.BOT_TOKEN;
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

let running = 0;
const waitQueue = [];
function acquireSlot() {
  return new Promise(resolve => {
    if (running < 50) { running++; resolve(); }
    else waitQueue.push(resolve);
  });
}
function releaseSlot() {
  if (waitQueue.length > 0) waitQueue.shift()();
  else running--;
}

const excludeCmd = new SlashCommandBuilder();
excludeCmd.setName("autodelete");
excludeCmd.setDescription("Manage auto-delete settings");
excludeCmd.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
excludeCmd.addSubcommand(sub => {
  sub.setName("exclude");
  sub.setDescription("Exclude a channel from member-leave deletions");
  sub.addChannelOption(opt => { opt.setName("channel"); opt.setDescription("The channel to protect"); opt.setRequired(true); return opt; });
  return sub;
});
excludeCmd.addSubcommand(sub => {
  sub.setName("unexclude");
  sub.setDescription("Remove a channel from the exclusion list");
  sub.addChannelOption(opt => { opt.setName("channel"); opt.setDescription("The channel to unprotect"); opt.setRequired(true); return opt; });
  return sub;
});
excludeCmd.addSubcommand(sub => {
  sub.setName("list");
  sub.setDescription("List all excluded channels");
  return sub;
});

const commands = [excludeCmd.toJSON()];

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
  const channel = interaction.options.getChannel("channel");

  if (sub === "exclude") {
    if (data.excluded.includes(channel.id)) return interaction.reply({ content: `❌ <#${channel.id}> is already excluded.`, ephemeral: true });
    data.excluded.push(channel.id);
    saveData(data);
    return interaction.reply(`✅ <#${channel.id}> is now excluded — messages there will never be deleted when a member leaves.`);
  }

  if (sub === "unexclude") {
    if (!data.excluded.includes(channel.id)) return interaction.reply({ content: `❌ <#${channel.id}> is not in the exclusion list.`, ephemeral: true });
    data.excluded = data.excluded.filter(id => id !== channel.id);
    saveData(data);
    return interaction.reply(`✅ <#${channel.id}> removed from exclusion list.`);
  }

  if (sub === "list") {
    if (data.excluded.length === 0) return interaction.reply({ content: "No channels are currently excluded.", ephemeral: true });
    const list = data.excluded.map(id => `<#${id}>`).join("\n");
    return interaction.reply({ content: `**Excluded channels:**\n${list}`, ephemeral: true });
  }
});

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
            const now = Date.now();
            const recent = userMsgs.filter(m => now - m.createdTimestamp < TWO_WEEKS);
            const old = userMsgs.filter(m => now - m.createdTimestamp >= TWO_WEEKS);
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
      } catch {}
    }
    console.log(`Total: ${totalDeleted} messages deleted for ${member.user.tag}`);
  } finally {
    releaseSlot();
  }
});

process.on("unhandledRejection", err => console.error("[Unhandled Rejection]", err));
process.on("uncaughtException", err => console.error("[Uncaught Exception]", err));

client.login(TOKEN);
