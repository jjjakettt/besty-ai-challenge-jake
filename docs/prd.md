Product Requirements Document

Reservation Webhook Dashboard

1. Overview

Build a real-time reservation dashboard that:
	1.	Receives reservation webhook events.
	2.	Hydrates reservation data using the Guest API.
	3.	Stores reservations in Postgres.
	4.	Displays reservations in a real-time updating frontend.
	5.	Supports filtering, sorting, and a broadcast messaging feature.
	6.	Handles rate limiting, retries, and out-of-order webhooks gracefully.

The system must be production-minded, resilient to API failures, and designed to scale logically, even if implemented minimally.

Time constraint: 3 hours.

Language preference: TypeScript (Node.js).

⸻

2. Architecture Overview

External Services
	•	Guest API (http://localhost:3001)
	•	Webhook Sender (Docker container)
	•	PostgreSQL (localhost:5432)

Components to Build
	1.	Backend Server
	•	Express (or similar)
	•	Webhook receiver
	•	Hydration worker
	•	Broadcast worker
	•	Real-time streaming endpoint (SSE or WebSocket)
	•	Postgres integration
	2.	Frontend
	•	Displays reservation list
	•	Real-time updates
	•	Sorting and filtering
	•	Broadcast messaging UI

⸻

3. Functional Requirements

3.1 Webhook Handling

Endpoint
POST /webhooks

Behavior
	•	Validate X-Webhook-Secret header.
	•	Reject requests with invalid secret.
	•	Webhooks may:
	•	Arrive out of order
	•	Be duplicated
	•	Represent created, updated, or cancelled reservations
	•	Webhook handler must:
	•	Return 200 quickly
	•	Not block on hydration API calls
	•	Be idempotent

Rules
	•	Treat each webhook event as valid.
	•	Do not trust delivery order.
	•	Status cancelled is terminal.
	•	Upsert reservation into Postgres.
	•	Enqueue hydration job.

⸻

3.2 Reservation Storage

Use the provided Postgres database.
	•	Must persist reservations in the reservations table.
	•	Do not modify existing schema.
	•	Store:
	•	reservation_id
	•	guest_id
	•	status
	•	any webhook-provided reservation fields
	•	hydrated guest fields (e.g., guest name, email)

Implement safe upsert logic:
	•	Insert if not exists.
	•	Update if exists.
	•	Do not “uncancel” a cancelled reservation.

⸻

3.3 Hydration Logic

For each webhook:
	1.	Extract guestId.
	2.	Call:
GET /guests/:guestId
	3.	Merge guest data into reservation row.

Constraints:
	•	Guest API is rate limited.
	•	On 429:
	•	Respect Retry-After header.
	•	Retry using backoff strategy.
	•	Hydration must run asynchronously from webhook handler.
	•	Avoid flooding API.
	•	Consider small concurrency limit (e.g., 2–3 workers).

⸻

3.4 Real-Time Updates

Frontend must update when:
	•	A reservation is created.
	•	A reservation is updated.
	•	A reservation is cancelled.
	•	Hydration completes.

Acceptable approaches:
	•	Server-Sent Events (preferred for simplicity)
	•	WebSockets

Requirements:
	•	Client reconnects safely.
	•	No polling unless justified.

⸻

3.5 Frontend Requirements

Display:
	•	List of reservations.
	•	Status.
	•	Guest information.
	•	Sortable columns.
	•	Filter controls (e.g., by status).

Filtering Behavior:
	•	When filters are applied:
	•	Show “Send Broadcast” button.
	•	Broadcast button only visible when filtered subset exists.

Sorting Behavior:
	•	Must work client-side.
	•	Stable and predictable.

⸻

3.6 Broadcast Feature

When user clicks “Send Broadcast”:
	1.	Collect message input.
	2.	Determine filtered reservation subset.
	3.	For each guest:
POST /guests/:guestId/messages

Constraints:
	•	API is rate limited.
	•	Must eventually send every message.
	•	If message fails:
	•	Retry on transient errors (429, 500).
	•	Stop retrying on permanent errors (400, 404).
	•	Broadcast sending must not block UI.

Implement:
	•	Broadcast job queue.
	•	Retry strategy.
	•	Attempt counter.
	•	Backoff handling.

Optional but strong:
	•	Persist broadcast jobs in database.
	•	Track status (pending, sent, failed).

⸻

4. Non-Functional Requirements

4.1 Idempotency
	•	Duplicate webhooks must not corrupt state.
	•	Upserts must be safe.
	•	Broadcast jobs must not send duplicate messages unintentionally.

⸻

4.2 Performance
	•	Webhook handler must respond quickly.
	•	Heavy work must be async.
	•	Hydration queue must prevent API flooding.
	•	Respect rate limiting headers.

⸻

4.3 Reliability
	•	System must handle:
	•	Out-of-order events
	•	Duplicate events
	•	429 rate limits
	•	API 404
	•	Temporary failures

⸻

4.4 Scalability (Explainable)

Even if minimally implemented, design should be explainable as scalable:
	•	Webhook ingestion separated from processing.
	•	Queue-based workers.
	•	Horizontal scaling possible.
	•	Rate limiting handled centrally.
	•	Stateless API layer with Postgres as source of truth.

⸻

5. Error Handling

Handle:
	•	Invalid webhook secret → 401
	•	Invalid payload → 400
	•	Guest API 429 → Retry after header
	•	Guest API 404 → mark hydration failure
	•	Broadcast failures → retry with backoff
	•	Webhook health: respond fast to avoid unregister

⸻

6. Implementation Plan

Order of implementation:
	1.	Start docker services.
	2.	Build backend server.
	3.	Implement webhook endpoint.
	4.	Implement Postgres upsert logic.
	5.	Register webhook on server startup.
	6.	Add hydration queue with retry logic.
	7.	Implement real-time stream.
	8.	Build frontend list UI.
	9.	Add sorting and filtering.
	10.	Implement broadcast queue and retries.
	11.	Final polish and error handling.

⸻

6.5 Edge Cases

6.5.1 Webhook Receiver
	•	Out-of-order delivery: Skip update if incoming event_timestamp is older than stored one.
	•	Duplicate events: Upsert by reservation_id is inherently idempotent.
	•	Terminal status: Never overwrite a cancelled reservation's status.
	•	Fast response: Return 200 immediately, process async to avoid health-check unregistration.
	•	Auto re-registration: Register webhook URL on server startup.

6.5.2 Guest API (Hydration)
	•	429: Wait for Retry-After duration before retrying.
	•	404: Mark hydration failed, do not retry.
	•	5xx: Retry up to 3 times with simple backoff.
	•	Concurrency cap: Max 2–3 concurrent hydration calls.

6.5.3 Broadcast
	•	429 / 500: Retry with backoff.
	•	400 / 404: Permanent failure, stop retrying.
	•	Track attempt count and status per job to avoid duplicate sends.

6.5.4 SSE
	•	Client disconnect: Clean up listeners to prevent memory leaks.
	•	Client reconnect: Send current state on connection before streaming events.

6.5.5 Database
	•	Use ON CONFLICT (reservation_id) DO UPDATE with a WHERE guard to prevent stale overwrites and enforce cancelled as terminal.

⸻

7. Success Criteria

A strong solution:
	•	Handles out-of-order webhooks correctly.
	•	Does not break under rate limiting.
	•	Uses asynchronous processing.
	•	Shows clean separation of concerns.
	•	Has clear retry logic.
	•	Is fully explainable.
	•	Demonstrates system design thinking.

⸻
