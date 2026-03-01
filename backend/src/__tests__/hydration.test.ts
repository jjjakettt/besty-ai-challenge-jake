import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * vi.mock is hoisted above const declarations by vitest's transformer, so
 * top-level vi.fn() variables would be undefined inside the factory.
 * vi.hoisted() runs before hoisting, making mockFetchGuest and mockUpdateGuestInfo
 * available both inside the vi.mock factory and in the test body.
 */
const { mockFetchGuest, mockUpdateGuestInfo } = vi.hoisted(() => ({
  mockFetchGuest: vi.fn(),
  mockUpdateGuestInfo: vi.fn(),
}));

vi.mock('../guestApi', () => ({
  fetchGuest: mockFetchGuest,
}));

vi.mock('../db', () => {
  // Pool is instantiated at module load — mock as a regular function (not vi.fn())
  // so it is constructable with `new` without throwing.
  function Pool() { return { query: vi.fn() }; }
  return {
    Pool,
    updateGuestInfo: mockUpdateGuestInfo,
  };
});

import { createHydrationQueue } from '../hydration';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createHydrationQueue', () => {
  /**
   * Happy path: when fetchGuest resolves with valid guest info,
   * the worker should persist it via updateGuestInfo and notify
   * connected SSE clients via emit.
   */
  it('calls updateGuestInfo and emit when fetchGuest returns info', async () => {
    const guestInfo = { first_name: 'Alice', last_name: 'Smith', email: 'a@b.com', phone: '123' };
    mockFetchGuest.mockResolvedValue(guestInfo);
    mockUpdateGuestInfo.mockResolvedValue(undefined);

    const emit = vi.fn();
    const enqueue = createHydrationQueue(emit);

    enqueue('guest-1');

    // Yield the event loop so the async worker can complete
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetchGuest).toHaveBeenCalledWith('guest-1');
    expect(mockUpdateGuestInfo).toHaveBeenCalledWith('guest-1', guestInfo);
    expect(emit).toHaveBeenCalledWith('guest-1');
  });

  /**
   * When fetchGuest returns null (guest not found or retries exhausted),
   * the worker should silently drop the job — no DB write, no SSE emit,
   * and no unhandled rejection.
   */
  it('does not call updateGuestInfo or emit when fetchGuest returns null', async () => {
    mockFetchGuest.mockResolvedValue(null);

    const emit = vi.fn();
    const enqueue = createHydrationQueue(emit);

    enqueue('guest-null');

    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetchGuest).toHaveBeenCalledWith('guest-null');
    expect(mockUpdateGuestInfo).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  /**
   * Two jobs enqueued back-to-back should both complete successfully.
   * Verifies that the drain loop correctly starts a second worker when
   * the first slot is still available (activeCount < MAX_CONCURRENT).
   */
  it('processes two jobs concurrently', async () => {
    const guestInfo = { first_name: 'Bob', last_name: 'Jones', email: 'b@c.com', phone: '456' };
    mockFetchGuest.mockResolvedValue(guestInfo);
    mockUpdateGuestInfo.mockResolvedValue(undefined);

    const emit = vi.fn();
    const enqueue = createHydrationQueue(emit);

    enqueue('guest-a');
    enqueue('guest-b');

    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetchGuest).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  /**
   * With 3 jobs and a cap of 2, the third job must wait until one of the
   * first two finishes. A counter spy tracks how many workers are active
   * simultaneously — the peak must never exceed MAX_CONCURRENT (2).
   * Each worker is given a 10ms delay to ensure overlap is detectable.
   */
  it('never exceeds 2 concurrent workers with 3 jobs', async () => {
    let peakActive = 0;
    let currentActive = 0;

    mockFetchGuest.mockImplementation(() => {
      currentActive++;
      if (currentActive > peakActive) peakActive = currentActive;
      return new Promise((resolve) => {
        setTimeout(() => {
          currentActive--;
          resolve({ first_name: 'X', last_name: 'Y', email: 'x@y.com', phone: '0' });
        }, 10);
      });
    });
    mockUpdateGuestInfo.mockResolvedValue(undefined);

    const emit = vi.fn();
    const enqueue = createHydrationQueue(emit);

    enqueue('guest-1');
    enqueue('guest-2');
    enqueue('guest-3');

    // Wait long enough for all 3 workers to complete sequentially
    await new Promise((r) => setTimeout(r, 100));

    expect(peakActive).toBeLessThanOrEqual(2);
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
