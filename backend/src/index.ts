import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { createSseManager } from './sse';
import { createHydrationQueue } from './hydration';
import { createWebhookRouter } from './webhook';
import { createBroadcastRouter, startBroadcastWorker } from './broadcast';
import { initDb, getUnhydratedGuestIds, ReservationRow } from './db';
import { registerWebhook } from './register';

/**
 * Pure factory — creates and returns the Express app with all middleware and
 * routes mounted. No side effects: no listen, no DB calls, no registration.
 * Returns enqueue alongside app so startServer() can re-enqueue on startup.
 */
export function createApp(): { app: express.Application; enqueue: (guestId: string) => void } {
  const app = express();
  const sseManager = createSseManager();

  // hydration.ts emit only takes guestId (no ReservationRow available after
  // updateGuestInfo); clients can call GET /reservations to pick up updated
  // guest fields. This keeps the hydration module decoupled from SSE shape.
  const hydrateEmit = (_guestId: string): void => { /* intentional no-op */ };
  const enqueue = createHydrationQueue(hydrateEmit);

  app.use(express.json());
  app.use(sseManager.router);                          // GET /events, GET /reservations
  app.use(
    '/webhooks',
    createWebhookRouter(enqueue, (r: ReservationRow) => sseManager.emit(r.guest_id, r)),
  );
  app.use(createBroadcastRouter(sseManager.emit));     // POST /broadcast

  return { app, enqueue };
}

/**
 * Starts the HTTP server, then runs startup tasks in order:
 *   1. initDb — ensures broadcast_jobs table exists
 *   2. Re-enqueue unhydrated guests from existing reservations
 *   3. startBroadcastWorker — begin polling pending broadcast jobs
 *   4. registerWebhook — fire-and-forget; retries in background until Guest API is ready
 */
export async function startServer(): Promise<void> {
  const port = parseInt(process.env.PORT || '3000', 10);
  const { app, enqueue } = createApp();

  app.listen(port, () => {
    console.log(`[server] Listening on port ${port}`);
  });

  await initDb();
  console.log('[server] DB initialized');

  const unhydrated = await getUnhydratedGuestIds();
  for (const guestId of unhydrated) {
    enqueue(guestId);
  }
  console.log(`[server] Re-enqueued ${unhydrated.length} unhydrated guest(s)`);

  startBroadcastWorker();
  console.log('[server] Broadcast worker started');

  // Fire-and-forget — retries indefinitely in the background
  registerWebhook().catch((err) => {
    console.error('[server] registerWebhook fatal error:', err);
  });
}

startServer();
