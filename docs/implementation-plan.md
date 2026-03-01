# Implementation Plan — Reservation Webhook Dashboard

## Context
Greenfield TypeScript project for a 3-hour interview challenge. Receives reservation webhooks, hydrates guest data, persists to Postgres, and shows a real-time React dashboard with filtering, sorting, and broadcast messaging. Priority is working features, not UI polish.

---

## Stack
- **Backend**: Node + Express + TypeScript, port 3000
- **Frontend**: React + Vite + TypeScript, port 5173
- **DB**: PostgreSQL (pre-existing `reservations` table + new `broadcast_jobs` table)
- **Package manager**: npm
- **Structure**: Monorepo — `backend/` and `frontend/` folders

---

## Project Structure

```
besty-ai-challenge-jake/
├── backend/
│   ├── src/
│   │   ├── index.ts        # Entry point, startup flow
│   │   ├── db.ts           # pg Pool + upsert + broadcast_jobs queries
│   │   ├── guestApi.ts     # Rate-limit-aware Guest API wrapper
│   │   ├── webhook.ts      # POST /webhooks handler
│   │   ├── hydration.ts    # In-memory queue + worker (2 concurrent)
│   │   ├── broadcast.ts    # POST /broadcast + DB-backed worker
│   │   ├── sse.ts          # SSE manager (EventEmitter)
│   │   └── register.ts     # Webhook registration + retry
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── types.ts
│   │   ├── test-setup.ts
│   │   ├── App.tsx                    # State, data fetching, SSE, layout glue
│   │   ├── App.test.tsx               # Vitest + RTL integration tests
│   │   └── components/
│   │       ├── FilterBar.tsx          # Status dropdown + sort controls
│   │       ├── ReservationTable.tsx   # Sortable table with rows
│   │       ├── StatusBadge.tsx        # Colour-coded status pill
│   │       └── BroadcastPanel.tsx     # Message textarea + submit + feedback
│   ├── index.html
│   └── package.json
└── docs/
```

---

## Key Design Decisions & Tradeoffs

| Decision | Choice | Reason |
|---|---|---|
| Hydration queue | In-memory | Recovery via DB query on startup (`WHERE guest_first_name IS NULL`). No extra table needed. |
| Broadcast jobs | DB-persisted | User-initiated, must not silently drop. `broadcast_jobs` table is simple and durable. |
| Real-time | SSE | One-way push is sufficient. Native browser API, auto-reconnects, no library needed. |
| Webhook dedup | In-memory Set | Instant, no DB roundtrip on hot path. Restarts are safe due to upsert timestamp guard. |
| Frontend structure | Single `App.tsx` | 3-hour constraint — one component with all state is fastest to ship and debug. |
| Guest cache | `Map<guestId, data>` | No TTL needed in 3hr window. Eliminates redundant API calls without invalidation complexity. |
| Hydration concurrency | 2 workers | Conservative enough to respect rate limits, enough to handle bursts. |

---

## Implementation Steps

### Step 1 — Scaffold (5 min)
- `npm init` in `backend/`
- Backend deps: `express`, `pg`, `dotenv`, `@types/express`, `@types/pg`, `ts-node`, `typescript`
- `npm create vite@latest frontend -- --template react-ts`
- Add `tsconfig.json` to backend

### Step 2 — Database layer: `db.ts` (15 min)
- Create `pg.Pool` with env vars
- Create `broadcast_jobs` table on startup if not exists
- Write upsert for `reservations` with timestamp guard and cancelled-terminal logic
- Write helpers: `getReservations()`, `updateGuestData()`, `insertBroadcastJob()`, `getPendingBroadcastJobs()`, `updateBroadcastJob()`

Upsert SQL:
```sql
INSERT INTO reservations (
  reservation_id, property_id, guest_id, status, check_in, check_out,
  num_guests, total_amount, currency, webhook_id, event_timestamp, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW(), NOW())
ON CONFLICT (reservation_id) DO UPDATE SET
  status          = CASE WHEN reservations.status = 'cancelled' THEN 'cancelled' ELSE EXCLUDED.status END,
  property_id     = EXCLUDED.property_id,
  check_in        = EXCLUDED.check_in,
  check_out       = EXCLUDED.check_out,
  num_guests      = EXCLUDED.num_guests,
  total_amount    = EXCLUDED.total_amount,
  currency        = EXCLUDED.currency,
  webhook_id      = EXCLUDED.webhook_id,
  event_timestamp = EXCLUDED.event_timestamp,
  updated_at      = NOW()
WHERE reservations.event_timestamp IS NULL
   OR EXCLUDED.event_timestamp >= reservations.event_timestamp
```

### Step 3 — Guest API wrapper: `guestApi.ts` (10 min)
- `fetchGuest(guestId)` — GET /guests/:guestId with retry on 429, stop on 404
- `sendMessage(guestId, message)` — POST /guests/:guestId/messages with retry on 429/500, stop on 400/404
- Shared retry logic: read `Retry-After` header, sleep, retry
- In-memory guest cache: `Map<string, GuestData>`

### Step 4 — Webhook endpoint: `webhook.ts` (15 min)
- `POST /webhooks`
- Validate `X-Webhook-Secret` → 401
- Parse body → 400 if malformed
- Dedupe by `webhook_id` via in-memory `Set<string>`
- Upsert to DB
- Enqueue hydration job
- Emit SSE event
- Return 200 immediately

### Step 5 — Hydration worker: `hydration.ts` (15 min)
- Queue: `Job[]` array, max 2 concurrent (simple counter)
- `enqueue({ reservationId, guestId, attempts })`
- On 429: sleep Retry-After, re-enqueue
- On 404: drop
- On success: `updateGuestData()` + emit SSE
- Startup recovery: called from `index.ts` with all reservations where `guest_first_name IS NULL`

### Step 6 — SSE: `sse.ts` (10 min)
- `GET /events` — SSE headers, add client to Set, remove on close
- `emit(data)` — write to all connected clients
- `GET /reservations` — query all rows, return JSON

### Step 7 — Broadcast: `broadcast.ts` (20 min)
- `POST /broadcast` — insert pending jobs to DB, return 200
- Worker: poll `getPendingBroadcastJobs()` every 2s
- On 200: status → `sent`
- On 400/404: status → `failed`
- On 429/500: increment attempts, sleep, retry (max 5)
- Startup recovery: resume all `pending` jobs from DB

### Step 8 — Startup: `index.ts` + `register.ts` (10 min)
- Connect DB → create tables → register webhook (retry 5× with 2s delay)
- Re-enqueue hydration for incomplete reservations
- Start broadcast worker
- Start HTTP server on port 3000

### Step 9 — Frontend: components + tests (30 min)

**`types.ts`** — `Reservation` interface + `SortField` / `SortDir` types

**`StatusBadge.tsx`** — colour-coded `<span>` for confirmed (green) / modified (amber) / cancelled (red)

**`FilterBar.tsx`** — fully controlled; props: `statusFilter`, `onStatusChange`, `sortField`, `sortDir`, `onSortFieldChange`, `onSortDirChange`

**`ReservationTable.tsx`** — receives pre-filtered, pre-sorted rows; clickable column headers call `onSort(field)`; guest name falls back to `guest_id` (italic) when not hydrated; uses `<StatusBadge>`

**`BroadcastPanel.tsx`** — internal state: `message`, `sending`, `status`; props: `recipientCount`, `onSend(message)`; disables button while sending or message empty; shows success/error feedback

**`App.tsx`** — owns all cross-component state (`reservations`, `statusFilter`, `sortField`, `sortDir`); on mount: `GET /api/reservations` + `new EventSource('/api/events')` (cleaned up on unmount); derived `filtered` array passed to children; broadcast panel visible only when `statusFilter` set and `filtered.length > 0`

**Vite proxy** — all frontend calls use `/api/*`; proxy rewrites to `http://localhost:3000`

**`App.test.tsx`** — 8 tests (see Testing section below)

---

## broadcast_jobs table

```sql
CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id SERIAL PRIMARY KEY,
  guest_id VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Testing

### Framework
- **Backend**: `vitest` + `supertest`
- **Frontend**: `vitest` + `@testing-library/react` + `@testing-library/jest-dom` + `jsdom`

### Install
```bash
# backend
npm install -D vitest supertest @types/supertest

# frontend
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```
Add to `backend/package.json` and `frontend/package.json`: `"test": "vitest run"`

Add to `frontend/vite.config.ts`:
```ts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: './src/test-setup.ts',
},
```

`frontend/src/test-setup.ts`:
```ts
import '@testing-library/jest-dom';
```

### Unit Tests: `backend/src/__tests__/`

#### `upsert.test.ts` — Business rules (mock `pg.Pool`)
- Insert new reservation → row exists
- Upsert with newer timestamp → fields updated
- Upsert with older timestamp → row unchanged
- Upsert into cancelled reservation → status stays cancelled
- Cancelled event arrives before create → row created with status=cancelled

#### `guestApi.test.ts` — Retry logic (mock HTTP)
- 429 → sleeps Retry-After ms → retries
- 404 → throws non-retryable error
- 200 → returns guest data
- 500 → retries up to limit

#### `webhook.test.ts` — Deduplication
- Same `webhook_id` twice → second call skipped
- Different `webhook_id` → both processed

### Integration Tests: `backend/src/__tests__/api.test.ts`

Use `supertest` against the Express app (exported before `listen()`). Mock DB calls.

- `POST /webhooks` valid secret + payload → 200
- `POST /webhooks` invalid secret → 401
- `POST /webhooks` missing fields → 400
- `POST /webhooks` duplicate `webhook_id` → 200 (idempotent)
- `GET /reservations` → 200 array
- `POST /broadcast` valid body → 200

### Frontend Tests (`frontend/src/App.test.tsx`)

Mock `fetch` globally and `EventSource` with a constructable class that exposes `onmessage` for test-controlled event firing.

8 tests:
1. Initial load renders reservation rows from `GET /api/reservations`
2. New SSE reservation appears in table
3. SSE update merges into existing row — no duplicate
4. Status filter shows only matching rows
5. Broadcast panel hidden when no filter active
6. Broadcast panel visible when filter active and results exist
7. Broadcast submit calls `POST /api/broadcast` with deduped guestIds
8. `StatusBadge` renders correct colour indicator per status value

### What NOT to test
- SSE streaming infrastructure (covered by mocked EventSource in frontend tests)
- Broadcast worker retries (covered by guestApi unit tests)
- Individual sub-component internals beyond what's covered via App integration tests

---

## Verification
1. `docker compose up` in challenge folder
2. `npm run dev` in `backend/` — server starts on 3000, registers webhook, logs confirmation
3. `npm run dev` in `frontend/` — Vite starts on 5173
4. Open browser → reservations appear and update in real-time
5. Filter by status → broadcast button appears → send message → confirm in logs
6. Kill + restart backend → broadcast jobs resume, incomplete hydrations re-enqueue
7. `psql` → verify `reservations` rows populated with guest data
