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

	for (const group of groupNames) {
		for (const extensionId of config.groups[group]) {
			const id = `extension:${extensionId.toLowerCase()}`;
			if (!extensionNodes.has(id)) {
				const described = options.describe?.(extensionId);
				extensionNodes.set(id, { id, kind: 'extension', label: described?.label ?? extensionId, extensionId, icon: described?.icon, related: [] });
			}
			if (!edges.some(e => e.from === id && e.to === `group:${group}`)) {
				edges.push({ from: id, to: `group:${group}` });
			}
		}
	}

	for (const profile of profiles) {
		const own = has(config.profiles, profile) ? config.profiles[profile] : [];
		for (const group of assignedGroups(config, profile)) {
			if (has(config.groups, group)) {
				edges.push({ from: `group:${group}`, to: `profile:${profile}`, ...(own.includes(group) ? {} : { all: true }) });
			}
		}
	}

	const nodes: GraphNode[] = [
		...[...extensionNodes.values()].sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id)),
		...groupNames.map((name): GraphNode => ({ id: `group:${name}`, kind: 'group', label: name, detail: count(config.groups[name].length, 'extension'), related: [] })),
		...profiles.map((name): GraphNode => ({ id: `profile:${name}`, kind: 'profile', label: name, ...(name === options.current ? { current: true } : {}), related: [] })),
	];

	const next = (from: string, kind: GraphKind): string[] => edges.filter(e => e.from === from && e.to.startsWith(kind + ':')).map(e => e.to);
	const previous = (to: string, kind: GraphKind): string[] => edges.filter(e => e.to === to && e.from.startsWith(kind + ':')).map(e => e.from);
	for (const node of nodes) {
		const related = new Set([node.id]);
		const add = (ids: string[]) => ids.forEach(id => related.add(id));
		switch (node.kind) {
			case 'extension':
				for (const group of next(node.id, 'group')) {
					related.add(group);
					add(next(group, 'profile'));
				}
				break;
			case 'group':
				add(previous(node.id, 'extension'));
				add(next(node.id, 'profile'));
				break;
			case 'profile':
				for (const group of previous(node.id, 'group')) {
					related.add(group);
					add(previous(group, 'extension'));
				}
				break;
		}
		node.related = [...related];
	}
	return { nodes, edges };
}
