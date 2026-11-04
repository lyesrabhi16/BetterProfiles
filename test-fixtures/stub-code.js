// A fake VS Code CLI for the Extension Host tests. It never touches a real VS Code.
// STUB_STATE: JSON file { "<profile>": ["publisher.name", ...] } ("Default" when --profile is absent)
// STUB_LOG:   every invocation is appended there as one JSON array of arguments.
const fs = require('fs');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\n');

const flag = name => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const profile = flag('--profile') ?? 'Default';
const delay = Number(process.env.STUB_DELAY_MS || 0);
const wait = () => (delay > 0 ? Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay) : undefined);
const actionDelay = Number(process.env.STUB_ACTION_DELAY_MS || 0);
const waitForAction = () => (actionDelay > 0 ? Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, actionDelay) : undefined);
const all = name => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'));

if (!(profile in state)) {
	console.error(`Profile '${profile}' not found.`);
	process.exit(1);
} else if (args.includes('--list-extensions')) {
	wait();
	console.log(state[profile].map(id => `${id}@1.0.0`).join('\n'));
} else if (args.includes('--install-extension')) {
	waitForAction();
	const id = flag('--install-extension');
	if (id.startsWith('fail.')) {
		console.error(`Extension '${id}' not found.`);
		process.exit(1);
	}
	if (!state[profile].some(existing => existing.toLowerCase() === id.toLowerCase())) {
		state[profile].push(id);
		fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
	}
	console.log(`Installing extensions...\nExtension '${id}' v1.0.0 was successfully installed.`);
} else if (args.includes('--uninstall-extension')) {
	waitForAction();
	let failed = false;
	for (const id of all('--uninstall-extension')) {
		const at = state[profile].findIndex(existing => existing.toLowerCase() === id.toLowerCase());
		if (id.startsWith('fail.') || at < 0) {
			console.error(`Extension '${id}' is not installed.`);
			failed = true;
			continue;
		}
		state[profile].splice(at, 1);
		fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
		console.log(`Uninstalling ${id}...\nExtension '${id}' was successfully uninstalled!`);
	}
	process.exit(failed ? 1 : 0);
} else {
	process.exit(2);
}
