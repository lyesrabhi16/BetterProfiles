// A tiny benchmark kit for the performance tests. Two kinds of check, because a fixed time limit means different things on
// different machines:
//   - `within`: a generous time budget (scaled by BP_PERF_SCALE for slow runners). It catches a hot path that got much slower.
//   - `scalesLinearly`: how the time grows when the data grows. It does not depend on the machine, so it catches
//     an accidental quadratic loop anywhere.
// Every measurement is also written to perf-results/<file>.json (BP_PERF_OUT changes the folder) for CI to keep.

import * as fs from 'fs';
import * as path from 'path';

const SCALE = Number(process.env.BP_PERF_SCALE ?? '1') || 1;
const OUT = process.env.BP_PERF_OUT ?? path.resolve(__dirname, '../../../perf-results');

export interface Measurement {
	name: string;
	/** Median of the timed runs, in milliseconds. */
	ms: number;
	budgetMs?: number;
	runs: number;
	note?: string;
}

const results: Measurement[] = [];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Median time of `fn`, after warm-up runs (the first runs include the JIT warming up). */
export async function measure(fn: () => unknown | Promise<unknown>, options: { runs?: number; warmup?: number } = {}): Promise<number> {
	const runs = options.runs ?? 9;
	for (let i = 0; i < (options.warmup ?? 2); i++) {
		await fn();
	}
	const times: number[] = [];
	for (let i = 0; i < runs; i++) {
		const start = process.hrtime.bigint();
		await fn();
		times.push(Number(process.hrtime.bigint() - start) / 1e6);
	}
	return median(times);
}

export function record(measurement: Measurement): void {
	results.push(measurement);
}

/** Measures \`fn\`, records it, and fails when it takes longer than the budget (scaled for slow machines). */
export async function within(name: string, budgetMs: number, fn: () => unknown | Promise<unknown>, options: { runs?: number; warmup?: number } = {}): Promise<number> {
	const ms = await measure(fn, options);
	const budget = budgetMs * SCALE;
	record({ name, ms: Math.round(ms * 100) / 100, budgetMs: budget, runs: options.runs ?? 9 });
	if (ms > budget) {
		throw new Error(`${name} took ${ms.toFixed(1)} ms, the budget is ${budget} ms`);
	}
	return ms;
}

/**
 * Runs \`build(n)\` for a small and a large n (the large one \`factor\` times bigger) and fails when the time grew by more
 * than \`maxRatio\` times the growth of the data: 1 for linear work, so a ratio of 2 allows some slack, while quadratic work
 * would grow by the factor squared.
 */
export async function scalesLinearly(name: string, build: (n: number) => () => unknown | Promise<unknown>, options: { small?: number; factor?: number; maxRatio?: number; runs?: number } = {}): Promise<void> {
	const small = options.small ?? 500;
	const factor = options.factor ?? 4;
	const maxRatio = options.maxRatio ?? 2.5;
	const smallMs = Math.max(await measure(build(small), { runs: options.runs ?? 7 }), 0.05); // below that, a clock is all there is
	const largeMs = await measure(build(small * factor), { runs: options.runs ?? 7 });
	const ratio = largeMs / smallMs / factor;
	record({ name: `${name} (growth)`, ms: Math.round(largeMs * 100) / 100, runs: options.runs ?? 7, note: `${factor}x the data took ${(largeMs / smallMs).toFixed(1)}x the time (limit ${(factor * maxRatio).toFixed(1)}x)` });
	if (ratio > maxRatio) {
		throw new Error(`${name}: ${factor}x the data took ${(largeMs / smallMs).toFixed(1)}x the time (small ${smallMs.toFixed(2)} ms, large ${largeMs.toFixed(2)} ms); linear work would be about ${factor}x. That looks like a loop inside a loop.`);
	}
}

/** Writes everything measured so far. Call it from an \`after\` hook. */
export function flush(file: string): void {
	fs.mkdirSync(OUT, { recursive: true });
	fs.writeFileSync(path.join(OUT, `${file}.json`), JSON.stringify({ at: new Date().toISOString(), node: process.version, scale: SCALE, results }, null, 2) + '\n');
}

/** Data for the benchmarks. */
export const ext = (i: number) => `pub${i % 50}.ext${i}`;
export const range = (n: number) => Array.from({ length: n }, (_, i) => i);
