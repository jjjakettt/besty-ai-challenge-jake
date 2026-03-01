import http from 'http';

const GUEST_API_BASE = process.env.GUEST_API_URL || 'http://localhost:3001';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
    }).on('error', reject);
  });
}

function httpPost(url: string, payload: string): Promise<{ statusCode: number; body: string }> {
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
      res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Registers the webhook URL with the Guest API. Idempotent — if the URL is
 * already registered, returns immediately. Retries indefinitely on network
 * errors or 5xx responses so the server can start before the Guest API is ready.
 *
 * Requires WEBHOOK_URL env var to be set; throws immediately if missing.
 */
export async function registerWebhook(): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('WEBHOOK_URL environment variable is not set');
  }

  while (true) {
    try {
      const listRes = await httpGet(`${GUEST_API_BASE}/webhooks/registered`);

      if (listRes.statusCode >= 500) {
        console.log('[register] Guest API returned 5xx on list check, retrying in 2s...');
        await sleep(2000);
        continue;
      }

      if (listRes.statusCode === 200) {
        const body = JSON.parse(listRes.body);
        const registered: string[] = Array.isArray(body) ? body : (body.urls ?? []);
        if (registered.includes(webhookUrl)) {
          console.log('[register] Webhook already registered');
          return;
        }
      }

      const payload = JSON.stringify({ url: webhookUrl });
      const regRes = await httpPost(`${GUEST_API_BASE}/webhooks/register`, payload);

      if (regRes.statusCode === 201) {
        console.log('[register] Webhook registered successfully');
        return;
      }

      if (regRes.statusCode >= 500) {
        console.log('[register] Registration returned 5xx, retrying in 2s...');
        await sleep(2000);
        continue;
      }

      console.error(`[register] Unexpected status ${regRes.statusCode}: ${regRes.body}`);
      return;
    } catch (err) {
      console.log('[register] Network error, retrying in 2s...', err);
      await sleep(2000);
    }
  }
}
