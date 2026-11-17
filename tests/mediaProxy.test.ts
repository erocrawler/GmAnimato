import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ env: { S3_ENDPOINT: 'https://s3.test/bucket' } as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: h.env }));

import { GET } from '../src/routes/media/[...path]/+server';

function streamOf(text: string) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function call(path: string, headers: Record<string, string> = {}) {
  const request = new Request('https://animato.test/media/' + path, { headers });
  try {
    return { res: (await (GET as any)({ params: { path }, request })) as Response };
  } catch (e: any) {
    return { thrown: e };
  }
}

describe('media proxy', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    h.env.S3_ENDPOINT = 'https://s3.test/bucket';
  });

  it('streams the upstream body without buffering it', async () => {
    const upstream = new Response(streamOf('hello-video'), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '11' },
    });
    const abSpy = vi.spyOn(upstream, 'arrayBuffer');
    fetchMock.mockResolvedValue(upstream);

    const { res } = await call('wan/out_01.mp4');
    expect(fetchMock).toHaveBeenCalledWith('https://s3.test/bucket/wan/out_01.mp4', { headers: {} });
    expect(res!.status).toBe(200);
    expect(res!.body).toBeInstanceOf(ReadableStream);
    expect(abSpy).not.toHaveBeenCalled();
    expect(res!.headers.get('content-type')).toBe('video/mp4');
    expect(res!.headers.get('content-length')).toBe('11');
    expect(res!.headers.get('accept-ranges')).toBe('bytes');
    expect(res!.headers.get('access-control-allow-origin')).toBe('*');
    expect(res!.headers.get('cache-control')).toContain('immutable');
    expect(await res!.text()).toBe('hello-video');
  });

  it('forwards Range and passes 206 + Content-Range through', async () => {
    fetchMock.mockResolvedValue(
      new Response(streamOf('abc'), {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 0-2/100', 'accept-ranges': 'bytes' },
      })
    );
    const { res } = await call('wan/a.mp4', { Range: 'bytes=0-2' });
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Range: 'bytes=0-2' } });
    expect(res!.status).toBe(206);
    expect(res!.headers.get('content-range')).toBe('bytes 0-2/100');
    expect(await res!.text()).toBe('abc');
  });

  it('propagates upstream errors (404) unchanged', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' }));
    const { thrown } = await call('wan/missing.mp4');
    expect(thrown.status).toBe(404);
  });

  it('rejects unsafe paths with 404 and never calls fetch', async () => {
    for (const bad of ['../secret', 'a/../b', 'a/%2e%2e/b', 'a%2fb', 'a?x=1', 'a#f', 'a//b', '/a', 'a/', 'a b', 'a/./b', 'x'.repeat(400)]) {
      const { thrown, res } = await call(bad);
      expect(res, bad).toBeUndefined();
      expect(thrown.status, bad).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still 400 for empty path, 500 when S3_ENDPOINT is missing', async () => {
    expect((await call('')).thrown.status).toBe(400);
    h.env.S3_ENDPOINT = undefined;
    expect((await call('wan/a.mp4')).thrown.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
