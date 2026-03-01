# Reservation Webhook Dashboard

Real-time dashboard that ingests reservation webhook events, hydrates guest data, and streams live updates to the browser.

## Stack

- **Backend**: Node + Express + TypeScript (port 3000)
- **Frontend**: React + Vite + TypeScript (port 5173)
- **DB**: PostgreSQL (provided via Docker)

## Setup

### 1. Start challenge services

```bash
cd /path/to/challenge && docker compose up -d
```

### 2. Configure backend

```bash
cp backend/.env.example backend/.env
# Fill in values — see .env.example for reference
```

### 3. Install & run backend

```bash
cd backend && npm install && npm run dev
```

### 4. Install & run frontend

```bash
cd frontend && npm install && npm run dev
```

Open **http://localhost:5173**

## Tests

```bash
cd backend && npm test   # 45 tests
cd frontend && npm test  # 8 tests
```

## How it works

1. Webhook events arrive at `POST /webhooks` — validated, deduped, upserted to DB
2. Guest names/emails are fetched from the Guest API asynchronously (2 concurrent workers, respects rate limits)
3. Connected browsers receive live updates via SSE (`GET /events`)
4. The Broadcast panel sends a message to all guests matching the active filter via `POST /broadcast`

## Key design decisions

| Concern | Approach |
|---|---|
| Duplicate webhooks | In-memory `Set<webhook_id>` — O(1), resets on restart (DB upsert is idempotent anyway) |
| Out-of-order events | Upsert `WHERE event_timestamp >= existing`; cancelled status is terminal |
| Rate limiting | Reads `Retry-After` header on 429; exponential backoff on 5xx |
| Broadcast reliability | Jobs persisted in `broadcast_jobs` table before 200 response; worker retries up to 5× |
| SSE reconnect | `GET /reservations` snapshot on load; SSE streams deltas |

## Scaling

To scale horizontally: replace the in-memory dedup Set with Redis, replace SSE fan-out with Redis pub/sub, and move broadcast jobs to a proper queue (BullMQ/SQS).
