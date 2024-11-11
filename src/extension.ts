// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { rejects } from 'assert';
import { exec } from 'child_process';
import path, { resolve } from 'path';
import { stderr, stdout } from 'process';
import * as vscode from 'vscode';
import * as fs from 'fs';

type Profile = {
	name: string;
	location: string;
	icon: string;
	useDefaultFlags?: object;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	console.log("Extension 'better-profiles' is now active!");
	
	const getProfileFromLocation = async (profile: string) => {
		return new Promise<Profile|undefined>((resolve, reject) => {
			const user_dir_path =  path.join(context.globalStorageUri.fsPath, '../..');
		const global_storage_file = user_dir_path + '/globalStorage/storage.json';
		console.log("user_dir: ", user_dir_path);
		console.log("globalstoragefile: ", global_storage_file);
		fs.readFile(global_storage_file, 'utf8', (err, data) => {
			if (err) {
				console.error("Error reading the file:", err);
				reject(undefined);
				return;
			}
			try {
				const storage = JSON.parse(data);
				const profiles = storage["userDataProfiles"];
				for (const profile_obj of profiles) {
					if (profile_obj.location === profile) {
						resolve(profile_obj);
					}
				}
				resolve({
					name: "Default",
					location: "Unknown",
					icon: "settings-view-bar-icon",
				});
			} catch (parseErr) {
				console.error("Error parsing JSON data:", parseErr);
				reject(undefined);
			}
		});
		});
	};

	const disposable_get_profiles = vscode.commands.registerCommand('better-profiles.getProfiles', async () => {
		console.log("Command 'better-profiles.getProfiles' is now active!");
		const user_dir_path =  path.join(context.globalStorageUri.fsPath, '../..');
		const global_storage_file = user_dir_path + '/globalStorage/storage.json';
		console.log("user_dir: ", user_dir_path);
		console.log("globalstoragefile: ", global_storage_file);
		fs.readFile(global_storage_file, 'utf8', (err, data) => {
			if (err) {
				console.error("Error reading the file:", err);
				return;
			}
			try {
				const storage = JSON.parse(data);
				const profiles = storage["userDataProfiles"];
				const profile_names =new Set();
				for (const profile of profiles) {
					profile_names.add(profile["name"]);
				}
				vscode.window.showInformationMessage("Profiles: " + [...profile_names].join(", "));
				return [...profiles];

			} catch (parseErr) {
				console.error("Error parsing JSON data:", parseErr);
			}
		});
	});
	
	const disposable = vscode.commands.registerCommand('better-profiles.getCurrentProfile', async () => {
		console.log("Command 'better-profiles.activate' is now active!");
		const user_dir_path =  path.join(context.globalStorageUri.fsPath, '../..');
		const global_storage_file = user_dir_path + '/globalStorage/storage.json';
		console.log("user_dir: ", user_dir_path);
		console.log("globalstoragefile: ", global_storage_file);
		return new Promise<Profile|undefined>((resolve) => {
			fs.readFile(global_storage_file, 'utf8', async (err, data) => {
				if (err) {
					console.error("Error reading the file:", err);
					resolve(undefined);
					return;
				}
				console.log("workspace_name:"+vscode.workspace.name);
				const workspace_path = "file://"+vscode.workspace.workspaceFolders?.[0].uri.fsPath;
				
				try {
					const storage = JSON.parse(data);
					const workspaces = storage["profileAssociations"]["workspaces"];
					const active_profile = await getProfileFromLocation(workspaces[workspace_path]);
					
					resolve(active_profile);
	
				} catch (parseErr) {
					console.error("Error parsing JSON data:", parseErr);
					resolve(undefined);
				}
	
			});
		});
		
		
	});
	

	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99999999);
	const current_profile = await vscode.commands.executeCommand('better-profiles.getCurrentProfile') as Profile;
	if (current_profile !== undefined) {
		statusBarItem.text = `$(${current_profile.icon}) ${current_profile.name}`;
	}
	else{
		statusBarItem.text = `$(settings-view-bar-icon) Default`;
	}
	statusBarItem.command = 'workbench.profiles.actions.switchProfile';
	statusBarItem.show();

	context.subscriptions.push(disposable);
	context.subscriptions.push(disposable_get_profiles);
	context.subscriptions.push(statusBarItem);
	await vscode.commands.executeCommand('better-profiles.getCurrentProfile');

}

// This method is called when your extension is deactivated
export function deactivate() {
}
