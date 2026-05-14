declare module 'probe-image-size' {
  interface ProbeResult {
    width: number;
    height: number;
    type: string;
    mime: string;
    wUnits: string;
    hUnits: string;
    url?: string;
  }

  function probe(
    input: import('stream').Readable | Buffer | string
  ): Promise<ProbeResult>;

  export = probe;
}
