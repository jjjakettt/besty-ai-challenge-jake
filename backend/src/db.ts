import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_jobs (
      id SERIAL PRIMARY KEY,
      guest_id VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export interface ReservationRow {
  reservation_id: string;
  property_id: string;
  guest_id: string;
  status: string;
  check_in: string;
  check_out: string;
  num_guests: number;
  total_amount: string;
  currency: string;
  webhook_id: string;
  event_timestamp: string;
  guest_first_name?: string;
  guest_last_name?: string;
  guest_email?: string;
  guest_phone?: string;
}

export async function upsertReservation(r: ReservationRow): Promise<void> {
  await pool.query(
    `INSERT INTO reservations (
       reservation_id, property_id, guest_id, status,
       check_in, check_out, num_guests, total_amount, currency,
       webhook_id, event_timestamp
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (reservation_id) DO UPDATE SET
       status = CASE
         WHEN reservations.status = 'cancelled' THEN 'cancelled'
         ELSE EXCLUDED.status
       END,
       property_id     = EXCLUDED.property_id,
       guest_id        = EXCLUDED.guest_id,
       check_in        = EXCLUDED.check_in,
       check_out       = EXCLUDED.check_out,
       num_guests      = EXCLUDED.num_guests,
       total_amount    = EXCLUDED.total_amount,
       currency        = EXCLUDED.currency,
       webhook_id      = EXCLUDED.webhook_id,
       event_timestamp = EXCLUDED.event_timestamp,
       updated_at      = NOW()
     WHERE reservations.event_timestamp IS NULL
        OR EXCLUDED.event_timestamp >= reservations.event_timestamp`,
    [
      r.reservation_id, r.property_id, r.guest_id, r.status,
      r.check_in, r.check_out, r.num_guests, r.total_amount, r.currency,
      r.webhook_id, r.event_timestamp,
    ]
  );
}

export async function updateGuestInfo(
  guestId: string,
  info: { first_name: string; last_name: string; email: string; phone: string }
): Promise<void> {
  await pool.query(
    `UPDATE reservations SET
       guest_first_name = $2,
       guest_last_name  = $3,
       guest_email      = $4,
       guest_phone      = $5,
       updated_at       = NOW()
     WHERE guest_id = $1 AND guest_first_name IS NULL`,
    [guestId, info.first_name, info.last_name, info.email, info.phone]
  );
}

export async function getAllReservations(): Promise<ReservationRow[]> {
  const res = await pool.query('SELECT * FROM reservations ORDER BY created_at DESC');
  return res.rows;
}

export async function getUnhydratedGuestIds(): Promise<string[]> {
  const res = await pool.query(
    `SELECT DISTINCT guest_id FROM reservations WHERE guest_first_name IS NULL`
  );
  return res.rows.map((r: { guest_id: string }) => r.guest_id);
}

// broadcast_jobs helpers
export async function createBroadcastJob(guestId: string, message: string): Promise<number> {
  const res = await pool.query(
    `INSERT INTO broadcast_jobs (guest_id, message) VALUES ($1, $2) RETURNING id`,
    [guestId, message]
  );
  return res.rows[0].id;
}

export async function getPendingBroadcastJobs() {
  const res = await pool.query(
    `SELECT * FROM broadcast_jobs WHERE status = 'pending' ORDER BY created_at ASC`
  );
  return res.rows;
}

export async function updateBroadcastJob(
  id: number,
  status: string,
  attempts: number
): Promise<void> {
  await pool.query(
    `UPDATE broadcast_jobs SET status = $2, attempts = $3, updated_at = NOW() WHERE id = $1`,
    [id, status, attempts]
  );
}
