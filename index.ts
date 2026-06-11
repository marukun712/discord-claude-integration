import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	BaseGuildTextChannel,
	Client,
	GatewayIntentBits,
	REST,
	Routes,
	SlashCommandBuilder,
	type ThreadChannel,
} from "discord.js";

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`missing env: ${key}`);
	return val;
}

const DISCORD_TOKEN = requireEnv("DISCORD_TOKEN");
const CLIENT_ID = requireEnv("DISCORD_CLIENT_ID");
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const WORK_DIR = process.env.WORK_DIR ?? process.cwd();

const SESSION_PREFIX = "cc-session:";
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

const sessionCache = new Map<string, string | null>();

async function resolveSession(thread: ThreadChannel): Promise<string | null> {
	if (sessionCache.has(thread.id)) return sessionCache.get(thread.id) ?? null;

	const msgs = await thread.messages.fetch({
		limit: 5,
		after: (BigInt(thread.id) - 1n).toString(),
	});
	const marker = [...msgs.values()].find(
		(m) => m.author.bot && m.content.startsWith(SESSION_PREFIX),
	);
	const id = marker?.content.slice(SESSION_PREFIX.length).trim() ?? null;

	sessionCache.set(thread.id, id);
	return id;
}

async function runCC(prompt: string, sessionId: string | null) {
	let result = "";
	let sid = sessionId;

	for await (const msg of query({
		prompt,
		options: {
			cwd: WORK_DIR,
			model: "claude-sonnet-4-6",
			maxTurns: 50,
			permissionMode: "acceptEdits",

			allowedTools: [
				"Read",
				"Write",
				"Edit",
				"Bash",
				"Glob",
				"Grep",
				"WebSearch",
				"WebFetch",
			],

			settings: { permissions: { allow: ["Bash(git *)"] } },
			...(sessionId ? { resume: sessionId } : {}),
		},
	})) {
		if (msg.type === "result") {
			sid = msg.session_id;
			if (msg.subtype === "success") result = msg.result;
		}
	}

	return { result, sessionId: sid };
}

function splitText(text: string): string[] {
	return Array.from(
		{ length: Math.ceil(text.length / DISCORD_MAX_MESSAGE_LENGTH) },
		(_, i) =>
			text.slice(
				i * DISCORD_MAX_MESSAGE_LENGTH,
				(i + 1) * DISCORD_MAX_MESSAGE_LENGTH,
			),
	);
}

client.once("clientReady", async (c) => {
	console.log(`ready: ${c.user.tag}`);

	const cmd = new SlashCommandBuilder()
		.setName("cc")
		.setDescription("Claude Code thread")
		.addStringOption((o) =>
			o.setName("title").setDescription("thread title").setRequired(true),
		)
		.addStringOption((o) =>
			o
				.setName("prompt")
				.setDescription("initial prompt (defaults to title)")
				.setRequired(false),
		)
		.toJSON();

	const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
	const route = GUILD_ID
		? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
		: Routes.applicationCommands(CLIENT_ID);
	await rest.put(route, { body: [cmd] });
	console.log("slash command registered");
});

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isChatInputCommand() || interaction.commandName !== "cc")
		return;

	await interaction.deferReply();
	const title = interaction.options.getString("title", true);
	const prompt = interaction.options.getString("prompt") ?? title;

	try {
		const { result, sessionId } = await runCC(prompt, null);
		if (!sessionId) throw new Error("no session id returned");

		const channel = interaction.channel;
		if (!(channel instanceof BaseGuildTextChannel)) {
			await interaction.editReply(
				"this command only works in server text channels",
			);
			return;
		}

		const thread = await channel.threads.create({
			name: title,
			autoArchiveDuration: 1440,
		});

		await thread.send(`${SESSION_PREFIX}${sessionId}`);
		for (const chunk of splitText(result || "session started"))
			await thread.send(chunk);

		sessionCache.set(thread.id, sessionId);
		await interaction.editReply(`thread: ${thread}`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(e);
		await interaction.editReply(`error: ${msg}`);
	}
});

client.on("messageCreate", async (message) => {
	if (message.author.bot || !message.channel.isThread()) return;

	const sessionId = await resolveSession(message.channel as ThreadChannel);
	if (!sessionId) return;

	const typing = setInterval(() => message.channel.sendTyping(), 8000);
	message.channel.sendTyping();

	try {
		const { result, sessionId: newId } = await runCC(
			message.content,
			sessionId,
		);
		clearInterval(typing);

		if (newId && newId !== sessionId)
			sessionCache.set(message.channel.id, newId);

		const [first, ...rest] = splitText(result || "(no response)");
		await message.reply(first ?? "(no response)");
		for (const part of rest) await message.channel.send(part);
	} catch (e) {
		clearInterval(typing);
		const msg = e instanceof Error ? e.message : String(e);
		console.error(e);
		await message.reply(`error: ${msg}`);
	}
});

client.login(DISCORD_TOKEN);
