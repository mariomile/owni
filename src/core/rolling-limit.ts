/** At most `limit` events per key in a rolling window. In memory, for the process: a restart forgets it. */
export class RollingLimit {
	private readonly times = new Map<string, number[]>();

	constructor(
		readonly limit: number,
		readonly windowMs: number,
	) {}

	/** Whether `key` has room for one more event now. */
	room(key: string, now = Date.now()): boolean {
		return this.recent(key, now).length < this.limit;
	}

	/** Count one event for `key`, now. Keys with nothing left in the window are forgotten. */
	count(key: string, now = Date.now()): void {
		for (const [k, times] of this.times) if (times.every((t) => now - t >= this.windowMs)) this.times.delete(k);
		this.times.set(key, [...this.recent(key, now), now]);
	}

	/** Count one event for `key` if there is room; false when the window is full. */
	take(key: string, now = Date.now()): boolean {
		if (!this.room(key, now)) return false;
		this.count(key, now);
		return true;
	}

	private recent(key: string, now: number): number[] {
		return (this.times.get(key) ?? []).filter((t) => now - t < this.windowMs);
	}
}
