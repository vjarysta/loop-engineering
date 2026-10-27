export interface TableOptions {
  /** Indexes of the columns to right-align (numbers). */
  readonly rightAlign?: readonly number[];
  /** A totals row, separated from the body by a rule. */
  readonly footer?: readonly string[];
}

export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string {
  const all = [headers, ...rows, ...(options.footer === undefined ? [] : [options.footer])];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => (row[column] ?? "").length)));
  const rightAlign = new Set(options.rightAlign ?? []);

  const line = (row: readonly string[]): string =>
    widths
      .map((width, column) => {
        const cell = row[column] ?? "";
        return rightAlign.has(column) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join("  ")
      .trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("  ");

  return [
    line(headers),
    rule,
    ...rows.map(line),
    ...(options.footer === undefined ? [] : [rule, line(options.footer)]),
  ].join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (ms < 3_600_000) {
    return `${String(Math.floor(totalSeconds / 60))}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  return `${String(Math.floor(totalMinutes / 60))}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
