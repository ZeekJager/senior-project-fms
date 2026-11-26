import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations } from './openapi';

/** Where each test file writes the operations it called and its drift (contract-hook.ts); emptied before a run. */
export const CONTRACT_DIR = join(tmpdir(), 'fms-contract');

export function resetContractRecords(): void {
  rmSync(CONTRACT_DIR, { recursive: true, force: true });
}

/**
 * After the run: how many of the spec's operations the integration tests called, and with which statuses; the ones never
 * called; and any drift. Written to contract-coverage.json (CI keeps it), summarised on the console.
 */
export function reportContractCoverage(outFile: string): { called: number; total: number } {
  if (!existsSync(CONTRACT_DIR)) return { called: 0, total: operations.length };
  const calls = new Map<string, Set<number>>();
  const drift: { where: string; problem: string }[] = [];
  for (const file of readdirSync(CONTRACT_DIR)) {
    for (const line of readFileSync(join(CONTRACT_DIR, file), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line) as { called?: string; drift?: string; problem?: string };
      if (entry.called) {
        const at = entry.called.lastIndexOf(' ');
        const op = entry.called.slice(0, at);
        if (!calls.has(op)) calls.set(op, new Set());
        calls.get(op)!.add(Number(entry.called.slice(at + 1)));
      }
      if (entry.drift && !drift.some((d) => d.where === entry.drift)) drift.push({ where: entry.drift, problem: entry.problem ?? '' });
    }
  }
  const all = operations.map((o) => `${o.method.toUpperCase()} ${o.path}`);
  const uncalled = all.filter((op) => !calls.has(op)).sort();
  const report = {
    operations: all.length,
    called: all.length - uncalled.length,
    uncalled,
    statuses: Object.fromEntries([...calls].sort(([a], [b]) => a.localeCompare(b)).map(([op, s]) => [op, [...s].sort()])),
    drift,
  };
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  return { called: report.called, total: report.operations };
}
