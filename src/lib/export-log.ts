/**
 * Small ring buffer of export-pipeline breadcrumbs. Exists so a failure on a
 * device with no reachable console (an iPhone in the field) can show WHAT
 * failed directly in the export sheet's error state — the log tail is the
 * diagnostic surface.
 */
const buffer: string[] = [];
const LIMIT = 48;

export function exportLog(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  buffer.push(`${stamp} ${message}`);
  if (buffer.length > LIMIT) buffer.shift();
  console.log('[export]', message);
}

export function exportLogTail(count = 12): string[] {
  return buffer.slice(-count);
}

export function clearExportLog(): void {
  buffer.length = 0;
}
