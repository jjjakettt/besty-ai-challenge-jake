import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

/**
 * vi.mock is hoisted above const declarations — use vi.hoisted() to create
 * mock functions that are available both inside vi.mock factories and in tests.
 */
const {
  mockUpsertReservation,
  mockGetAllReservations,
  mockCreateBroadcastJob,
  mockGetUnhydratedGuestIds,
  mockUpdateGuestInfo,
  mockInitDb,
  mockUpdateBroadcastJob,
  mockGetPendingBroadcastJobs,
  mockFetchGuest,
  mockSendMessage,
  mockRegisterWebhook,
  mockStartBroadcastWorker,
} = vi.hoisted(() => ({
  mockUpsertReservation:       vi.fn(),
  mockGetAllReservations:      vi.fn(),
  mockCreateBroadcastJob:      vi.fn(),
  // startServer() calls getUnhydratedGuestIds at module load time — default
  // to [] so the for-of loop doesn't throw before any test runs.
  mockGetUnhydratedGuestIds:   vi.fn().mockResolvedValue([]),
  mockUpdateGuestInfo:         vi.fn().mockResolvedValue(undefined),
  // startServer() awaits initDb — resolve immediately by default.
  mockInitDb:                  vi.fn().mockResolvedValue(undefined),
  mockUpdateBroadcastJob:      vi.fn(),
  mockGetPendingBroadcastJobs: vi.fn(),
  mockFetchGuest:              vi.fn(),
  mockSendMessage:             vi.fn(),
  // startServer() calls registerWebhook fire-and-forget — resolve immediately.
  mockRegisterWebhook:         vi.fn().mockResolvedValue(undefined),
  // startBroadcastWorker starts a setTimeout poll loop — mock it to a no-op
  // stop function so timers don't leak into other tests.
  mockStartBroadcastWorker:    vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../db', () => {
  // Pool is constructed with `new` at module load — use a regular function
  // (not vi.fn()) so it is constructable without throwing.
  function Pool() { return { query: vi.fn() }; }
  return {
    Pool,
    upsertReservation:       mockUpsertReservation,
    getAllReservations:       mockGetAllReservations,
    createBroadcastJob:      mockCreateBroadcastJob,
    getUnhydratedGuestIds:   mockGetUnhydratedGuestIds,
    updateGuestInfo:         mockUpdateGuestInfo,
    initDb:                  mockInitDb,
    updateBroadcastJob:      mockUpdateBroadcastJob,
    getPendingBroadcastJobs: mockGetPendingBroadcastJobs,
  };
});

vi.mock('../broadcast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../broadcast')>();
  return {
    ...actual,
    startBroadcastWorker: mockStartBroadcastWorker,
  };
});

vi.mock('../guestApi', () => ({
  fetchGuest:  mockFetchGuest,
  sendMessage: mockSendMessage,
}));

vi.mock('../register', () => ({
  registerWebhook: mockRegisterWebhook,
}));

// Must be set before createApp() is called because createWebhookRouter()
// reads WEBHOOK_SECRET at construction time and throws if missing.
process.env.WEBHOOK_SECRET = 'test-secret';

import { createApp } from '../index';

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

const validPayload = {
  reservation_id:  'res-1',
  property_id:     'prop-1',
  guest_id:        'guest-1',
  status:          'confirmed',
  check_in:        '2024-06-01',
  check_out:       '2024-06-05',
  num_guests:      2,
  total_amount:    '500.00',
  currency:        'USD',
  webhook_id:      'wh-1',
  event_timestamp: '2024-06-01T12:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertReservation.mockResolvedValue(undefined);
  mockGetAllReservations.mockResolvedValue([]);
  mockCreateBroadcastJob.mockResolvedValue(1);
});

// ---------------------------------------------------------------------------
// POST /webhooks
// ---------------------------------------------------------------------------

describe('POST /webhooks', () => {
  /**
   * Happy path: a valid payload with the correct secret header should be
   * accepted immediately (200) and trigger a fire-and-forget upsert.
   */
  it('valid payload with correct secret → 200 { ok: true }', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockUpsertReservation).toHaveBeenCalledTimes(1);
    expect(mockUpsertReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservation_id: 'res-1', guest_id: 'guest-1' }),
    );
  });

  /**
   * A request with the wrong secret must be rejected before any processing
   * so that unauthenticated callers cannot inject reservations.
   */
  it('wrong secret → 401', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', 'wrong-secret')
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(mockUpsertReservation).not.toHaveBeenCalled();
  });

  /**
   * A payload missing any of the 11 required fields must be rejected with 400
   * so the webhook sender gets actionable feedback on malformed events.
   */
  it('missing required field → 400', async () => {
    const { app } = createApp();
    const { guest_id: _omitted, ...incomplete } = validPayload;

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send(incomplete);

    expect(res.status).toBe(400);
    expect(mockUpsertReservation).not.toHaveBeenCalled();
  });

  /**
   * A second request with the same webhook_id must be treated as a duplicate
   * and skipped — upsertReservation should only be called once. This prevents
   * double-processing retried deliveries from the webhook sender.
   */
  it('duplicate webhook_id → 200, upsertReservation not called second time', async () => {
    const { app } = createApp();

    await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send(validPayload);

    const res2 = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', 'test-secret')
      .send(validPayload);

    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ ok: true });
    expect(mockUpsertReservation).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GET /reservations
// ---------------------------------------------------------------------------

describe('GET /reservations', () => {
  /**
   * The snapshot endpoint must return whatever getAllReservations returns so
   * the frontend can hydrate its full state on load or SSE reconnect.
   */
  it('returns 200 with the array from getAllReservations', async () => {
    const { app } = createApp();
    const rows = [{ reservation_id: 'res-1', guest_id: 'guest-1' }];
    mockGetAllReservations.mockResolvedValue(rows);

    const res = await request(app).get('/reservations');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// POST /broadcast
// ---------------------------------------------------------------------------

describe('POST /broadcast', () => {
  /**
   * A valid broadcast request must queue one job per guestId and return
   * { queued: N } immediately without blocking on job execution.
   */
  it('valid body → 200 { queued: N }, createBroadcastJob called once per guestId', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/broadcast')
      .send({ guestIds: ['g1', 'g2'], message: 'Hello guests!' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queued: 2 });
    expect(mockCreateBroadcastJob).toHaveBeenCalledTimes(2);
    expect(mockCreateBroadcastJob).toHaveBeenCalledWith('g1', 'Hello guests!');
    expect(mockCreateBroadcastJob).toHaveBeenCalledWith('g2', 'Hello guests!');
  });

  /**
   * A missing message field must be rejected with 400 before any DB write
   * so callers get immediate feedback on malformed requests.
   */
  it('missing message → 400', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/broadcast')
      .send({ guestIds: ['g1'] });

    expect(res.status).toBe(400);
    expect(mockCreateBroadcastJob).not.toHaveBeenCalled();
  });
});
