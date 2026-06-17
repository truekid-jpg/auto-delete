import { Client, GatewayIntentBits } from "discord.js";
const Token = process.env.BOT_TOKEN;
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});
const MAX_CONCURRENT = 50;
const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
let running = 0;
const waitQueue = [];
function acquireSlot() {
    return new Promise(resolve => {
        if (running < MAX_CONCURRENT) { running++; resolve(); }
        else { waitQueue.push(resolve); }
    });
}
function releaseSlot() {
    if (waitQueue.length > 0) { waitQueue.shift()(); }
    else { running--; }
}
async function deleteFromChannel(channel, userId) {
    let deleted = 0;
    let lastId = undefined;
    while (true) {
        const fetched = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        if (fetched.size === 0) break;
        const userMsgs = fetched.filter(m => m.author.id === userId);
        if (userMsgs.size > 0) {
            const now = Date.now();
            const recent = userMsgs.filter(m => now - m.createdTimestamp < TWO_WEEKS);
            const old = userMsgs.filter(m => now - m.createdTimestamp >= TWO_WEEKS);
            if (recent.size === 1) { await recent.first().delete().catch(() => {}); deleted++; }
            else if (recent.size > 1) { const r = await channel.bulkDelete(recent, true).catch(() => null); deleted += r?.size ?? 0; }
            for (const msg of old.values()) { await msg.delete().catch(() => {}); await new Promise(r => setTimeout(r, 1000)); deleted++; }
        }
        if (fetched.size < 100) break;
        lastId = fetched.last().id;
    }
    return deleted;
}
client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity("You leave, your messages will be deleted", { type: 0 });
});
client.on("guildMemberRemove", async (member) => {
    await acquireSlot();
    try {
        const channels = member.guild.channels.cache.filter(c => c.isTextBased());
        let totalDeleted = 0;
        for (const channel of channels.values()) {
            try {
                const count = await deleteFromChannel(channel, member.user.id);
                if (count > 0) { totalDeleted += count; console.log(`#${channel.name} - ${count} deleted`); }
            } catch { /* skip channels bot can't access */ }
        }
        console.log(`Total: ${totalDeleted} messages deleted for ${member.user.tag}`);
    } finally {
        releaseSlot();
    }
});
process.on("unhandledRejection", err => console.error("[Unhandled Rejection]", err));
process.on("uncaughtException", err => console.error("[Uncaught Exception]", err));
client.login(Token);