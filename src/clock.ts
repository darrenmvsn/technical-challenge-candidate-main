export interface Clock { now(): string }
export class SystemClock implements Clock { now(): string { return new Date().toISOString() } }
export class FixedClock implements Clock {
  constructor(private t: string) {}
  set(t: string) { this.t = t }
  now(): string { return this.t }
}

/**
 * Date arithmetic helper (AGENTS.md invariant #3): all "now + N ms" computation for
 * leases/backoff lives here, not inlined in worker/repo code. Pure function — takes an
 * already-read ISO-8601 timestamp, does no wall-clock reads itself.
 */
export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString()
}
