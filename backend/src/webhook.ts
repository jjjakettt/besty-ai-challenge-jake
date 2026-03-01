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
    const d = body.data ?? body;  // support both nested and flat payloads

    const reservation: ReservationRow = {
      reservation_id:  d.reservationId  ?? d.reservation_id,
      property_id:     d.propertyId     ?? d.property_id,
      guest_id:        d.guestId        ?? d.guest_id,
      status:          d.status,
      check_in:        d.checkIn        ?? d.check_in,
      check_out:       d.checkOut       ?? d.check_out,
      num_guests:      d.numGuests      ?? d.num_guests,
      total_amount:    String(d.totalAmount ?? d.total_amount),
      currency:        d.currency,
      webhook_id:      body.webhookId   ?? body.webhook_id   ?? d.webhookId ?? d.webhook_id,
      event_timestamp: body.timestamp   ?? body.event_timestamp ?? d.event_timestamp,
    };

    for (const field of REQUIRED_FIELDS) {
      if (reservation[field as keyof ReservationRow] == null ||
          reservation[field as keyof ReservationRow] === '') {
        res.status(400).json({ error: `Missing field: ${field}` });
        return;
      }
    }

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
