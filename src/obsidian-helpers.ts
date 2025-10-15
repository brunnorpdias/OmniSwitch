import type { App, Command } from "obsidian";

export interface CommandManagerLike {
	listCommands(): Command[];
	executeCommandById(id: string): boolean;
}

export function getCommandManager(app: App): CommandManagerLike | null {
	const manager = (app as unknown as { commands?: CommandManagerLike }).commands;
	return manager ?? null;
}
