Technical Design Document

Project: Reservation Webhook Dashboard
Language: TypeScript (Node.js)
Database: PostgreSQL
Time Constraint: 3 hours

⸻

1. Objective

Build a system that:
	1.	Receives reservation webhook events.
	2.	Validates webhook authenticity.
	3.	Hydrates guest data via Guest API.
	4.	Stores reservations in Postgres.
	5.	Displays reservations in a real-time updating frontend.
	6.	Supports sorting, filtering, and broadcast messaging.
	7.	Handles out-of-order events and strict rate limiting.

System must be resilient, idempotent, and explainable.

⸻

2. System Architecture

Components
	1.	Backend (Node + Express)
	•	Webhook ingestion
	•	Hydration worker
	•	Broadcast worker
	•	SSE real-time stream
	•	Postgres integration
	2.	Postgres
	•	reservations table (pre-existing, do not modify schema)
	•	broadcast_jobs table (new)
	3.	External Services
	•	Guest API (http://localhost:3001)
	•	Webhook Sender (Docker)
	4.	Frontend
	•	Reservation list UI
	•	Real-time updates
	•	Filtering and sorting
	•	Broadcast UI

⸻

3. Core Design Decisions

3.1 Idempotency Strategy

Webhooks:
	•	May arrive out of order.
	•	May be duplicated.
	•	Include created, updated, cancelled events.

Rules:
	•	Use reservation_id as primary key.
	•	Always upsert.
	•	Deduplicate by webhook_id — skip processing if already seen.
	•	Treat cancelled as terminal state.
	•	Never revert a cancelled reservation.
	•	If cancel arrives before create, create cancelled record.
	•	Skip update if incoming event_timestamp is older than stored event_timestamp.

⸻

3.2 Webhook Flow

Endpoint:
POST /webhooks

Flow:
	1.	Validate header X-Webhook-Secret.
	2.	Parse payload — map camelCase nested format to snake_case (see 3.2a).
	3.	Check webhook_id — skip if already processed.
	4.	Upsert reservation row with timestamp guard.
	5.	Enqueue hydration job.
	6.	Emit real-time update.
	7.	Return 200 immediately.

Important:
Webhook handler must never block on API calls.

3.2a Real Webhook Payload Format

The webhook-sender sends a nested structure (NOT flat snake_case):

{
  "event": "reservation.created",
  "timestamp": "2026-03-01T22:33:06.252Z",   ← maps to event_timestamp
  "webhookId": "wh_abc123",                   ← maps to webhook_id
  "data": {
    "reservationId": "res_00003",             ← maps to reservation_id
    "propertyId":    "property_018",
    "guestId":       "guest_012",
    "status":        "confirmed",
    "checkIn":       "2026-04-06",
    "checkOut":      "2026-04-13",
    "numGuests":     5,
    "totalAmount":   1869.59,                 ← coerce to String for DB
    "currency":      "USD"
  }
}

Handler uses: const d = body.data ?? body to support both nested and flat payloads.

⸻

3.3 Database Strategy

Use provided reservations table. Do not modify schema.

Upsert pattern:
	•	Insert if not exists.
	•	On conflict (reservation_id):
	•	Update fields only if incoming event_timestamp >= stored event_timestamp.
	•	Never update status if current status is cancelled.

All writes must be safe for duplicate events.

broadcast_jobs table (new):

CREATE TABLE broadcast_jobs (
  id SERIAL PRIMARY KEY,
  guest_id VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

This persists broadcast jobs across server restarts. Worker reads from DB, not memory.

⸻

4. Hydration System

4.1 Problem

Guest API is rate limited.
Must respect 429 responses with Retry-After header.

4.2 Solution

Use in-memory queue with worker loop.

HydrationJob:
	•	reservationId
	•	guestId
	•	attempts

Worker rules:
	•	Limited concurrency (2–3 max).
	•	On 429:
	•	Read Retry-After.
	•	Sleep.
	•	Retry job.
	•	On 404:
	•	Stop retrying.
	•	On success:
	•	Update reservation with guest data.
	•	Emit real-time update.

Recovery on startup:
	•	Query reservations where guest_first_name IS NULL.
	•	Re-enqueue hydration jobs for all incomplete records.
	•	No extra table needed.

Optional:
Add short-lived in-memory guest cache (Map<guestId, guestData>) to reduce duplicate API calls.

⸻

5. Real-Time Updates

Chosen Approach: Server-Sent Events (SSE)

Reason:
	•	One-directional streaming is sufficient.
	•	Simpler than WebSockets.
	•	Minimal implementation complexity.

Backend:
GET /events
	•	Keep connection open.
	•	Emit reservation updates as JSON events.
	•	Clean up listener on client disconnect.

GET /reservations
	•	Return full current reservation list.
	•	Used for initial load and SSE reconnect.

Frontend:
	•	Use EventSource.
	•	On connect, fetch full reservation list from GET /reservations.
	•	Apply live SSE events on top.

⸻

6. Broadcast System

6.1 Requirements
	•	Send message to all guests in filtered list.
	•	Must eventually deliver all messages.
	•	Must handle rate limiting.
	•	Must retry transient failures.
	•	Jobs must persist across server restarts.

6.2 Backend Flow

Endpoint:
POST /broadcast

Input:
	•	message
	•	list of guestIds or reservationIds

Steps:
	1.	Validate message.
	2.	Insert broadcast jobs into broadcast_jobs table with status pending.
	3.	Return immediately.

6.3 Broadcast Worker

Worker reads pending jobs from broadcast_jobs table.

Worker behavior:
	•	Process jobs at low concurrency.
	•	On 200:
	•	Update status to sent.
	•	On 429:
	•	Respect Retry-After.
	•	Increment attempts, retry.
	•	On 400/404:
	•	Update status to failed (permanent).
	•	On 500:
	•	Retry with exponential backoff up to max attempts.

Recovery on startup:
	•	Query broadcast_jobs WHERE status = 'pending'.
	•	Resume processing all pending jobs.

Goal:
Eventual delivery of all valid messages with no duplicates.

⸻

7. Rate Limiting Strategy

All Guest API calls must go through a centralized wrapper.

Wrapper handles:
	•	Retry-After header
	•	Backoff logic
	•	Concurrency control

Never fire uncontrolled parallel requests.

⸻

8. Frontend Design

Stack: React + Vite + TypeScript, port 5173. Vite proxy rewrites /api/* → http://localhost:3000.

Component Structure

	•	App.tsx — owns all state; handles data fetching, SSE subscription, sort/filter logic, and broadcast submission. Passes derived filtered/sorted array and callbacks to children.
	•	components/FilterBar.tsx — fully controlled; renders status <select> and sort controls. No internal state.
	•	components/ReservationTable.tsx — renders <table> from pre-filtered, pre-sorted rows. Clickable column headers emit onSort(field). Unhydrated guest name falls back to guest_id (italic).
	•	components/StatusBadge.tsx — colour-coded <span>: green (confirmed), amber (modified), red (cancelled), grey (other).
	•	components/BroadcastPanel.tsx — manages message input, sending flag, and feedback text. Calls onSend(message) prop on submit.

State (in App.tsx)
	•	reservations: Reservation[]
	•	statusFilter: string
	•	sortField: keyof Reservation (default: event_timestamp)
	•	sortDir: 'asc' | 'desc' (default: desc)

Derived
	•	filtered = reservations.filter(status).sort(field, dir) — computed on each render, not stored in state.

Data flow
	•	On mount: fetch GET /api/reservations → set reservations.
	•	Open EventSource('/api/events') → on message: merge by reservation_id (replace existing or prepend new).
	•	Clean up EventSource on unmount.

Broadcast panel visibility
	•	Shown only when statusFilter is set AND filtered.length > 0.
	•	recipientCount = unique guest_ids in filtered list.
	•	On submit: POST /api/broadcast with { guestIds: [...new Set(filtered.map(r => r.guest_id))], message }.

Filtering and sorting must be pure functions applied to the reservations array.

⸻

9. Error Handling

Webhook:
	•	Invalid secret → 401
	•	Bad payload → 400
	•	Unexpected error → 500
	•	Always respond quickly

Hydration:
	•	Retry 429 with Retry-After
	•	Stop on 404
	•	Retry 5xx up to 3 times with backoff
	•	Log failures

Broadcast:
	•	Retry transient errors (429, 500)
	•	Stop on permanent errors (400, 404)
	•	Track attempts in DB

SSE:
	•	Clean up listeners on disconnect
	•	Allow reconnect and resync via GET /reservations

⸻

10. Startup Flow

On server start:
	1.	Connect to Postgres.
	2.	Create broadcast_jobs table if not exists.
	3.	Register webhook via POST /webhooks/register. Retry with delay if it fails.
	4.	Query reservations where guest_first_name IS NULL and re-enqueue hydration jobs.
	5.	Query broadcast_jobs WHERE status = 'pending' and resume broadcast worker.
	6.	Start hydration worker.
	7.	Start broadcast worker.
	8.	Start HTTP server.

Webhook re-registration:
	•	If health monitoring drops the webhook URL, re-register on next startup or via a periodic check.

10a. GET /webhooks/registered Response Shape

Returns { urls: string[] } — NOT a plain array. Extract with:

  const body = JSON.parse(res.body);
  const registered = Array.isArray(body) ? body : (body.urls ?? []);

The webhook-sender health monitor will unregister a URL after ~7 consecutive non-200 responses. Return 200 fast to stay registered.

⸻

11. Implementation Order
	1.	Boot docker services.
	2.	Build Express server with Postgres connection.
	3.	Create broadcast_jobs table on startup.
	4.	Implement webhook endpoint with secret validation, deduplication, upsert, and timestamp guard.
	5.	Implement hydration queue and worker with rate limit handling.
	6.	Implement SSE endpoint and GET /reservations.
	7.	Build frontend list view with real-time updates.
	8.	Add filtering and sorting.
	9.	Implement broadcast endpoint and worker with DB persistence.
	10.	Add rate limit handling polish and recovery logic.

⸻

11a. Security / Repo Hygiene

	•	backend/.env is gitignored — never commit real credentials.
	•	backend/.env.example committed with placeholder values.
	•	Root .gitignore covers .env, node_modules/, dist/, logs, .DS_Store.

⸻

12. Scalability Considerations (Explainable)

Future improvements:
	•	Replace in-memory hydration queue with Redis/BullMQ.
	•	Separate ingestion and processing into different services.
	•	Use distributed rate limit coordination.
	•	Add horizontal scaling with stateless API nodes.
	•	Promote broadcast_jobs to a full job queue service.

⸻

13. Frontend Implementation Notes

	•	vite.config.ts must import from 'vitest/config' (not /// <reference types="vitest" />) for vitest v4+.
	•	Vite dev proxy: /api/* → http://localhost:3000 — no hardcoded ports in source code.
	•	EventSource mock in tests: constructable class with static instance; vi.stubGlobal at file top before imports; fireSSE calls wrapped in act().
	•	Avoid getByText() for status values — matches both <option> and <StatusBadge>. Use getByRole('cell', { name: /status/ }) instead.
	•	BroadcastPanel hidden when statusFilter is empty — prevents accidental mass-message to all guests.
	•	recipientCount = new Set(filtered.map(r => r.guest_id)).size — deduped guest count, not row count.

⸻

14. Key Design Guarantees
	•	Idempotent webhook handling via reservation_id upsert and webhook_id deduplication.
	•	Safe out-of-order event processing via event_timestamp guard.
	•	Cancelled is terminal — never reverted.
	•	Asynchronous processing to avoid webhook health failure.
	•	Rate-limit aware hydration and broadcast.
	•	Broadcast jobs and hydration state persist across restarts.
	•	Clean separation of ingestion, processing, and presentation.
	•	Real-time user experience via SSE.
