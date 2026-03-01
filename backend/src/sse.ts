import { Router, Request, Response } from 'express';
import { getAllReservations, ReservationRow } from './db';

export interface SseManager {
  router: Router;
  emit: (guestId: string, reservation: ReservationRow) => void;
}

/**
 * Factory that creates an isolated SSE manager per call.
 * Each call gets its own Set of active clients so that test cases
 * don't bleed state into each other.
 */
export function createSseManager(): SseManager {
  const clients = new Set<Response>();
  const router = Router();

  /**
   * GET /events — long-lived SSE stream.
   * Sets required headers, registers the client, sends an initial flush comment,
   * and removes the client when the connection closes.
   */
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    clients.add(res);

    // Initial comment flushes the response buffer so the browser
    // recognises this as a live stream immediately.
    res.write(': connected\n\n');

    req.on('close', () => {
      clients.delete(res);
    });
  });

  /**
   * GET /reservations — snapshot of all reservations for initial page load
   * and SSE reconnect scenarios. Returns a JSON array ordered by created_at DESC.
   */
  router.get('/reservations', async (_req: Request, res: Response) => {
    try {
      const rows = await getAllReservations();
      res.json(rows);
    } catch (err) {
      console.error('[sse] getAllReservations error:', err);
      res.status(500).json({ error: 'Failed to fetch reservations' });
    }
  });

  /**
   * Broadcasts a reservation update to all connected SSE clients.
   * Broken connections (write throws) are silently removed from the Set
   * so they don't accumulate over time. This function never throws.
   */
  function emit(guestId: string, reservation: ReservationRow): void {
    const payload = JSON.stringify({ guestId, reservation });
    const toRemove: Response[] = [];

    for (const client of clients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        // Broken pipe — schedule removal after iteration to avoid mutating
        // the Set while iterating over it.
        toRemove.push(client);
      }
    }

    for (const client of toRemove) {
      clients.delete(client);
    }
  }

  return { router, emit };
}
