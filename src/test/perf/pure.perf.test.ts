import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGraph } from '../../graph';
import {
	GroupsConfig,
	commonToAllProfiles,
	desiredExtensions,
	parseGroups,
	planCleanup,
	planSync,
	profileLayout,
	renderMatrix,
	serializeGroups,
} from '../../groups';
import { graphHtml } from '../../graphHtml';
import { listFromIndexes, parseProfileIndex } from '../../profileIndex';
import { ProfileIndexReader } from '../../profileIndexReader';
import { ProfileStore } from '../../profileStore';
import { ext, flush, range, scalesLinearly, within } from './bench';

/** Groups of ten extensions each (every extension in three groups), followed by a few profiles. */
function bigConfig(extensions: number, profiles = 20): GroupsConfig {
	const groups: Record<string, string[]> = {};
	const groupCount = Math.max(1, Math.floor(extensions / 10));
	for (let g = 0; g < groupCount; g++) {
		groups[`group${g}`] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => ext((g * 10 + k + (g % 3) * 7) % extensions));
	}
	const names = Object.keys(groups);
	const followed: Record<string, string[]> = { '*': names.slice(0, 3) };
	for (let p = 0; p < profiles; p++) {
		followed[`Profile${p}`] = names.filter((_, i) => i % profiles === p || i % 7 === p % 7);
	}
	return { groups, profiles: followed };
}

const profileNames = (n: number) => ['Default', ...range(n - 1).map(p => `Profile${p}`)];

suite('performance: pure logic', function () {
	this.timeout(120_000);
	suiteTeardown(() => flush('pure'));

	suite('the index files of VS Code', () => {
		const entry = (i: number) => ({ identifier: { id: ext(i) }, version: '1.2.3', relativeLocation: `${ext(i)}-1.2.3`, metadata: { isApplicationScoped: i % 40 === 0, targetPlatform: 'undefined' } });
		const text = JSON.stringify(range(1000).map(entry));

		test('reading a list of 1000 extensions', () => within('parseProfileIndex, 1000 extensions', 60, () => parseProfileIndex(text)));

		test('merging a profile with the default profile, 1000 extensions each', () => {
			const own = parseProfileIndex(text);
			const defaults = parseProfileIndex(JSON.stringify(range(1000).map(i => entry(i + 500))));
			return within('listFromIndexes, 1000 + 1000', 30, () => listFromIndexes(own, defaults));
		});

		test('parsing grows in step with the file', () => scalesLinearly('parseProfileIndex', n => {
			const t = JSON.stringify(range(n).map(entry));
			return () => parseProfileIndex(t);
		}, { small: 1000 }));

		test('a file that did not change is looked at, not read: the second read is much cheaper than the first', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-perf-'));
			try {
				const file = path.join(dir, 'extensions.json');
				fs.writeFileSync(file, text);
				fs.utimesSync(file, 1_000_000, 1_000_000);
				const reader = new ProfileIndexReader();
				const cold = await within('ProfileIndexReader, first read of 1000 extensions', 80, async () => { reader.forget(file); await reader.read(file); }, { warmup: 2 });
				const warm = await within('ProfileIndexReader, unchanged file (a stat)', 5, () => reader.read(file), { runs: 15 });
				assert.ok(warm < cold, `a stat (${warm.toFixed(2)} ms) should be cheaper than a read (${cold.toFixed(2)} ms)`);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	suite('the graph', () => {
		test('2000 extensions in 200 groups, 20 profiles', () => {
			const config = bigConfig(2000);
			return within('buildGraph, 2000 extensions / 200 groups / 20 profiles', 250, () => buildGraph(config, profileNames(20)), { runs: 5 });
		});

		test('building it grows in step with the groups file', () => scalesLinearly('buildGraph', n => {
			const config = bigConfig(n);
			const profiles = profileNames(20);
			return () => buildGraph(config, profiles);
		}, { small: 500 }));

		test('its page is small and made at once', () => within('graphHtml', 5, () => assert.ok(graphHtml('nonce', "'self' https://*.vscode-cdn.net").length < 30_000)));
	});

	suite('groups and profiles', () => {
		test('what a profile shows, with 200 groups and 1500 installed extensions', () => {
			const config = bigConfig(1500);
			const installed = range(1500).filter(i => i % 3 !== 0).map(ext);
			return within('profileLayout, 150 groups / 1000 installed', 60, () => profileLayout(config, 'Profile3', installed));
		});

		test('the layout grows in step with the extensions', () => scalesLinearly('profileLayout', n => {
			const config = bigConfig(n);
			const installed = range(n).filter(i => i % 3 !== 0).map(ext);
			return () => profileLayout(config, 'Profile3', installed);
		}, { small: 500 }));

		test('what to install and what is extra, for a profile of 1500 extensions', () => {
			const config = bigConfig(1500);
			const installed = range(1500).filter(i => i % 2 === 0).map(ext);
			return within('planSync + planCleanup + desiredExtensions', 80, () => {
				planSync(config, 'Profile5', installed);
				planCleanup(config, 'Profile5', installed, [ext(1)]);
				desiredExtensions(config, 'Profile5');
			});
		});

		test('planning grows in step with the extensions', () => scalesLinearly('planSync + planCleanup', n => {
			const config = bigConfig(n);
			const installed = range(n).filter(i => i % 2 === 0).map(ext);
			return () => { planSync(config, 'Profile5', installed); planCleanup(config, 'Profile5', installed, []); };
		}, { small: 500 }));

		test('what every profile has in common, 20 profiles of 1500', () => {
			const lists = range(20).map(p => range(1500).filter(i => (i + p) % 5 !== 0).map(ext));
			return within('commonToAllProfiles, 20 x 1500', 80, () => commonToAllProfiles(lists));
		});

		test('the comparison table, 20 profiles of 1000', () => {
			const columns = range(20).map(p => ({ profile: `Profile${p}`, ids: range(1000).filter(i => (i + p) % 4 !== 0).map(ext) }));
			return within('renderMatrix, 20 x 1000', 150, () => renderMatrix(columns), { runs: 5 });
		});

		test('the groups file, 200 groups of 100 extensions, read and written', () => {
			const config = bigConfig(2000);
			const text = serializeGroups(config);
			return within('serializeGroups + parseGroups, 200 groups', 100, () => { parseGroups(text); serializeGroups(config); });
		});
	});

	suite('the store of what each profile has', () => {
		const make = (n: number) => {
			const list = range(n).map(i => ({ id: ext(i), version: '1.0.0' }));
			return new ProfileStore(async () => list);
		};

		test('showing 2000 extensions with 500 being installed and 500 being removed', async () => {
			const store = make(2000);
			await store.list('P');
			store.installing('P', range(500).map(i => `new.ext${i}`));
			store.removing('P', range(500).map(ext));
			await within('ProfileStore.entries, 2000 + 500 - 500', 40, () => store.entries('P'));
		});

		test('the merge grows in step with the list', async () => {
			const stores = new Map<number, ProfileStore>();
			for (const n of [500, 2000]) {
				const store = make(n);
				await store.list('P');
				store.installing('P', range(n / 4).map(i => `new.ext${i}`));
				store.removing('P', range(n / 4).map(ext));
				stores.set(n, store);
			}
			await scalesLinearly('ProfileStore.entries', n => () => stores.get(n)!.entries('P'), { small: 500 });
		});

		test('a thousand changes to a known list', async () => {
			const store = make(1000);
			await store.list('P');
			await within('ProfileStore.added/removed x 1000', 120, () => {
				for (let i = 0; i < 500; i++) { store.added('P', [`added.ext${i}`]); }
				for (let i = 0; i < 500; i++) { store.removed('P', [`added.ext${i}`]); }
			}, { runs: 5 });
		});
	});
});
