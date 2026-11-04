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

		pickMany: async (title, items) => {
			const picked = await vscode.window.showQuickPick(
				items.map(item => ({ label: item.label, description: item.description, id: item.id })),
				{ canPickMany: true, title, placeHolder: 'Tick what to uninstall (nothing is ticked by default)' },
			);
			return picked?.map(item => item.id);
		},

		confirm: async (message, detail, action) =>
			(await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
	};
}
