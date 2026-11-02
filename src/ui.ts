import * as vscode from 'vscode';
import type { PromptUi } from './api';

/** The default way to ask: VS Code's own notifications, checkbox list and modal dialog. */
export function createUi(): PromptUi {
	return {
		ask: async (message, ...buttons) => vscode.window.showInformationMessage(message, ...buttons),

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
