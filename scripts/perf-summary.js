// Prints the performance numbers of a run as a Markdown table, for the summary of a CI job:
//   node scripts/perf-summary.js >> "$GITHUB_STEP_SUMMARY"
const fs = require('fs');
const path = require('path');

const dir = process.env.BP_PERF_OUT || path.resolve(__dirname, '..', 'perf-results');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
if (files.length === 0) {
	console.log('No performance results.');
	process.exit(0);
}
for (const file of files) {
	const { results, scale } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
	const slow = results.filter(r => r.status === 'slow').length;
	console.log(`### Performance: ${path.basename(file, '.json')}${slow > 0 ? ` (${slow} over budget)` : ''}\n`);
	console.log(`Budgets scaled by ${scale}.\n`);
	console.log('| Measurement | Time | Budget | |\n|---|---:|---:|---|');
	for (const r of results) {
		console.log(`| ${r.name} | ${r.ms} ms | ${r.budgetMs === undefined ? '' : `${r.budgetMs} ms`} | ${r.status === 'slow' ? '⚠ over budget' : r.note ? r.note : ''} |`);
	}
	console.log('');
}
