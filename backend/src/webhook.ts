import { Router, Request, Response } from 'express';
import { upsertReservation, ReservationRow } from './db';

const REQUIRED_FIELDS: (keyof ReservationRow)[] = [
  'reservation_id', 'property_id', 'guest_id', 'status',
  'check_in', 'check_out', 'num_guests', 'total_amount', 'currency',
  'webhook_id', 'event_timestamp',
];

export function createWebhookRouter(
  enqueue: (guestId: string) => void,
  emit: (reservation: ReservationRow) => void
): Router {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('WEBHOOK_SECRET environment variable is not set');
  }

  const seenWebhookIds = new Set<string>();
  const router = Router();

  router.post('/', (req: Request, res: Response) => {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== webhookSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body;
    for (const field of REQUIRED_FIELDS) {
      if (body[field] == null || body[field] === '') {
        res.status(400).json({ error: `Missing field: ${field}` });
        return;
      }
    }

    const reservation: ReservationRow = {
      reservation_id:  body.reservation_id,
      property_id:     body.property_id,
      guest_id:        body.guest_id,
      status:          body.status,
      check_in:        body.check_in,
      check_out:       body.check_out,
      num_guests:      body.num_guests,
      total_amount:    body.total_amount,
      currency:        body.currency,
      webhook_id:      body.webhook_id,
      event_timestamp: body.event_timestamp,
    };

    if (seenWebhookIds.has(reservation.webhook_id)) {
      res.status(200).json({ ok: true });
      return;
    }

    seenWebhookIds.add(reservation.webhook_id);

    upsertReservation(reservation).catch((err) => {
      console.error('upsertReservation failed:', err);
    });
    enqueue(reservation.guest_id);
    emit(reservation);

    res.status(200).json({ ok: true });
  });

  return router;
}
