import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg Pool before importing db
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  function Pool() { return { query: mockQuery }; }
  return { Pool };
});

// Also mock dotenv
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

import { pool, upsertReservation } from '../db';

const mockQuery = pool.query as ReturnType<typeof vi.fn>;

const base = {
  reservation_id: 'res-1',
  property_id: 'prop-1',
  guest_id: 'guest-1',
  status: 'confirmed',
  check_in: '2024-01-01',
  check_out: '2024-01-05',
  num_guests: 2,
  total_amount: '500.00',
  currency: 'USD',
  webhook_id: 'wh-1',
  event_timestamp: '2024-01-01T00:00:00Z',
};

beforeEach(() => mockQuery.mockReset());

describe('upsertReservation', () => {
  /**
   * Verifies the INSERT ... ON CONFLICT SQL is issued and all positional
   * parameters are bound in the correct order (reservation_id at $1, status at $4, etc.).
   */
  it('executes INSERT ... ON CONFLICT with correct params', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await upsertReservation(base);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (reservation_id)');
    expect(params[0]).toBe('res-1');
    expect(params[3]).toBe('confirmed');
  });

  /**
   * Ensures a newer event_timestamp and updated status are passed through
   * to the query. The DB WHERE clause (event_timestamp >= existing) will
   * allow the row to be updated.
   */
  it('passes newer timestamp — upsert WHERE allows update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const newer = { ...base, event_timestamp: '2024-06-01T00:00:00Z', status: 'modified' };
    await upsertReservation(newer);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[10]).toBe('2024-06-01T00:00:00Z');
    expect(params[3]).toBe('modified');
  });

  /**
   * Confirms the query is still issued for an older timestamp — the DB's
   * WHERE clause (EXCLUDED.event_timestamp >= reservations.event_timestamp)
   * is what silently drops the update, not application code.
   */
  it('passes older timestamp — DB WHERE clause handles the skip', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const older = { ...base, event_timestamp: '2023-01-01T00:00:00Z' };
    await upsertReservation(older);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  /**
   * Confirms the SQL contains the CASE expression that makes 'cancelled'
   * a terminal state — once cancelled, no subsequent event can change the status.
   */
  it('cancelled status is terminal — SQL CASE expression is present', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const cancelled = { ...base, status: 'cancelled' };
    await upsertReservation(cancelled);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("WHEN reservations.status = 'cancelled' THEN 'cancelled'");
  });

  /**
   * Ensures DB errors bubble up so the caller (webhook handler) can
   * respond appropriately rather than silently swallowing failures.
   */
  it('propagates DB errors to the caller', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(upsertReservation(base)).rejects.toThrow('DB error');
  });
});
