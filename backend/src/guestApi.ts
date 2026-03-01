import http from 'http';

const GUEST_API_BASE = process.env.GUEST_API_URL || 'http://localhost:3001';

export interface GuestInfo {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}

// In-memory cache to avoid redundant calls for the same guest
const guestCache = new Map<string, GuestInfo>();

function httpGet(url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function httpPost(url: string, payload: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname } = new URL(url);
    const options: http.RequestOptions = {
      hostname,
      port: port || 80,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 5;

export async function fetchGuest(guestId: string): Promise<GuestInfo | null> {
  if (guestCache.has(guestId)) {
    return guestCache.get(guestId)!;
  }

  const url = `${GUEST_API_BASE}/guests/${guestId}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await httpGet(url);

    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      const info: GuestInfo = {
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        phone: data.phone,
      };
      guestCache.set(guestId, info);
      return info;
    }

    if (res.statusCode === 404) {
      // Guest does not exist — do not retry
      return null;
    }

    if (res.statusCode === 429) {
      const retryAfter = parseInt(res.headers['retry-after'] as string || '1', 10);
      await sleep(retryAfter * 1000);
      continue;
    }

    // 5xx or other transient errors — retry with backoff
    if (attempt < MAX_RETRIES) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
  }

  return null;
}

export async function sendMessage(guestId: string, message: string): Promise<{ statusCode: number }> {
  const url = `${GUEST_API_BASE}/guests/${guestId}/messages`;
  const payload = JSON.stringify({ message });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await httpPost(url, payload);

    if (res.statusCode === 200) {
      return { statusCode: 200 };
    }

    if (res.statusCode === 400 || res.statusCode === 404) {
      // Permanent failure — do not retry
      return { statusCode: res.statusCode };
    }

    if (res.statusCode === 429) {
      const retryAfter = parseInt(res.headers['retry-after'] as string || '1', 10);
      await sleep(retryAfter * 1000);
      continue;
    }

    // 5xx — retry with backoff
    if (attempt < MAX_RETRIES) {
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }
  }

  return { statusCode: 500 };
}
