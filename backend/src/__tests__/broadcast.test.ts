import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

/**
 * vi.mock is hoisted above const declarations by vitest's transformer, so
 * top-level vi.fn() variables would be undefined inside the factory.
 * vi.hoisted() runs before hoisting, making all mock functions available
 * both inside the vi.mock factories and in the test body.
 */
const { mockCreateBroadcastJob, mockGetPendingBroadcastJobs, mockUpdateBroadcastJob, mockSendMessage } =
  vi.hoisted(() => ({
    mockCreateBroadcastJob: vi.fn(),
    mockGetPendingBroadcastJobs: vi.fn(),
    mockUpdateBroadcastJob: vi.fn(),
    mockSendMessage: vi.fn(),
  }));

vi.mock('../db', () => {
  // Pool is instantiated at module load in db.ts — mock as a regular function
  // (not vi.fn()) so it is constructable with `new` without throwing.
  function Pool() { return { query: vi.fn() }; }
  return {
    Pool,
    createBroadcastJob: mockCreateBroadcastJob,
    getPendingBroadcastJobs: mockGetPendingBroadcastJobs,
    updateBroadcastJob: mockUpdateBroadcastJob,
  };
});

vi.mock('../guestApi', () => ({
  sendMessage: mockSendMessage,
}));

import { createBroadcastRouter, startBroadcastWorker } from '../broadcast';

/** Minimal Express app wrapping a fresh broadcast router for each test. */
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(createBroadcastRouter(vi.fn()));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore real timers so fake timer state does not leak between tests
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

describe('POST /broadcast', () => {
  /**
   * Happy path: valid guestIds array + message should queue one job per
   * guestId and return 200 { queued: N } immediately without blocking.
   */
  it('returns 200 with queued count and creates one job per guestId', async () => {
    mockCreateBroadcastJob.mockResolvedValue(1);

    const res = await request(makeApp())
      .post('/broadcast')
      .send({ guestIds: ['g1', 'g2'], message: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: 2 });

    // createBroadcastJob is called synchronously in the route loop before the
    // response is flushed, so the calls are observable without extra awaiting.
    expect(mockCreateBroadcastJob).toHaveBeenCalledTimes(2);
    expect(mockCreateBroadcastJob).toHaveBeenCalledWith('g1', 'Hello');
    expect(mockCreateBroadcastJob).toHaveBeenCalledWith('g2', 'Hello');
  });

  /**
   * Missing message field should be rejected with 400 before any DB write
   * so callers get immediate feedback on malformed requests.
   */
  it('returns 400 when message is missing', async () => {
    const res = await request(makeApp())
      .post('/broadcast')
      .send({ guestIds: ['g1'] });

    expect(res.status).toBe(400);
    expect(mockCreateBroadcastJob).not.toHaveBeenCalled();
  });

  /**
   * An empty guestIds array is semantically invalid — there is nobody to
   * message — so the route rejects it with 400 without touching the DB.
   */
  it('returns 400 when guestIds is an empty array', async () => {
    const res = await request(makeApp())
      .post('/broadcast')
      .send({ guestIds: [], message: 'Hello' });

    expect(res.status).toBe(400);
    expect(mockCreateBroadcastJob).not.toHaveBeenCalled();
  });

  /**
   * The route is fire-and-forget: it enqueues jobs and returns immediately.
   * sendMessage is only invoked by the background worker, never by the route.
   */
  it('does not call sendMessage (job execution is deferred to the worker)', async () => {
    mockCreateBroadcastJob.mockResolvedValue(1);

    const res = await request(makeApp())
      .post('/broadcast')
      .send({ guestIds: ['g1'], message: 'Hello' });

    expect(res.status).toBe(200);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Worker tests (fake timers)
// ---------------------------------------------------------------------------

describe('startBroadcastWorker', () => {
  /**
   * When sendMessage returns 200 the worker should mark the job 'sent'
   * and record the new attempt count so retries are not re-sent.
   */
  it('marks job as sent when sendMessage returns 200', async () => {
    const job = { id: 1, guest_id: 'g1', message: 'Hello', attempts: 0 };
    mockGetPendingBroadcastJobs.mockResolvedValueOnce([job]).mockResolvedValue([]);
    mockSendMessage.mockResolvedValue({ statusCode: 200 });
    mockUpdateBroadcastJob.mockResolvedValue(undefined);

    vi.useFakeTimers();
    const stop = startBroadcastWorker();

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockUpdateBroadcastJob).toHaveBeenCalledWith(1, 'sent', 1);
    stop();
  });

  /**
   * A 404 response from the Guest API means the guest does not exist.
   * This is a permanent failure — the worker should mark the job 'failed'
   * and never retry it.
   */
  it('marks job as failed when sendMessage returns 404', async () => {
    const job = { id: 1, guest_id: 'g1', message: 'Hello', attempts: 0 };
    mockGetPendingBroadcastJobs.mockResolvedValueOnce([job]).mockResolvedValue([]);
    mockSendMessage.mockResolvedValue({ statusCode: 404 });
    mockUpdateBroadcastJob.mockResolvedValue(undefined);

    vi.useFakeTimers();
    const stop = startBroadcastWorker();

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockUpdateBroadcastJob).toHaveBeenCalledWith(1, 'failed', 1);
    stop();
  });

  /**
   * When a 5xx response pushes the total attempt count to MAX_ATTEMPTS (5),
   * the worker should mark the job 'failed' rather than leave it pending for
   * a poll that would never succeed.
   */
  it('marks job as failed when max attempts reached (4 prior + 500 = 5)', async () => {
    const job = { id: 1, guest_id: 'g1', message: 'Hello', attempts: 4 };
    mockGetPendingBroadcastJobs.mockResolvedValueOnce([job]).mockResolvedValue([]);
    mockSendMessage.mockResolvedValue({ statusCode: 500 });
    mockUpdateBroadcastJob.mockResolvedValue(undefined);

    vi.useFakeTimers();
    const stop = startBroadcastWorker();

    await vi.advanceTimersByTimeAsync(2000);

    expect(mockUpdateBroadcastJob).toHaveBeenCalledWith(1, 'failed', 5);
    stop();
  });

  /**
   * When a 5xx response occurs but total attempts (3) are still below the
   * MAX_ATTEMPTS limit, the worker must NOT mark the job 'failed'. Instead
   * it updates the attempt count and leaves the status 'pending' so the next
   * poll will retry it.
   */
  it('leaves job pending when attempts < max (2 prior + 500 → 3 total)', async () => {
    const job = { id: 1, guest_id: 'g1', message: 'Hello', attempts: 2 };
    mockGetPendingBroadcastJobs.mockResolvedValueOnce([job]).mockResolvedValue([]);
    mockSendMessage.mockResolvedValue({ statusCode: 500 });
    mockUpdateBroadcastJob.mockResolvedValue(undefined);

    vi.useFakeTimers();
    const stop = startBroadcastWorker();

    await vi.advanceTimersByTimeAsync(2000);

    // Must NOT mark as failed — the job should stay retryable
    expect(mockUpdateBroadcastJob).not.toHaveBeenCalledWith(expect.anything(), 'failed', expect.anything());
    // Must update the attempt count so the DB reflects progress toward the limit
    expect(mockUpdateBroadcastJob).toHaveBeenCalledWith(1, 'pending', 3);
    stop();
  });

  /**
   * Calling stop() sets the internal stopped flag. Any setTimeout callback
   * that fires after stop() returns immediately without polling the DB,
   * ensuring the worker loop terminates cleanly.
   */
  it('stop() prevents further polling after the first poll', async () => {
    mockGetPendingBroadcastJobs.mockResolvedValue([]);

    vi.useFakeTimers();
    const stop = startBroadcastWorker();

    // Let the first poll fire
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockGetPendingBroadcastJobs).toHaveBeenCalledTimes(1);

    stop();

    // Advance past the next scheduled poll — it should not fire
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockGetPendingBroadcastJobs).toHaveBeenCalledTimes(1);
  });
});
