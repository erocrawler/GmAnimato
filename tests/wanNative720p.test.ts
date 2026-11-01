import { describe, expect, it, vi } from 'vitest';

// The builders probe image sizes over the network — pin the probe result (16:9 landscape).
vi.mock('probe-image-size', () => ({ default: async () => ({ width: 1920, height: 1080 }) }));

import { buildWorkflow as buildI2V } from '../src/lib/i2vWorkflow';
import { buildFL2VWorkflow } from '../src/lib/fl2vWorkflow';
import { calculateVideoDimensions } from '../src/lib/workflowUtils';
import { computeWorkflowQuotaCost, isQuotaCostRule } from '../src/lib/quotaCost';
import { normalizeWorkflowCapabilities, RESOLUTION_DISPLAY_NAME } from '../src/lib/workflowCapabilities';

const nodes = (wf: any, cls: string): any[] =>
  Object.values(wf.input.workflow as Record<string, any>).filter((n: any) => n.class_type === cls);

const i2vBase = { image_name: 'a.png', image_url: 'https://x/a.png', input_prompt: 'hi', seed: 1, iterationSteps: 4 as const };
const fl2vBase = {
  first_image_name: 'a.png', first_image_url: 'https://x/a.png',
  last_image_name: 'b.png', last_image_url: 'https://x/b.png',
  input_prompt: 'hi', seed: 1, iterationSteps: 4 as const,
};

describe("native Wan 720p ('720p-hd')", () => {
  it('uses the official 720p pixel budget (921,600), same numbers as the 720p target', () => {
    expect(calculateVideoDimensions(1920, 1080, '720p-hd')).toEqual({ width: 1280, height: 720 });
    expect(calculateVideoDimensions(1080, 1920, '720p-hd')).toEqual({ width: 720, height: 1280 });
  });

  it.each([
    ['i2v', () => buildI2V({ ...i2vBase, videoResolution: '720p-hd' }), () => buildI2V({ ...i2vBase, videoResolution: '720p' })],
    ['fl2v', () => buildFL2VWorkflow({ ...fl2vBase, videoResolution: '720p-hd' } as any), () => buildFL2VWorkflow({ ...fl2vBase, videoResolution: '720p' } as any)],
  ])('%s generates at 1280x720 with no ESRGAN node, while 720p stays 848x480 + ESRGAN 2x', async (_n, hd, esrgan) => {
    const a: any = await hd();
    const enc = nodes(a, 'WanImageToVideo').concat(nodes(a, 'WanFirstLastFrameToVideo'))[0];
    expect([enc.inputs.width, enc.inputs.height]).toEqual([1280, 720]);
    expect(a.input.workflow['999:upscale720p']).toBeUndefined();

    const b: any = await esrgan();
    const enc2 = nodes(b, 'WanImageToVideo').concat(nodes(b, 'WanFirstLastFrameToVideo'))[0];
    expect([enc2.inputs.width, enc2.inputs.height]).toEqual([848, 480]);
    expect(b.input.workflow['999:upscale720p']).toBeDefined();
  });

  it('768p still fails loudly on Wan', async () => {
    await expect(buildI2V({ ...i2vBase, videoResolution: '768p' })).rejects.toThrow(/768p/);
  });

  it('is a valid capability / quota-rule resolution and costs x2 as an integer', () => {
    expect(normalizeWorkflowCapabilities({ resolutions: ['480p', '720p', '720p-hd', 'bogus'] }).resolutions).toEqual(['480p', '720p', '720p-hd']);
    const rule = { id: 'res-720p-hd', label: '720p x2', multiplier: 2, when: { exactResolution: '720p-hd' } };
    expect(isQuotaCostRule(rule)).toBe(true);
    const wf = { quotaCost: 1, quotaCostRules: [rule] as any };
    expect(computeWorkflowQuotaCost(wf, { videoResolution: '720p-hd' } as any)).toBe(2);
    expect(computeWorkflowQuotaCost(wf, { videoResolution: '720p' } as any)).toBe(1);
  });

  it('names the ESRGAN route as such in messages', () => {
    expect(RESOLUTION_DISPLAY_NAME['720p']).toBe('ESRGAN 2x');
    expect(RESOLUTION_DISPLAY_NAME['720p-hd']).toBe('720p');
  });
});
