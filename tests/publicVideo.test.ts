import { describe, expect, it } from 'vitest';
import { toPublicVideo } from '../src/lib/publicVideo';

describe('toPublicVideo', () => {
  it('drops the job id, which the public webhook treats as a credential', () => {
    const v = { id: 'v1', job_id: 'local-v1-abc', status: 'completed', final_video_url: '/media/a.mp4' };
    const pub = toPublicVideo(v) as any;
    expect(pub.job_id).toBeUndefined();
    expect('job_id' in pub).toBe(false);
    expect(pub).toMatchObject({ id: 'v1', status: 'completed', final_video_url: '/media/a.mp4' });
  });

  it('does not mutate the original entry', () => {
    const v = { id: 'v1', job_id: 'x' };
    toPublicVideo(v);
    expect(v.job_id).toBe('x');
  });
});
