import { Router, Request, Response } from 'express';
import { createBroadcastJob, getPendingBroadcastJobs, updateBroadcastJob, ReservationRow } from './db';
import { sendMessage } from './guestApi';

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 5;

/**
 * Factory that creates an isolated broadcast router per call.
 * emit is accepted for interface consistency but is not used in this module —
 * broadcast jobs are executed by startBroadcastWorker, not the route handler.
 */
export function createBroadcastRouter(
  emit: (guestId: string, reservation: ReservationRow) => void
): Router {
  const router = Router();

  /**
   * POST /broadcast — validates the body and enqueues one broadcast job per
   * guestId. Returns 200 immediately; job execution is deferred to the worker.
   */
  router.post('/broadcast', async (req: Request, res: Response) => {
    const { guestIds, message } = req.body ?? {};

    if (!Array.isArray(guestIds) || guestIds.length === 0) {
      return res.status(400).json({ error: 'guestIds must be a non-empty array' });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message must be a non-empty string' });
    }

    // Fire-and-forget: queue all jobs without blocking the response
    for (const guestId of guestIds) {
      createBroadcastJob(guestId, message).catch((err) => {
        console.error('[broadcast] createBroadcastJob error:', err);
      });
    }

    return res.json({ queued: guestIds.length });
  });

  return router;
}

/**
 * Starts the DB-polling worker loop. Processes pending broadcast jobs
 * sequentially every 2 seconds. Returns a stop() function that halts the
 * loop after the current in-flight poll without awaiting it.
 */
export function startBroadcastWorker(): () => void {
  let stopped = false;

  async function poll(): Promise<void> {
    // Check at entry so stop() is honoured even for already-scheduled callbacks
    if (stopped) return;

    try {
      const jobs = await getPendingBroadcastJobs();

      for (const job of jobs) {
        try {
          const { statusCode } = await sendMessage(job.guest_id, job.message);

          if (statusCode === 200) {
            await updateBroadcastJob(job.id, 'sent', job.attempts + 1);
          } else if (statusCode === 400 || statusCode === 404) {
            // Permanent failure — do not retry
            await updateBroadcastJob(job.id, 'failed', job.attempts + 1);
          } else {
            // 429 or 5xx — increment attempts; mark failed if at the limit
            const newAttempts = job.attempts + 1;
            if (newAttempts >= MAX_ATTEMPTS) {
              await updateBroadcastJob(job.id, 'failed', newAttempts);
            } else {
              await updateBroadcastJob(job.id, 'pending', newAttempts);
            }
          }
        } catch (err) {
          console.error(`[broadcast] job ${job.id} error:`, err);
        }
      }
    } catch (err) {
      console.error('[broadcast] poll error:', err);
    }

    if (!stopped) {
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  setTimeout(poll, POLL_INTERVAL_MS);

  return function stop() {
    stopped = true;
  };
}
