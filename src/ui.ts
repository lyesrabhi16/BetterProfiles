import * as vscode from 'vscode';
import type { PromptUi } from './api';

/** The default way to ask: VS Code's own notifications, checkbox list and modal dialog. */
export function createUi(): PromptUi {
	return {
		ask: async (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),

		pickOne: async (title, items, options) => {
			const NEW = '\u0000new';
			const picks = [
				...items.map(item => ({ label: item.label, description: item.description, id: item.id })),
				...(options?.newItem ? [{ label: options.newItem.label, description: undefined, id: NEW }] : []),
			];
			const choice = await vscode.window.showQuickPick(picks, { title, placeHolder: title });
			if (choice?.id !== NEW) {
				return choice?.id;
			}
			return vscode.window.showInputBox({ prompt: options!.newItem!.prompt, validateInput: v => (v.trim() ? undefined : 'A name is required.') });
		},

		pickMany: async (title, items, options) => {
			const NEW = '\u0000new';
			const picks = [
				...items.map(item => ({ label: item.label, description: item.description, id: item.id })),
				...(options?.newItem ? [{ label: options.newItem.label, description: undefined, id: NEW }] : []),
			];
			const picked = await vscode.window.showQuickPick(picks, { canPickMany: true, title, placeHolder: 'Tick one or more, then press Enter (nothing is ticked by default)' });
			if (!picked) {
				return undefined;
			}
			const ids: string[] = [];
			for (const item of picked) {
				if (item.id !== NEW) {
					ids.push(item.id);
					continue;
				}
				const typed = await vscode.window.showInputBox({ prompt: options!.newItem!.prompt, validateInput: v => (v.trim() ? undefined : 'A name is required.') });
				if (typed === undefined) {
					return undefined; // cancelled while naming: cancel the whole choice
				}
				ids.push(typed.trim());
			}
			return ids;
		},

		openExtension: async id => {
			await vscode.commands.executeCommand('extension.open', id);
		},

		input: async prompt => vscode.window.showInputBox({ prompt, validateInput: v => (v.trim() ? undefined : 'A name is required.') }),

		confirm: async (message, detail, action) =>
			(await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
	};
}
