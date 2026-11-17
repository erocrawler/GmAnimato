import { beforeEach, describe, expect, it } from 'vitest';
import { resetWorkerCapabilityLog, shouldLogWorkerCapabilities } from '../src/lib/workerCapLog';

describe('shouldLogWorkerCapabilities', () => {
	beforeEach(() => resetWorkerCapabilityLog());

	it('logs the first sighting of a worker', () => {
		expect(shouldLogWorkerCapabilities('w1', 'declared:sage_attention|sage:true')).toBe(true);
	});

	it('stays quiet while the same worker sends the same capabilities', () => {
		shouldLogWorkerCapabilities('w1', 'a');
		expect(shouldLogWorkerCapabilities('w1', 'a')).toBe(false);
		expect(shouldLogWorkerCapabilities('w1', 'a')).toBe(false);
	});

	it('logs again when the capabilities change, then quiet again', () => {
		shouldLogWorkerCapabilities('w1', 'a');
		expect(shouldLogWorkerCapabilities('w1', 'b')).toBe(true);
		expect(shouldLogWorkerCapabilities('w1', 'b')).toBe(false);
	});

	it('tracks workers independently', () => {
		shouldLogWorkerCapabilities('w1', 'a');
		expect(shouldLogWorkerCapabilities('w2', 'a')).toBe(true);
	});

	it('bounds tracked workers', () => {
		for (let i = 0; i < 300; i++) shouldLogWorkerCapabilities(`w${i}`, 'a');
		// oldest were evicted, so they log again; recent ones stay quiet
		expect(shouldLogWorkerCapabilities('w0', 'a')).toBe(true);
		expect(shouldLogWorkerCapabilities('w299', 'a')).toBe(false);
	});
});
