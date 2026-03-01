import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

/**
 * vi.mock is hoisted above const declarations by vitest's transformer, so
 * top-level vi.fn() variables would be undefined inside the factory.
 * vi.hoisted() runs before hoisting, making mockGetAllReservations available
 * both inside the vi.mock factory and in the test body.
 */
const { mockGetAllReservations } = vi.hoisted(() => ({
  mockGetAllReservations: vi.fn(),
}));

vi.mock('../db', () => {
  // Pool is instantiated at module load in db.ts — mock as a regular function
  // (not vi.fn()) so it is constructable with `new` without throwing.
  function Pool() { return { query: vi.fn() }; }
  return {
    Pool,
    getAllReservations: mockGetAllReservations,
  };
});

import { createSseManager } from '../sse';

/** Minimal Express app wrapping a fresh SSE manager for each test. */
function makeApp() {
  const app = express();
  const manager = createSseManager();
  app.use(manager.router);
  return { app, manager };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /reservations', () => {
  /**
   * Happy path: getAllReservations resolves with an array of rows.
   * The route should return 200 with that array as JSON.
   */
  it('returns 200 with the array from getAllReservations', async () => {
    const rows = [
      { reservation_id: 'r1', guest_id: 'g1', status: 'confirmed' },
      { reservation_id: 'r2', guest_id: 'g2', status: 'pending' },
    ];
    mockGetAllReservations.mockResolvedValue(rows);

    const { app } = makeApp();
    const res = await request(app).get('/reservations');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
  });

  /**
   * When getAllReservations rejects (e.g. DB connection lost), the route
   * should catch the error and respond with 500 instead of crashing the server.
   */
  it('returns 500 when getAllReservations rejects', async () => {
    mockGetAllReservations.mockRejectedValue(new Error('DB down'));

    const { app } = makeApp();
    const res = await request(app).get('/reservations');

    expect(res.status).toBe(500);
  });
});

describe('emit', () => {
  /**
   * emit() serialises { guestId, reservation } as a Server-Sent Events
   * data frame (`data: <JSON>\n\n`) and writes it to every connected client.
   * This test injects a mock Response to verify the write call directly,
   * bypassing the need for a live HTTP stream.
   */
  it('writes a data: ...\\n\\n SSE event to all connected clients', () => {
    const { manager } = makeApp();

    // Simulate a connected client by creating a mock Response-like object
    // with a write spy that succeeds.
    const mockWrite = vi.fn();
    const fakeRes = {
      setHeader: vi.fn(),
      write: mockWrite,
      on: vi.fn(),
    } as unknown as import('express').Response;

    // Register the fake client via the internal clients Set by calling
    // the route handler directly through a minimal app.
    const app = express();
    const sseManager = createSseManager();
    // Manually reach into the router by making a real GET /events request
    // so the fake response is added to the clients Set.
    // Instead, we trigger the route with our mock res.
    const router = sseManager.router;
    // Access the route handler by calling handle directly
    const req = { on: vi.fn() } as unknown as import('express').Request;
    // Find and invoke the /events route handler to register fakeRes
    (router as any).handle(
      Object.assign(req, { method: 'GET', url: '/events', path: '/events' }),
      fakeRes,
      () => {},
    );

    const reservation = { reservation_id: 'r1', guest_id: 'g1', status: 'confirmed' } as any;
    sseManager.emit('g1', reservation);

    expect(mockWrite).toHaveBeenCalledTimes(2); // once for ': connected\n\n', once for data frame
    const lastCall = mockWrite.mock.calls[1][0] as string;
    expect(lastCall).toMatch(/^data: /);
    expect(lastCall).toContain('"guestId":"g1"');
    expect(lastCall).toContain('"reservation_id":"r1"');
    expect(lastCall.endsWith('\n\n')).toBe(true);
  });

  /**
   * When a client's res.write() throws (simulating a broken TCP connection /
   * EPIPE error), emit() must catch the error and remove that client from the
   * active Set. Subsequent emit() calls must not attempt to write to the
   * removed client.
   */
  it('removes a client whose write() throws (broken pipe)', () => {
    const app = express();
    const sseManager = createSseManager();

    const throwingWrite = vi.fn().mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const fakeRes = {
      setHeader: vi.fn(),
      write: throwingWrite,
      on: vi.fn(),
    } as unknown as import('express').Response;

    const req = { on: vi.fn() } as unknown as import('express').Request;
    (sseManager.router as any).handle(
      Object.assign(req, { method: 'GET', url: '/events', path: '/events' }),
      fakeRes,
      () => {},
    );

    const reservation = { reservation_id: 'r1', guest_id: 'g1', status: 'confirmed' } as any;

    // First emit — write throws, client should be removed.
    // The initial ': connected\n\n' write in the route handler also throws,
    // but that happens synchronously in the route — only emit() removes from Set.
    // Reset call count before testing emit behaviour.
    throwingWrite.mockClear();

    sseManager.emit('g1', reservation);

    // Second emit — client already removed, write should NOT be called again.
    throwingWrite.mockClear();
    sseManager.emit('g1', reservation);

    expect(throwingWrite).not.toHaveBeenCalled();
  });

  /**
   * When the SSE client disconnects (browser navigates away, network drop),
   * Express fires the 'close' event on the Request. The handler registered
   * with req.on('close') must remove the Response from the active clients Set
   * so that future emit() calls do not attempt to write to a stale socket.
   */
  it('removes client from Set when req close event fires', () => {
    const sseManager = createSseManager();

    let closeHandler: (() => void) | undefined;
    const mockWrite = vi.fn();
    const fakeRes = {
      setHeader: vi.fn(),
      write: mockWrite,
      on: vi.fn(),
    } as unknown as import('express').Response;

    // Capture the close handler registered by the route.
    const fakeReq = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      }),
    } as unknown as import('express').Request;

    (sseManager.router as any).handle(
      Object.assign(fakeReq, { method: 'GET', url: '/events', path: '/events' }),
      fakeRes,
      () => {},
    );

    // Simulate disconnect
    expect(closeHandler).toBeDefined();
    closeHandler!();

    // After disconnect, emit should not write to the removed client.
    mockWrite.mockClear();
    const reservation = { reservation_id: 'r1', guest_id: 'g1', status: 'confirmed' } as any;
    sseManager.emit('g1', reservation);

    expect(mockWrite).not.toHaveBeenCalled();
  });
});
