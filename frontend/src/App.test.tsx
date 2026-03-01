import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Reservation } from './types';
import { StatusBadge } from './components/StatusBadge';

// --- EventSource mock ---
class MockEventSource {
  static instance: MockEventSource;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  close = vi.fn();
  constructor(_url: string) { MockEventSource.instance = this; }
}
vi.stubGlobal('EventSource', MockEventSource);

// --- fetch mock ---
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeRes(data: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(data) } as Response);
}

function fireSSE(reservation: Partial<Reservation>) {
  MockEventSource.instance.onmessage?.({
    data: JSON.stringify({ guestId: reservation.guest_id, reservation }),
  } as MessageEvent);
}

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservation_id: 'res-1',
    property_id: 'prop-1',
    guest_id: 'guest-1',
    status: 'confirmed',
    check_in: '2024-06-01',
    check_out: '2024-06-05',
    num_guests: 2,
    total_amount: '500.00',
    currency: 'USD',
    webhook_id: 'wh-1',
    event_timestamp: '2024-01-01T00:00:00Z',
    guest_first_name: 'Alice',
    guest_last_name: 'Smith',
    guest_email: 'alice@example.com',
    ...overrides,
  };
}

// Lazy import App so stubGlobal is in place first
async function renderApp() {
  const { default: App } = await import('./App');
  return render(<App />);
}

beforeEach(() => {
  vi.resetModules();
  mockFetch.mockReturnValue(makeRes([]));
  // reset static instance
  (MockEventSource as unknown as { instance: undefined }).instance = undefined as unknown as MockEventSource;
});

describe('App', () => {
  it('1. initial load renders rows', async () => {
    const rows = [
      makeReservation({ reservation_id: 'r1', guest_first_name: 'Alice', guest_last_name: 'Smith' }),
      makeReservation({ reservation_id: 'r2', guest_first_name: 'Bob', guest_last_name: 'Jones' }),
    ];
    mockFetch.mockReturnValue(makeRes(rows));
    await renderApp();
    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
      expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    });
  });

  it('2. new SSE reservation appears', async () => {
    mockFetch.mockReturnValue(makeRes([]));
    await renderApp();
    await waitFor(() => expect(MockEventSource.instance).toBeDefined());
    const r = makeReservation({ reservation_id: 'r-new', guest_first_name: 'Carol', guest_last_name: 'White' });
    act(() => { fireSSE(r); });
    await waitFor(() => expect(screen.getByText('Carol White')).toBeInTheDocument());
  });

  it('3. SSE update merges — no duplicate', async () => {
    const r = makeReservation({ status: 'confirmed' });
    mockFetch.mockReturnValue(makeRes([r]));
    await renderApp();
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    act(() => { fireSSE({ ...r, status: 'cancelled' }); });
    await waitFor(() => {
      const rows = screen.getAllByRole('row');
      // header + 1 data row only
      expect(rows).toHaveLength(2);
      expect(screen.getByRole('cell', { name: /cancelled/ })).toBeInTheDocument();
    });
  });

  it('4. status filter hides non-matching rows', async () => {
    const confirmed = makeReservation({ reservation_id: 'r1', status: 'confirmed', guest_first_name: 'Alice', guest_last_name: 'Smith' });
    const cancelled = makeReservation({ reservation_id: 'r2', status: 'cancelled', guest_first_name: 'Bob', guest_last_name: 'Jones' });
    mockFetch.mockReturnValue(makeRes([confirmed, cancelled]));
    await renderApp();
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const statusSelect = screen.getByRole('combobox', { name: /status/i });
    await userEvent.selectOptions(statusSelect, 'confirmed');

    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument();
      expect(screen.queryByText('Bob Jones')).not.toBeInTheDocument();
    });
  });

  it('5. broadcast panel hidden with no filter', async () => {
    const r = makeReservation();
    mockFetch.mockReturnValue(makeRes([r]));
    await renderApp();
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('6. broadcast panel visible when filter active', async () => {
    const r = makeReservation({ status: 'confirmed', guest_id: 'g1' });
    mockFetch.mockReturnValue(makeRes([r]));
    await renderApp();
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());

    const statusSelect = screen.getByRole('combobox', { name: /status/i });
    await userEvent.selectOptions(statusSelect, 'confirmed');

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /broadcast to 1 guest/i })).toBeInTheDocument();
    });
  });

  it('7. broadcast submit sends correct deduped guestIds', async () => {
    const r1 = makeReservation({ reservation_id: 'r1', guest_id: 'shared-guest', status: 'confirmed' });
    const r2 = makeReservation({ reservation_id: 'r2', guest_id: 'shared-guest', status: 'confirmed', guest_first_name: 'Alice2' });
    mockFetch.mockReturnValue(makeRes([r1, r2]));
    await renderApp();
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));

    const statusSelect = screen.getByRole('combobox', { name: /status/i });
    await userEvent.selectOptions(statusSelect, 'confirmed');

    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument());

    // Reset mock so next call is for /api/broadcast
    mockFetch.mockReturnValue(makeRes({ ok: true }));

    await userEvent.type(screen.getByRole('textbox'), 'Hello guests');
    await userEvent.click(screen.getByRole('button', { name: /broadcast/i }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls;
      const broadcastCall = calls.find((c) => c[0] === '/api/broadcast');
      expect(broadcastCall).toBeDefined();
      const body = JSON.parse(broadcastCall![1].body);
      expect(body.guestIds).toEqual(['shared-guest']);
      expect(body.message).toBe('Hello guests');
    });
  });

  it('8. StatusBadge colour per status', () => {
    const statuses = [
      { status: 'confirmed', expected: 'green' },
      { status: 'modified', expected: 'goldenrod' },
      { status: 'cancelled', expected: 'red' },
      { status: 'unknown', expected: 'grey' },
    ];
    for (const { status, expected } of statuses) {
      const { unmount } = render(<StatusBadge status={status} />);
      const el = screen.getByText(status);
      expect(el).toHaveAttribute('data-status', status);
      expect(el).toHaveStyle({ background: expected });
      unmount();
    }
  });
});

// Need JSX in scope
import React from 'react';
