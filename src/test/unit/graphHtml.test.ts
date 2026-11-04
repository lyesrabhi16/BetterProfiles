import * as assert from 'assert';
import { graphHtml } from '../../graphHtml';

suite('graphHtml', () => {
	const html = graphHtml('abc123', 'vscode-webview://x');

	test('is a complete page with a title', () => {
		assert.ok(html.startsWith('<!DOCTYPE html>'));
		assert.ok(/<title>[^<]+<\/title>/.test(html));
	});

	test('allows nothing but its own script and style (by nonce) and images from the extensions', () => {
		const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
		assert.ok(csp.includes("default-src 'none'"), csp);
		assert.ok(csp.includes("script-src 'nonce-abc123'"), csp);
		assert.ok(csp.includes("style-src 'nonce-abc123'"), csp);
		assert.ok(csp.includes('img-src vscode-webview://x'), csp);
		assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), csp);
	});

	test('every script and style tag carries the nonce', () => {
		const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
		assert.ok(tags.length >= 2);
		assert.ok(tags.every(tag => tag.includes('nonce="abc123"')), tags.join(' '));
	});

	test('loads nothing from the network', () => {
		assert.ok(!/(src|href)\s*=\s*"https?:/.test(html));
		assert.ok(!/@import|url\(\s*["']?https?:/.test(html));
	});

	test('never writes text into the page as markup', () => {
		assert.ok(!html.includes('innerHTML'), 'names come from other people\'s extensions and from the groups file');
	});

	test('a nonce or origin cannot break out of the policy', () => {
		const odd = graphHtml('a"b', 'x" y');
		assert.ok(!odd.includes('nonce-a"b'));
	});
});
