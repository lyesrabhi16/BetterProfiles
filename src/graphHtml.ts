// The page of the graph view. Pure, no `vscode` import. It shows what the extension sends it ({ type: 'graph', graph, error? })
// and tells the extension about clicks ({ type: 'openExtension', id }, { type: 'refresh' }, { type: 'ready' }).
// Names come from other people's extensions and from the groups file, so they are only ever written as text.

const safe = (value: string, allowed: RegExp) => value.replace(allowed, '');

export function graphHtml(nonce: string, cspSource: string): string {
	const n = safe(nonce, /[^A-Za-z0-9+/=_-]/g);
	// VS Code's value looks like "'self' https://*.vscode-cdn.net": quotes, a space and a wildcard are part of it
	const source = safe(cspSource, /[^A-Za-z0-9:./_%+*' -]/g);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source} data:; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Better Profiles Graph</title>
<style nonce="${n}">
	:root { --gap: 56px; }
	body { margin: 0; padding: 12px 12px 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
	header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
	h1 { font-size: 1.3em; font-weight: 600; margin: 0; }
	.hint { color: var(--vscode-descriptionForeground); }
	button.refresh { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; border-radius: 2px; padding: 3px 10px; cursor: pointer; }
	button.refresh:hover { background: var(--vscode-button-secondaryHoverBackground); }
	#board { position: relative; display: grid; grid-template-columns: repeat(3, minmax(110px, 1fr)); column-gap: var(--gap); align-items: start; }
	#edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
	.col { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
	.col h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 0 0 4px; font-weight: 600; }
	.node { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; text-align: left; font: inherit; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, #8885)); border-left-width: 4px; border-radius: 4px; padding: 5px 8px; cursor: default; }
	.node.k-extension { border-left-color: var(--vscode-charts-blue); cursor: pointer; }
	.node.k-group { border-left-color: var(--vscode-charts-orange); }
	.node.k-profile { border-left-color: var(--vscode-charts-green); }
	.node:hover, .node:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
	.node img { width: 20px; height: 20px; flex: none; object-fit: contain; }
	.node .text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
	.node .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.node .detail { color: var(--vscode-descriptionForeground); font-size: 0.8em; white-space: nowrap; }
	.node .badge { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-radius: 8px; padding: 0 7px; font-size: 0.8em; }
	.node.dim { opacity: 0.3; }
	path.edge { fill: none; stroke-width: 1.5; opacity: 0.55; }
	path.edge.k-extension { stroke: var(--vscode-charts-blue); }
	path.edge.k-group { stroke: var(--vscode-charts-green); }
	path.edge.all { stroke-dasharray: 5 4; }
	path.edge.dim { opacity: 0.07; }
	path.edge.lit { opacity: 1; stroke-width: 2.5; }
	.legend { display: flex; gap: 14px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.legend svg { vertical-align: middle; }
	#message { margin: 8px 0; color: var(--vscode-descriptionForeground); }
	#message.error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<header>
	<h1>Extensions, groups and profiles</h1>
	<button class="refresh" id="refresh" type="button">Refresh</button>
	<span class="legend">
		<span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--vscode-charts-green)" stroke-width="2"/></svg> follows</span>
		<span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--vscode-charts-green)" stroke-width="2" stroke-dasharray="5 4"/></svg> goes to all profiles</span>
	</span>
	<span class="hint">Point at one to see what it connects to. Click an extension to open its page.</span>
</header>
<p id="message" hidden></p>
<main id="board">
	<svg id="edges" aria-hidden="true"></svg>
	<section class="col" data-kind="extension"><h2>Extensions</h2></section>
	<section class="col" data-kind="group"><h2>Groups</h2></section>
	<section class="col" data-kind="profile"><h2>Profiles</h2></section>
</main>
<script nonce="${n}">
(function () {
	const vscode = acquireVsCodeApi();
	const board = document.getElementById('board');
	const edgesSvg = document.getElementById('edges');
	const message = document.getElementById('message');
	const NS = 'http://www.w3.org/2000/svg';
	let graph = { nodes: [], edges: [] };
	const elements = new Map();
	let paths = [];

	const text = (parent, tag, className, value) => {
		const el = document.createElement(tag);
		el.className = className;
		el.textContent = value;
		parent.appendChild(el);
		return el;
	};

	function showMessage(value, isError) {
		message.hidden = !value;
		message.textContent = value || '';
		message.className = isError ? 'error' : '';
	}

	function light(id) {
		const related = id ? new Set(graph.nodes.find(node => node.id === id).related) : undefined;
		elements.forEach((el, nodeId) => el.classList.toggle('dim', !!related && !related.has(nodeId)));
		paths.forEach(({ el, edge }) => {
			const on = !!related && related.has(edge.from) && related.has(edge.to);
			el.classList.toggle('dim', !!related && !on);
			el.classList.toggle('lit', on);
		});
	}

	function draw() {
		while (edgesSvg.firstChild) { edgesSvg.removeChild(edgesSvg.firstChild); }
		paths = [];
		const base = board.getBoundingClientRect();
		for (const edge of graph.edges) {
			const from = elements.get(edge.from);
			const to = elements.get(edge.to);
			if (!from || !to) { continue; }
			const a = from.getBoundingClientRect();
			const b = to.getBoundingClientRect();
			const x1 = a.right - base.left, y1 = a.top + a.height / 2 - base.top;
			const x2 = b.left - base.left, y2 = b.top + b.height / 2 - base.top;
			const mid = (x1 + x2) / 2;
			const path = document.createElementNS(NS, 'path');
			path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2);
			path.setAttribute('class', 'edge k-' + (edge.from.startsWith('extension:') ? 'extension' : 'group') + (edge.all ? ' all' : ''));
			edgesSvg.appendChild(path);
			paths.push({ el: path, edge });
		}
	}

	function render(next, error) {
		graph = next;
		elements.clear();
		document.querySelectorAll('.col .node').forEach(el => el.remove());
		for (const node of graph.nodes) {
			const column = board.querySelector('.col[data-kind="' + node.kind + '"]');
			const el = document.createElement('button');
			el.type = 'button';
			el.className = 'node k-' + node.kind;
			el.title = node.kind === 'extension' ? node.extensionId : node.label;
			if (node.icon) {
				const img = document.createElement('img');
				img.alt = '';
				img.src = node.icon;
				el.appendChild(img);
			}
			const box = document.createElement('span');
			box.className = 'text';
			text(box, 'span', 'name', node.label);
			if (node.detail) { text(box, 'span', 'detail', node.detail); }
			el.appendChild(box);
			if (node.current) { text(el, 'span', 'badge', 'current'); }
			el.addEventListener('mouseenter', () => light(node.id));
			el.addEventListener('focus', () => light(node.id));
			el.addEventListener('mouseleave', () => light(undefined));
			el.addEventListener('blur', () => light(undefined));
			if (node.kind === 'extension') {
				el.addEventListener('click', () => vscode.postMessage({ type: 'openExtension', id: node.extensionId }));
			}
			column.appendChild(el);
			elements.set(node.id, el);
		}
		const groups = graph.nodes.filter(node => node.kind === 'group').length;
		showMessage(error ? error : groups === 0 ? 'No groups yet. Make one in the Groups view and it shows here.' : '', !!error);
		draw();
	}

	window.addEventListener('message', event => {
		const data = event.data;
		if (data && data.type === 'graph' && data.graph) { render(data.graph, data.error); }
	});
	new ResizeObserver(draw).observe(board);
	document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
	vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>
`;
}
