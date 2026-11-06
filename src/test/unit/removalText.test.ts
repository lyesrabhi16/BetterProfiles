import * as assert from 'assert';
import { keptDetail, keptSentence } from '../../removalText';

suite('keptSentence', () => {
	test('an extension applied to all profiles says so, why that matters and how to change it', () => {
		const text = keptSentence({ 'rangav.vscode-thunder-client': 'application' });
		assert.ok(text.includes('rangav.vscode-thunder-client'));
		assert.ok(/all profiles/i.test(text) && /everywhere|every profile|all of them/i.test(text), text);
		assert.ok(text.includes('Apply Extension to all Profiles'), 'it should tell where to change it: ' + text);
	});

	test('this extension says it is this extension', () => {
		const text = keptSentence({ 'lyesrabhi.better-profiles': 'self' });
		assert.ok(/this extension/i.test(text) && text.includes('lyesrabhi.better-profiles'), text);
	});

	test('one in keepExtensions says it is in that setting', () => {
		const text = keptSentence({ 'a.b': 'keep' });
		assert.ok(text.includes('betterProfiles.keepExtensions'), text);
	});

	test('one installed in every profile (when VS Code\'s own flag could not be read) says that', () => {
		const text = keptSentence({ 'a.b': 'everywhere' });
		assert.ok(/every profile/i.test(text), text);
	});

	test('several with the same reason are named together, each reason is said once', () => {
		const text = keptSentence({ 'a.b': 'application', 'c.d': 'application', 'e.f': 'keep' });
		assert.ok(text.includes('a.b') && text.includes('c.d') && text.includes('e.f'));
		assert.strictEqual(text.split('Apply Extension to all Profiles').length - 1, 1, text);
	});

	test('nothing kept says nothing', () => {
		assert.strictEqual(keptSentence({}), '');
	});

	test('is plain sentences, not a list of possible reasons', () => {
		const text = keptSentence({ 'a.b': 'application' });
		assert.ok(!/keepExtensions/.test(text), 'a reason that does not apply must not be mentioned: ' + text);
		assert.ok(!/this extension,/.test(text), text);
	});
});

suite('keptDetail', () => {
	test('is a short line for the question: each kept extension with its reason in a few words', () => {
		const text = keptDetail({ 'a.b': 'application', 'c.d': 'keep', 'lyesrabhi.better-profiles': 'self', 'x.y': 'everywhere' });
		assert.ok(text.includes('a.b (applied to all profiles)'), text);
		assert.ok(text.includes('c.d (in keepExtensions)'), text);
		assert.ok(text.includes('lyesrabhi.better-profiles (this extension)'), text);
		assert.ok(text.includes('x.y (installed in every profile)'), text);
	});

	test('nothing kept says nothing', () => {
		assert.strictEqual(keptDetail({}), '');
	});
});
