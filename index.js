
const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    WebhookClient
} = require("discord.js");

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.RELAY_OWNER_ID || "";
const PREFIX = ".relay";
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "relay-data.json");
const LEGACY_DATA_FILE = path.join(__dirname, "relay-data.json");

if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN environment variable missing!");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let db = {
    routes: [],
    roleMaps: [],
    emojiMaps: []
};

const webhookCache = new Map();

/* =========================
   DATABASE
========================= */

function loadDatabase() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

            db = {
                routes: Array.isArray(data.routes) ? data.routes : [],
                roleMaps: Array.isArray(data.roleMaps) ? data.roleMaps : [],
                emojiMaps: Array.isArray(data.emojiMaps) ? data.emojiMaps : []
            };
        }
    } catch (error) {
        console.error("Database load error:", error);
    }
}

function saveDatabase() {
    try {
        const tempFile = `${DATA_FILE}.tmp`;

        fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
        fs.renameSync(tempFile, DATA_FILE);
    } catch (error) {
        console.error("Database save error:", error);
    }
}

function migrateLegacyData() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });

        if (!fs.existsSync(DATA_FILE) && fs.existsSync(LEGACY_DATA_FILE)) {
            fs.copyFileSync(LEGACY_DATA_FILE, DATA_FILE);
            console.log(`📦 Migrated legacy data from ${LEGACY_DATA_FILE} to ${DATA_FILE}`);
        }
    } catch (error) {
        console.error("Database migration error:", error);
    }
}

migrateLegacyData();
loadDatabase();
console.log(`💾 Using data file: ${DATA_FILE}`);

/* =========================
   GENERAL HELPERS
========================= */

function isManager(message) {
    if (OWNER_ID && message.author.id === OWNER_ID) {
        return true;
    }

    return message.member?.permissions.has(
        PermissionsBitField.Flags.Administrator
    ) || false;
}

async function getTextChannel(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);

        if (!channel || !channel.isTextBased() || !channel.guild) {
            return null;
        }

        if (channel.isThread()) {
            return null;
        }

        return channel;
    } catch {
        return null;
    }
}

async function getGuild(guildId) {
    try {
        return await client.guilds.fetch(guildId);
    } catch {
        return null;
    }
}

function addRoute(sourceId, destinationId) {
    const exists = db.routes.some(
        route =>
            route.sourceId === sourceId &&
            route.destinationId === destinationId
    );

    if (exists) {
        return false;
    }

    db.routes.push({ sourceId, destinationId });
    saveDatabase();

    return true;
}

function removeRoute(sourceId, destinationId) {
    const oldLength = db.routes.length;

    db.routes = db.routes.filter(
        route =>
            !(
                route.sourceId === sourceId &&
                route.destinationId === destinationId
            )
    );

    if (db.routes.length === oldLength) {
        return false;
    }

    saveDatabase();
    return true;
}

/* =========================
   WEBHOOK
========================= */

async function getRelayWebhook(channel) {
    const cached = webhookCache.get(channel.id);

    if (cached) {
        return cached;
    }

    const webhooks = await channel.fetchWebhooks();

    let webhook = webhooks.find(
        item =>
            item.owner?.id === client.user.id &&
            item.name === "RelayX"
    );

    if (!webhook) {
        webhook = await channel.createWebhook({
            name: "RelayX",
            reason: "RelayX cross-server message forwarding"
        });
    }

    webhookCache.set(channel.id, webhook);

    return webhook;
}

/* =========================
   ROLE MAPPING
========================= */

function findRoleMap(sourceGuildId, destinationGuildId, sourceRoleId) {
    return db.roleMaps.find(
        item =>
            item.sourceGuildId === sourceGuildId &&
            item.destinationGuildId === destinationGuildId &&
            item.sourceRoleId === sourceRoleId
    );
}

async function mapRoleMentions(content, sourceGuild, destinationGuild) {
    const matches = [
        ...content.matchAll(/<@&(\d{17,20})>/g)
    ];

    for (const match of matches) {
        const sourceRoleId = match[1];
        let destinationRoleId;

        const savedMap = findRoleMap(
            sourceGuild.id,
            destinationGuild.id,
            sourceRoleId
        );

        if (savedMap) {
            destinationRoleId = savedMap.destinationRoleId;
        } else {
            try {
                const sourceRole = await sourceGuild.roles.fetch(sourceRoleId);

                if (sourceRole) {
                    const destinationRoles =
                        await destinationGuild.roles.fetch();

                    const matchingRole = destinationRoles.find(
                        role => role.name === sourceRole.name
                    );

                    if (matchingRole) {
                        destinationRoleId = matchingRole.id;
                    }
                }
            } catch {
                // Leave the original mention unchanged.
            }
        }

        if (destinationRoleId) {
            content = content.replaceAll(
                `<@&${sourceRoleId}>`,
                `<@&${destinationRoleId}>`
            );
        }
    }

    return content;
}

/* =========================
   CUSTOM EMOJI MAPPING
========================= */

function mapCustomEmojis(content, destinationGuildId) {
    const matches = [
        ...content.matchAll(/<(a?):([a-zA-Z0-9_]+):(\d{17,20})>/g)
    ];

    for (const match of matches) {
        const animated = match[1] === "a";
        const emojiName = match[2];
        const sourceEmojiId = match[3];

        const savedMap = db.emojiMaps.find(
            item =>
                item.sourceEmojiId === sourceEmojiId &&
                item.destinationGuildId === destinationGuildId
        );

        if (!savedMap) {
            continue;
        }

        const prefix = animated ? "a" : "";

        const replacement =
            `<${prefix}:${savedMap.destinationEmojiName || emojiName}:` +
            `${savedMap.destinationEmojiId}>`;

        content = content.replaceAll(match[0], replacement);
    }

    return content;
}

/* =========================
   COMMAND HANDLER
========================= */

async function handleCommand(message) {
    const args = message.content.trim().split(/\s+/);

    // .relay
    // .relay help
    const subcommand = (args[1] || "help").toLowerCase();

    if (subcommand === "help") {
        return message.reply(
            "**RelayX Commands**\n\n" +
            "` .relay add SOURCE_ID DEST_ID one `\n" +
            "Forward messages from this channel to the destination.\n\n" +
            "` .relay add SOURCE_ID DEST_ID both `\n" +
            "Forward messages in both directions.\n\n" +
            "` .relay remove SOURCE_ID DEST_ID `\n" +
            "Remove a channel connection.\n\n" +
            "` .relay list `\n" +
            "View configured connections.\n\n" +
            "` .relay rolemap add SOURCE_ROLE_ID DEST_ROLE_ID `\n" +
            "Map a source role to a destination role.\n\n" +
            "` .relay rolemap list `\n" +
            "View role mappings for this server.\n\n" +
            "` .relay rolemap remove SOURCE_ROLE_ID DEST_ROLE_ID `\n" +
            "Remove a role mapping.\n\n" +
            "` .relay emoji add DEST_GUILD_ID <:emoji:ID> `\n" +
            "Import a custom emoji into the destination server.\n\n" +
            "` .relay emoji list `\n" +
            "View imported emoji mappings.\n\n" +
            "` .relay emoji remove SOURCE_EMOJI_ID DEST_GUILD_ID `\n" +
            "Remove an emoji mapping.\n\n" +
            "Only server administrators or the configured bot owner can use these commands."
        );
    }

    if (!isManager(message)) {
        return message.reply("❌ You need Administrator permission to use this command.");
    }

    /* ADD ROUTE */

    if (subcommand === "add") {
        const sourceId = args[2];
        const destinationId = args[3];
        const mode = (args[4] || "one").toLowerCase();

        if (!sourceId || !destinationId || !["one", "both"].includes(mode)) {
            return message.reply(
                "Usage: `.relay add SOURCE_ID DEST_ID one|both`"
            );
        }

        if (sourceId === destinationId) {
            return message.reply("❌ Source and destination cannot be the same channel.");
        }

        const sourceChannel = await getTextChannel(sourceId);
        const destinationChannel = await getTextChannel(destinationId);

        if (!sourceChannel || !destinationChannel) {
            return message.reply(
                "❌ I couldn't access one of those channels. Check the IDs and bot permissions."
            );
        }

        if (sourceChannel.guild.id !== message.guild.id) {
            return message.reply(
                "❌ The source channel must belong to this server."
            );
        }

        const added = addRoute(sourceId, destinationId);

        if (!added) {
            return message.reply("⚠️ That connection already exists.");
        }

        let reply =
            `✅ Relay connection created!\n` +
            `Source: <#${sourceId}>\n` +
            `Destination: <#${destinationId}>`;

        if (mode === "both") {
            addRoute(destinationId, sourceId);
            reply += "\n🔁 Two-way forwarding enabled.";
        }

        return message.reply(reply);
    }

    /* REMOVE ROUTE */

    if (subcommand === "remove") {
        const sourceId = args[2];
        const destinationId = args[3];

        if (!sourceId || !destinationId) {
            return message.reply(
                "Usage: `.relay remove SOURCE_ID DEST_ID`"
            );
        }

        const sourceChannel = await getTextChannel(sourceId);

        if (!sourceChannel || sourceChannel.guild.id !== message.guild.id) {
            return message.reply(
                "❌ The source channel must belong to this server and be accessible."
            );
        }

        const removed = removeRoute(sourceId, destinationId);

        if (!removed) {
            return message.reply("⚠️ That connection wasn't found.");
        }

        return message.reply("✅ Relay connection removed.");
    }

    /* LIST ROUTES */

    if (subcommand === "list") {
        const routes = db.routes.filter(route => {
            return route.sourceId && route.destinationId;
        });

        if (!routes.length) {
            return message.reply("No relay connections are configured.");
        }

        const lines = routes.map((route, index) => {
            return (
                `**${index + 1}.** <#${route.sourceId}> → ` +
                `<#${route.destinationId}>`
            );
        });

        return message.reply({
            content: `**RelayX Connections**\n\n${lines.join("\n")}`.slice(0, 1900)
        });
    }

    /* ROLE MAP COMMANDS */

    if (subcommand === "rolemap") {
        const action = (args[2] || "").toLowerCase();

        if (action === "add") {
            const sourceRoleId = args[3];
            const destinationRoleId = args[4];

            if (!sourceRoleId || !destinationRoleId) {
                return message.reply(
                    "Usage: `.relay rolemap add SOURCE_ROLE_ID DEST_ROLE_ID`"
                );
            }

            let sourceRole;

            try {
                sourceRole = await message.guild.roles.fetch(sourceRoleId);
            } catch {
                sourceRole = null;
            }

            if (!sourceRole) {
                return message.reply(
                    "❌ Source role not found in this server."
                );
            }

            let destinationRole = null;
            let destinationGuild = null;

            for (const guild of client.guilds.cache.values()) {
                try {
                    const role = await guild.roles.fetch(destinationRoleId);

                    if (role) {
                        destinationRole = role;
                        destinationGuild = guild;
                        break;
                    }
                } catch {
                    // Continue checking accessible guilds.
                }
            }

            if (!destinationRole || !destinationGuild) {
                return message.reply(
                    "❌ Destination role not found. Ensure the bot is in the destination server."
                );
            }

            const existingIndex = db.roleMaps.findIndex(
                item =>
                    item.sourceGuildId === message.guild.id &&
                    item.destinationGuildId === destinationGuild.id &&
                    item.sourceRoleId === sourceRoleId
            );

            const roleMap = {
                sourceGuildId: message.guild.id,
                destinationGuildId: destinationGuild.id,
                sourceRoleId,
                destinationRoleId
            };

            if (existingIndex !== -1) {
                db.roleMaps[existingIndex] = roleMap;
            } else {
                db.roleMaps.push(roleMap);
            }

            saveDatabase();

            return message.reply(
                `✅ Role mapping saved:\n` +
                `**${sourceRole.name}** → **${destinationRole.name}**\n` +
                `Destination server: **${destinationGuild.name}**`
            );
        }

        if (action === "list") {
            const maps = db.roleMaps.filter(
                item => item.sourceGuildId === message.guild.id
            );

            if (!maps.length) {
                return message.reply("No role mappings found for this server.");
            }

            const lines = maps.map(item =>
                `<@&${item.sourceRoleId}> → <@&${item.destinationRoleId}>`
            );

            return message.reply(
                `**Role Mappings**\n${lines.join("\n")}`.slice(0, 1900)
            );
        }

        if (action === "remove") {
            const sourceRoleId = args[3];
            const destinationRoleId = args[4];

            if (!sourceRoleId || !destinationRoleId) {
                return message.reply(
                    "Usage: `.relay rolemap remove SOURCE_ROLE_ID DEST_ROLE_ID`"
                );
            }

            const oldLength = db.roleMaps.length;

            db.roleMaps = db.roleMaps.filter(
                item =>
                    !(
                        item.sourceGuildId === message.guild.id &&
                        item.sourceRoleId === sourceRoleId &&
                        item.destinationRoleId === destinationRoleId
                    )
            );

            if (db.roleMaps.length === oldLength) {
                return message.reply("⚠️ Role mapping not found.");
            }

            saveDatabase();

            return message.reply("✅ Role mapping removed.");
        }

        return message.reply(
            "Use `.relay rolemap add`, `.relay rolemap list`, or `.relay rolemap remove`."
        );
    }

    /* EMOJI COMMANDS */

    if (subcommand === "emoji") {
        const action = (args[2] || "").toLowerCase();

        if (action === "add") {
            const destinationGuildId = args[3];
            const emojiInput = args[4];

            if (!destinationGuildId || !emojiInput) {
                return message.reply(
                    "Usage: `.relay emoji add DEST_GUILD_ID <:emoji:EMOJI_ID>`"
                );
            }

            const match = emojiInput.match(
                /^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/
            );

            if (!match) {
                return message.reply(
                    "❌ Provide a valid custom emoji, such as `<:name:123456789012345678>`."
                );
            }

            const animated = match[1] === "a";
            const emojiName = match[2];
            const sourceEmojiId = match[3];

            const destinationGuild = await getGuild(destinationGuildId);

            if (!destinationGuild) {
                return message.reply(
                    "❌ Destination server not found or the bot isn't in it."
                );
            }

            if (!destinationGuild.members.me?.permissions.has(
                PermissionsBitField.Flags.ManageGuildExpressions
            )) {
                return message.reply(
                    "❌ I need the **Manage Expressions** permission in the destination server."
                );
            }

            const existing = db.emojiMaps.find(
                item =>
                    item.sourceEmojiId === sourceEmojiId &&
                    item.destinationGuildId === destinationGuildId
            );

            if (existing) {
                return message.reply("⚠️ This emoji is already mapped.");
            }

            try {
                const extension = animated ? "gif" : "png";
                const imageURL =
                    `https://cdn.discordapp.com/emojis/${sourceEmojiId}.${extension}?size=128&quality=lossless`;

                const response = await fetch(imageURL);

                if (!response.ok) {
                    return message.reply(
                        "❌ Couldn't download that emoji. Check the emoji ID."
                    );
                }

                const buffer = Buffer.from(await response.arrayBuffer());

                const createdEmoji = await destinationGuild.emojis.create({
                    attachment: buffer,
                    name: emojiName,
                    reason: "Imported by RelayX"
                });

                db.emojiMaps.push({
                    sourceEmojiId,
                    destinationGuildId,
                    destinationEmojiId: createdEmoji.id,
                    destinationEmojiName: createdEmoji.name
                });

                saveDatabase();

                return message.reply(
                    `✅ Emoji imported: ${createdEmoji.toString()}\n` +
                    `Destination: **${destinationGuild.name}**`
                );
            } catch (error) {
                console.error("Emoji import error:", error);

                return message.reply(
                    "❌ Emoji import failed. Check permissions, emoji limits, and the bot logs."
                );
            }
        }

        if (action === "list") {
            const maps = db.emojiMaps.filter(item => {
                return db.routes.some(route => {
                    return route.sourceId &&
                        route.destinationId &&
                        route.destinationId.length > 0;
                });
            });

            if (!maps.length) {
                return message.reply("No emoji mappings found.");
            }

            const lines = maps.map(item =>
                `Source ID: \`${item.sourceEmojiId}\` → ` +
                `<:${item.destinationEmojiName}:${item.destinationEmojiId}> ` +
                `(Server ID: \`${item.destinationGuildId}\`)`
            );

            return message.reply(
                `**Emoji Mappings**\n${lines.join("\n")}`.slice(0, 1900)
            );
        }

        if (action === "remove") {
            const sourceEmojiId = args[3];
            const destinationGuildId = args[4];

            if (!sourceEmojiId || !destinationGuildId) {
                return message.reply(
                    "Usage: `.relay emoji remove SOURCE_EMOJI_ID DEST_GUILD_ID`"
                );
            }

            const oldLength = db.emojiMaps.length;

            db.emojiMaps = db.emojiMaps.filter(
                item =>
                    !(
                        item.sourceEmojiId === sourceEmojiId &&
                        item.destinationGuildId === destinationGuildId
                    )
            );

            if (db.emojiMaps.length === oldLength) {
                return message.reply("⚠️ Emoji mapping not found.");
            }

            saveDatabase();

            return message.reply("✅ Emoji mapping removed.");
        }

        return message.reply(
            "Use `.relay emoji add`, `.relay emoji list`, or `.relay emoji remove`."
        );
    }

    return message.reply(
        "Unknown command. Use `.relay help`."
    );
}

/* =========================
   MESSAGE FORWARDING
========================= */

client.on("messageCreate", async message => {
    try {
        // Ignore DMs, bot messages, and webhook messages.
        if (!message.guild || message.author.bot || message.webhookId) {
            return;
        }

        // Process bot commands.
        if (message.content.trim().toLowerCase().startsWith(PREFIX)) {
            await handleCommand(message);
            return;
        }

        const routes = db.routes.filter(
            route => route.sourceId === message.channel.id
        );

        if (!routes.length) {
            return;
        }

        for (const route of routes) {
            const destination = await getTextChannel(route.destinationId);

            if (!destination) {
                console.error(
                    `RelayX: destination channel unavailable: ${route.destinationId}`
                );
                continue;
            }

            try {
                let content = message.content || "";

                // Map role mentions into the destination server.
                content = await mapRoleMentions(
                    content,
                    message.guild,
                    destination.guild
                );

                // Replace imported custom emoji IDs.
                content = mapCustomEmojis(
                    content,
                    destination.guild.id
                );

                /*
                 * USER MENTION FIX:
                 * Only allow notifications for user IDs that actually
                 * belong to the destination server.
                 *
                 * Discord user IDs are global. If the same user belongs
                 * to both servers, their mention ID remains the same.
                 */
                const userMentionMatches = [
                    ...content.matchAll(/<@!?(\d{17,20})>/g)
                ];

                const allowedUserIds = [];

                for (const match of userMentionMatches) {
                    const userId = match[1];

                    if (allowedUserIds.includes(userId)) {
                        continue;
                    }

                    try {
                        const member = await destination.guild.members.fetch(
                            userId
                        );

                        if (member) {
                            allowedUserIds.push(userId);
                        }
                    } catch {
                        // Don't notify users who aren't in the destination server.
                    }
                }

                /*
                 * Allow mapped destination roles to notify too.
                 * Unmapped roles are not explicitly allowed.
                 */
                const roleMentionMatches = [
                    ...content.matchAll(/<@&(\d{17,20})>/g)
                ];

                const allowedRoleIds = [];

                for (const match of roleMentionMatches) {
                    const roleId = match[1];

                    if (allowedRoleIds.includes(roleId)) {
                        continue;
                    }

                    try {
                        const role = await destination.guild.roles.fetch(roleId);

                        if (role) {
                            allowedRoleIds.push(roleId);
                        }
                    } catch {
                        // Ignore roles that don't exist in the destination.
                    }
                }

                // Forward attachments.
                const files = [...message.attachments.values()].map(file => ({
                    attachment: file.url,
                    name: file.name || "attachment"
                }));

                // Forward embeds from links normally as text previews.
                const webhook = await getRelayWebhook(destination);

                const webhookOptions = {
                    content: content || undefined,
                    username: (
                        message.member?.displayName ||
                        message.author.globalName ||
                        message.author.username
                    ).slice(0, 80),
                    avatarURL: message.author.displayAvatarURL({
                        extension: "png",
                        size: 256
                    }),
                    files,
                    allowedMentions: {
                        parse: [],
                        users: allowedUserIds,
                        roles: allowedRoleIds,
                        repliedUser: false
                    }
                };

                // Keep empty messages with attachments working.
                if (!webhookOptions.content && files.length === 0) {
                    continue;
                }

                await webhook.send(webhookOptions);

            } catch (error) {
                console.error(
                    `RelayX forwarding error for destination ${route.destinationId}:`,
                    error
                );

                webhookCache.delete(route.destinationId);
            }
        }
    } catch (error) {
        console.error("RelayX message handler error:", error);
    }
});

/* =========================
   START BOT
========================= */

client.once("clientReady", () => {
    console.log(`✅ RelayX is online as ${client.user.tag}`);
    console.log(`📡 Loaded ${db.routes.length} relay routes.`);
    console.log(`🎭 Loaded ${db.roleMaps.length} role mappings.`);
    console.log(`😀 Loaded ${db.emojiMaps.length} emoji mappings.`);
});

client.login(TOKEN).catch(error => {
    console.error("❌ RelayX login failed:", error);
});
