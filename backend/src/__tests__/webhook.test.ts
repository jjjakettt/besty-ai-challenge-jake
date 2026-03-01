import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * vi.mock is hoisted above const declarations by vitest's transformer, so
 * top-level vi.fn() variables would be undefined inside the factory.
 * vi.hoisted() runs before hoisting, making mockUpsert available both inside
 * the vi.mock factory and in the test body.
 */
const { mockUpsert } = vi.hoisted(() => ({
  mockUpsert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db', () => ({
  upsertReservation: mockUpsert,
}));

import { createWebhookRouter } from '../webhook';

const SECRET = 'test_secret';

const VALID_PAYLOAD = {
  reservation_id:  'res-1',
  property_id:     'prop-1',
  guest_id:        'guest-1',
  status:          'confirmed',
  check_in:        '2024-01-01',
  check_out:       '2024-01-05',
  num_guests:      2,
  total_amount:    '500.00',
  currency:        'USD',
  webhook_id:      'wh-1',
  event_timestamp: '2024-01-01T00:00:00Z',
};

/**
 * Creates a fresh Express app with a new router instance for each test.
 * Each call produces an isolated seenWebhookIds Set and fresh enqueue/emit
 * spies, preventing state leakage between tests.
 */
function makeApp() {
  const enqueue = vi.fn();
  const emit = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/webhooks', createWebhookRouter(enqueue, emit));
  return { app, enqueue, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsert.mockResolvedValue(undefined);
  process.env.WEBHOOK_SECRET = SECRET;
});

describe('POST /webhooks', () => {
  /**
   * Happy path: a complete, valid payload with the correct secret should
   * return 200 and trigger upsert, enqueue, and emit exactly once.
   */
  it('valid payload → 200, upsert/enqueue/emit called', async () => {
    const { app, enqueue, emit } = makeApp();

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', SECRET)
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith('guest-1');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ reservation_id: 'res-1' }));
  });

  /**
   * An incorrect or missing X-Webhook-Secret header must be rejected with
   * 401. No downstream work (upsert, enqueue, emit) should occur.
   */
  it('wrong secret → 401, nothing else called', async () => {
    const { app, enqueue, emit } = makeApp();

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', 'wrong-secret')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  /**
   * A payload missing any required field (here: guest_id) must be rejected
   * with 400. Upsert must not be called with incomplete data.
   */
  it('missing required field → 400', async () => {
    const { app } = makeApp();
    const { guest_id: _, ...payload } = VALID_PAYLOAD;

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', SECRET)
      .send(payload);

    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  /**
   * A webhook_id that has already been processed must be silently accepted
   * (200) but not re-processed. Upsert should only be called once across
   * both requests, preventing duplicate DB writes for the same event.
   */
  it('duplicate webhook_id → 200, upsert NOT called second time', async () => {
    const { app } = makeApp();

    await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', SECRET)
      .send(VALID_PAYLOAD);

    const res2 = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', SECRET)
      .send(VALID_PAYLOAD);

    expect(res2.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });
});
