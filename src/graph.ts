// The groups file as a graph: extension -> group -> profile. Pure, no `vscode` import.

import { GroupsConfig, assignedGroups } from './groups';

export type GraphKind = 'extension' | 'group' | 'profile';

export interface GraphNode {
	id: string;
	kind: GraphKind;
	label: string;
	detail?: string;
	/** An extension's id as the file spells it, to open its page. */
	extensionId?: string;
	/** Where the extension's icon image is shown from. */
	icon?: string;
	current?: boolean;
	/** This node and every node on a path through it (what to light up when it is pointed at). */
	related: string[];
}

export interface GraphEdge {
	from: string;
	to: string;
	/** A group that goes to the profile only because it goes to all profiles. */
	all?: boolean;
}

export interface GraphModel {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface Described {
	label: string;
	icon?: string;
}

export interface GraphOptions {
	/** How an extension presents itself, when it is known. */
	describe?: (extensionId: string) => Described | undefined;
	/** The profile of this window. */
	current?: string;
}

const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Extensions in groups on the left, the groups in the middle, the profiles on the right, and who leads to whom. */
export function buildGraph(config: GroupsConfig, profiles: readonly string[], options: GraphOptions = {}): GraphModel {
	const extensionNodes = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const groupNames = Object.keys(config.groups);

	// who is linked to whom, by node id (looked up, never searched for: the graph can have thousands of nodes)
	const groupsOfExtension = new Map<string, string[]>();
	const membersOfGroup = new Map<string, string[]>();
	const profilesOfGroup = new Map<string, string[]>();
	const groupsOfProfile = new Map<string, string[]>();
	const push = (table: Map<string, string[]>, key: string, value: string) => {
		const list = table.get(key);
		list ? list.push(value) : table.set(key, [value]);
	};

	for (const group of groupNames) {
		const groupId = `group:${group}`;
		for (const extensionId of config.groups[group]) {
			const id = `extension:${extensionId.toLowerCase()}`;
			if (!extensionNodes.has(id)) {
				const described = options.describe?.(extensionId);
				extensionNodes.set(id, { id, kind: 'extension', label: described?.label ?? extensionId, extensionId, icon: described?.icon, related: [] });
			}
			if (!groupsOfExtension.get(id)?.includes(groupId)) { // a handful of groups per extension: a short list, not the whole graph
				edges.push({ from: id, to: groupId });
				push(groupsOfExtension, id, groupId);
				push(membersOfGroup, groupId, id);
			}
		}
	}

	for (const profile of profiles) {
		const own = new Set(Object.prototype.hasOwnProperty.call(config.profiles, profile) ? config.profiles[profile] : []);
		const profileId = `profile:${profile}`;
		for (const group of assignedGroups(config, profile)) {
			if (Object.prototype.hasOwnProperty.call(config.groups, group)) {
				const groupId = `group:${group}`;
				edges.push({ from: groupId, to: profileId, ...(own.has(group) ? {} : { all: true }) });
				push(profilesOfGroup, groupId, profileId);
				push(groupsOfProfile, profileId, groupId);
			}
		}
	}

	const nodes: GraphNode[] = [
		...[...extensionNodes.values()].sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id)),
		...groupNames.map((name): GraphNode => ({ id: `group:${name}`, kind: 'group', label: name, detail: count(config.groups[name].length, 'extension'), related: [] })),
		...profiles.map((name): GraphNode => ({ id: `profile:${name}`, kind: 'profile', label: name, ...(name === options.current ? { current: true } : {}), related: [] })),
	];

	const get = (table: Map<string, string[]>, key: string) => table.get(key) ?? [];
	for (const node of nodes) {
		const related = new Set([node.id]);
		switch (node.kind) {
			case 'extension':
				for (const group of get(groupsOfExtension, node.id)) {
					related.add(group);
					get(profilesOfGroup, group).forEach(profile => related.add(profile));
				}
				break;
			case 'group':
				get(membersOfGroup, node.id).forEach(member => related.add(member));
				get(profilesOfGroup, node.id).forEach(profile => related.add(profile));
				break;
			case 'profile':
				for (const group of get(groupsOfProfile, node.id)) {
					related.add(group);
					get(membersOfGroup, group).forEach(member => related.add(member));
				}
				break;
		}
		node.related = [...related];
	}
	return { nodes, edges };
}
