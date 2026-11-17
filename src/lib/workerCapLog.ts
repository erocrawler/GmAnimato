/**
 * Workers poll /api/worker/task every few seconds and send the same capability
 * header each time, so logging it per poll floods the log. Log a worker's
 * capability line only the first time we see it, and again when it changes.
 *
 * The key identifies the poller: an explicit x-worker-id header if the worker
 * sends one, otherwise the user scope it polls for, otherwise 'default'.
 */
const lastSignature = new Map<string, string>();
const MAX_TRACKED_WORKERS = 200;

/** Returns true when this (key, signature) pair should be logged. */
export function shouldLogWorkerCapabilities(key: string, signature: string): boolean {
	if (lastSignature.get(key) === signature) return false;
	if (!lastSignature.has(key) && lastSignature.size >= MAX_TRACKED_WORKERS) {
		// Bound memory: forget the oldest tracked worker.
		const oldest = lastSignature.keys().next().value;
		if (oldest !== undefined) lastSignature.delete(oldest);
	}
	lastSignature.set(key, signature);
	return true;
}

export function resetWorkerCapabilityLog(): void {
	lastSignature.clear();
}
