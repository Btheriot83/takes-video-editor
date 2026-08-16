/**
 * Small ring buffer of export-pipeline breadcrumbs. Exists so a failure on a
 * device with no reachable console (an iPhone in the field) can show WHAT
 * failed directly in the export sheet's error state — the log tail is the
 * diagnostic surface.
 */
const buffer: string[] = [];
const LIMIT = 48;

/**
 * Optional forwarding sink. The render worker installs one that posts each
 * line to the main thread, which re-logs it there (console + main buffer) —
 * so a set sink REPLACES the local console.log to avoid double-printing the
 * same line from both contexts (the e2e suite counts console lines).
 */
let sink: ((message: string) => void) | null = null;

export function setExportLogSink(fn: ((message: string) => void) | null): void {
  sink = fn;
}

export function exportLog(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  buffer.push(`${stamp} ${message}`);
  if (buffer.length > LIMIT) buffer.shift();
  if (sink) sink(message);
  else console.log('[export]', message);
}

export function exportLogTail(count = 12): string[] {
  return buffer.slice(-count);
}

export function clearExportLog(): void {
  buffer.length = 0;
}
