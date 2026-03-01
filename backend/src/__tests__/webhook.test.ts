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

  /**
   * The real webhook-sender wraps fields in a nested `data` object using
   * camelCase keys, with webhookId and timestamp at the top level.
   * All fields must be mapped correctly before upsert is called.
   */
  it('real nested camelCase payload → 200, fields correctly mapped', async () => {
    const { app, enqueue, emit } = makeApp();

    const nested = {
      event:     'reservation.created',
      timestamp: '2026-03-01T22:33:06.252Z',
      webhookId: 'wh-nested-1',
      data: {
        reservationId: 'res-nested-1',
        propertyId:    'prop-1',
        guestId:       'guest-nested',
        status:        'confirmed',
        checkIn:       '2026-04-06',
        checkOut:      '2026-04-13',
        numGuests:     5,
        totalAmount:   1869.59,
        currency:      'USD',
      },
    };

    const res = await request(app)
      .post('/webhooks')
      .set('x-webhook-secret', SECRET)
      .send(nested);

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation_id:  'res-nested-1',
        guest_id:        'guest-nested',
        webhook_id:      'wh-nested-1',
        event_timestamp: '2026-03-01T22:33:06.252Z',
        num_guests:      5,
        total_amount:    '1869.59',
        check_in:        '2026-04-06',
        check_out:       '2026-04-13',
      }),
    );
    expect(enqueue).toHaveBeenCalledWith('guest-nested');
    expect(emit).toHaveBeenCalledOnce();
  });

  /**
   * A rapid burst of N concurrent requests with distinct webhook_ids must
   * all return 200 and each trigger exactly one upsert. The in-memory dedup
   * Set must not incorrectly merge distinct events.
   */
  it('rapid burst — 5 concurrent unique webhook_ids all accepted', async () => {
    const { app } = makeApp();

    const payloads = Array.from({ length: 5 }, (_, i) => ({
      ...VALID_PAYLOAD,
      webhook_id:      `wh-burst-${i}`,
      event_timestamp: `2024-01-01T00:00:0${i}Z`,
    }));

    const results = await Promise.all(
      payloads.map((p) =>
        request(app)
          .post('/webhooks')
          .set('x-webhook-secret', SECRET)
          .send(p),
      ),
    );

    for (const r of results) expect(r.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(5);
  });

  /**
   * Out-of-order delivery: a newer event arrives first, then an older one for
   * the same reservation. Both must be accepted with 200 — the webhook layer
   * does not filter by timestamp. The DB upsert's WHERE clause guards against
   * stale overwrites at the persistence layer.
   */
  it('out-of-order delivery — both accepted, upsert called twice', async () => {
    const { app } = makeApp();

    const newer = { ...VALID_PAYLOAD, webhook_id: 'wh-newer', event_timestamp: '2024-01-01T02:00:00Z' };
    const older = { ...VALID_PAYLOAD, webhook_id: 'wh-older', event_timestamp: '2024-01-01T01:00:00Z' };

    const res1 = await request(app).post('/webhooks').set('x-webhook-secret', SECRET).send(newer);
    const res2 = await request(app).post('/webhooks').set('x-webhook-secret', SECRET).send(older);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });
});
