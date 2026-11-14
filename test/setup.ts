/**
 * Suite-wide network guard.
 *
 * Nothing in this SDK's unit tests may reach the network. The tests that matter
 * most here are about an address the SDK must NOT invent, so a regression that
 * silently resolves to a host has to fail as a test error rather than as a slow
 * test or — worse — a request that quietly succeeds against a real gateway.
 *
 * `globalThis.fetch` is the only transport the SDK uses (client, tracer, audit),
 * so it is the one chokepoint. `net.Socket.connect` is hooked as well so a
 * future transport (an http.request, an agent library) cannot slip past.
 */
import { beforeEach } from 'vitest';
import net from 'node:net';

function refuse(what: string): never {
  throw new Error(`test attempted to reach the network via ${what}`);
}

// Reinstalled before every test so a `vi.stubGlobal`/spy in one test cannot
// leave the next one unguarded.
beforeEach(() => {
  // Rejects rather than throwing synchronously, so SDK code that awaits fetch
  // inside a try/catch sees the same shape a real connection failure has.
  globalThis.fetch = (() =>
    Promise.reject(
      new Error('test attempted to reach the network via fetch')
    )) as typeof globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket): net.Socket {
    return refuse('net.Socket.connect');
  } as typeof net.Socket.prototype.connect;
});
