/**
 * fetchStream hands back the gateway's event stream as it arrives, and says
 * nothing about streaming being unsupported: the gateway streams.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shashu } from '../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sse(frames: string[], gapMs: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
        await new Promise((r) => setTimeout(r, gapMs));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('fetchStream', () => {
  it('prints no warning and yields chunks before the stream ends', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse(frames, 30))
    );
    const client = new Shashu({ baseUrl: 'http://gateway.test', apiKey: 'shashu_sk_x' });

    const res = await client.fetchStream('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Hel');
    expect(chunks.join('')).toContain('[DONE]');
    expect(warn).not.toHaveBeenCalled();
  });
});
