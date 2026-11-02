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
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, 'utf8'));

if (!(profile in state)) {
	console.error(`Profile '${profile}' not found.`);
	process.exit(1);
} else if (args.includes('--list-extensions')) {
	console.log(state[profile].map(id => `${id}@1.0.0`).join('\n'));
} else if (args.includes('--install-extension')) {
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
} else {
	process.exit(2);
}
