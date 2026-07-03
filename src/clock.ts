export interface Clock { now(): string }
export class SystemClock implements Clock { now(): string { return new Date().toISOString() } }
export class FixedClock implements Clock {
  constructor(private t: string) {}
  set(t: string) { this.t = t }
  now(): string { return this.t }
}
