import { REST, Routes } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildIds = process.env.DISCORD_GUILD_ID?.split(",")
	.map((id) => id.trim())
	.filter((id) => id.length > 0);

if (!token || !clientId) {
	console.error("DISCORD_TOKEN, DISCORD_CLIENT_ID を設定してください");
	process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

await rest.put(Routes.applicationCommands(clientId), { body: [] });
console.log("グローバルコマンドを削除しました");

if (guildIds?.length) {
	for (const guildId of guildIds) {
		await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
			body: [],
		});
	}
	console.log("ギルドコマンドを削除しました");
}
