import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
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
// GUILD_IDが未設定の場合はグローバルコマンドとして登録する(後述)
const GUILD_ID = process.env.DISCORD_GUILD_ID;
// WORK_DIRはClaude Codeが操作するディレクトリ。未指定ならbotの起動ディレクトリになる
const WORK_DIR = process.env.WORK_DIR ?? process.cwd();

// スレッドの1件目に、cc-session:UUIDという形でメッセージがあるDiscordスレッドを該当Claude Codeスレッドと自動リンクする。
// 複雑な管理機構を持たないようにする
const SESSION_PREFIX = "cc-session:";
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// MessageContentはメッセージ本文を読むために必要。これがないとcontent=""になる
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

// スレッドIDをキーにセッションIDをキャッシュする。
// これがないとメッセージのたびにDiscord APIを叩いてスレッド履歴を取得することになる
const sessionCache = new Map<string, string | null>();

// スレッドの先頭ボットメッセージからセッションIDを探す。
// セッションIDはスレッド作成時に埋め込んであり、これによりスレッドとClaudeの会話履歴が紐付く
async function resolveSession(thread: ThreadChannel): Promise<string | null> {
	if (sessionCache.has(thread.id)) return sessionCache.get(thread.id) ?? null;

	// Discordのメッセージ取得はafter(そのID以降)で絞り込む。
	// スレッドIDはSnowflake(時刻含む一意ID)なので-1することで
	// スレッド作成直後から取得でき、余計なメッセージを引いてこない
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

// Claude Codeにpromptを送り、最終的な返答テキストとセッションIDを返す。
// セッションIDを次回のresumeに渡すことで、同じ会話コンテキストを継続できる
async function runCC(
	prompt: string | ContentBlockParam[],
	sessionId: string | null,
) {
	let result = "";
	let sid = sessionId;

	// query()のprompt引数は string か AsyncGenerator<SDKUserMessage> しか受け付けない。
	// 画像付きメッセージはContentBlockParam[]になるため、AsyncGeneratorにラップして渡す
	const resolvedPrompt =
		typeof prompt === "string"
			? prompt
			: (async function* (): AsyncGenerator<SDKUserMessage> {
					yield {
						type: "user",
						message: { role: "user", content: prompt },
						parent_tool_use_id: null,
					};
				})();

	for await (const msg of query({
		prompt: resolvedPrompt,
		options: {
			cwd: WORK_DIR,
			model: "claude-sonnet-4-6",
			maxTurns: 50,
			// Discordからの操作なので確認プロンプトを出さずファイル編集を自動許可する
			permissionMode: "acceptEdits",

			// botが意図しないシステム操作をしないよう、使うツールを明示的に絞っている
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

			// BashはデフォルトでgitコマンドをブロックするがWORK_DIRのバージョン管理に必要なため許可する
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

// Discordの1メッセージ上限(2000文字)を超える応答を複数に分割する
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
	// グローバルコマンドは反映まで最大1時間かかる。
	// GUILD_IDを指定するとそのサーバー限定コマンドとして即時反映されるため、開発中はこちらを使う
	const route = GUILD_ID
		? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
		: Routes.applicationCommands(CLIENT_ID);
	await rest.put(route, { body: [cmd] });
	console.log("slash command registered");
});

// /cc コマンドでClaude Codeセッションを開始し、専用スレッドを作成する
client.on("interactionCreate", async (interaction) => {
	if (!interaction.isChatInputCommand() || interaction.commandName !== "cc")
		return;

	// Claudeの処理は3秒以上かかるため、先にdeferReplyして「考え中」状態にする
	// これをしないとDiscordのインタラクションがタイムアウトする
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

		// セッションIDをスレッドの先頭メッセージとして保存する。
		// resolveSession()がこのメッセージを読んでセッションを復元する
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

// スレッド内のメッセージをClaude Codeに渡して返答する
client.on("messageCreate", async (message) => {
	// botのメッセージや、スレッド外のメッセージは無視する
	if (message.author.bot || !message.channel.isThread()) return;

	// セッションIDがないスレッド(このbotが作ったスレッドでない)は無視する
	const sessionId = await resolveSession(message.channel as ThreadChannel);
	if (!sessionId) return;

	// Claudeの処理中にタイピングインジケータを出す。
	// Discordのタイピング表示は約10秒で消えるため、8秒おきに更新して途切れないようにする
	const typing = setInterval(() => message.channel.sendTyping(), 8000);
	message.channel.sendTyping();

	const imageAttachments = [...message.attachments.values()].filter((a) =>
		a.contentType?.startsWith("image/"),
	);

	// 画像がある場合はContentBlockParam[]に変換する。
	// Claude SDKはテキストと画像を同時に送る場合にこの形式を要求する
	let prompt: string | ContentBlockParam[];
	if (imageAttachments.length === 0) {
		prompt = message.content;
	} else {
		const content: ContentBlockParam[] = [];
		if (message.content) {
			content.push({ type: "text", text: message.content });
		}
		for (const attachment of imageAttachments) {
			content.push({
				type: "image",
				source: { type: "url", url: attachment.url },
			});
		}
		prompt = content;
	}

	try {
		const { result, sessionId: newId } = await runCC(prompt, sessionId);
		clearInterval(typing);

		// セッションIDが変わった場合(Claudeが内部でセッションを更新した場合)はキャッシュを更新する
		if (newId && newId !== sessionId)
			sessionCache.set(message.channel.id, newId);

		// 最初のチャンクはreply()で返すことで元のメッセージへの返信として表示する
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
