// What a drag and drop between the Profiles and Groups trees means. Pure, no `vscode` import.

import { isExtensionId } from './groups';

export type DragSource =
	| { kind: 'extension'; id: string; from: { type: 'group' | 'profile'; name: string } }
	| { kind: 'group'; name: string };

export type DropTarget = { kind: 'group'; name: string } | { kind: 'profile'; name: string };

export type DropOperation =
	| { op: 'addToGroup'; group: string; ids: string[] }
	| { op: 'installInProfile'; profile: string; ids: string[] }
	| { op: 'assignGroup'; profile: string; group: string };

/** Turns a drop into the operations to run. Dropping never removes or uninstalls anything. */
export function planDrop(sources: DragSource[], target: DropTarget): DropOperation[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		if (source.kind !== 'extension' || !isExtensionId(source.id)) {
			continue;
		}
		if (source.from.type === target.kind && source.from.name === target.name) {
			continue; // dropped back where it came from
		}
		const key = source.id.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			ids.push(source.id);
		}
	}

	const operations: DropOperation[] = [];
	if (ids.length > 0) {
		operations.push(target.kind === 'group' ? { op: 'addToGroup', group: target.name, ids } : { op: 'installInProfile', profile: target.name, ids });
	}
	if (target.kind === 'profile') {
		const groups = new Set(sources.flatMap(source => (source.kind === 'group' ? [source.name] : [])));
		for (const group of groups) {
			operations.push({ op: 'assignGroup', profile: target.name, group });
		}
	}
	return operations;
}
