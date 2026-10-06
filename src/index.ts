import express from 'express';
import { queueGeneration } from './generator';

const app = express();
app.use(express.json({ limit: '1mb' }));

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? '';

// Health check — Railway uses this to confirm the service is alive
app.get('/health', (_req, res) => {
  res.json({ ok: true, queue: 'running' });
});

/**
 * Supabase Database Webhook — fires on every UPDATE to the statuses table.
 * We only act when is_paid flips from false → true.
 *
 * Configure the webhook in Supabase → Database → Webhooks:
 *   Table:   statuses
 *   Events:  UPDATE
 *   URL:     https://<railway-domain>/webhook/status-paid
 *   Headers: { Authorization: Bearer <WEBHOOK_SECRET> }
 */
app.post('/webhook/status-paid', async (req, res) => {
  // Verify the shared secret set in the Supabase webhook header
  if (WEBHOOK_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${WEBHOOK_SECRET}`) {
      return res.sendStatus(401);
    }
  }

  const { type, table, record, old_record } = req.body ?? {};

  // Only handle UPDATE events on the statuses table
  if (type !== 'UPDATE' || table !== 'statuses') {
    return res.sendStatus(200);
  }

  // Act when is_paid OR is_waived flips to true
  const justPaid   = record?.is_paid   && !old_record?.is_paid;
  const justWaived = record?.is_waived && !old_record?.is_waived;
  if (!justPaid && !justWaived) {
    return res.sendStatus(200);
  }

  // Already generated — nothing to do
  if (record.generated_video_url) {
    return res.sendStatus(200);
  }

  // Acknowledge immediately so Supabase doesn't retry due to a slow response
  res.sendStatus(200);

  console.log(`[webhook] Queueing generation for status ${record.id}`);
  queueGeneration(record.id as string).catch(console.error);
});

/**
 * Manual trigger — useful for regenerating a specific ad without waiting for
 * the webhook.  POST /generate { "status_id": "...", "secret": "..." }
 */
app.post('/generate', async (req, res) => {
  const { status_id, secret } = req.body ?? {};
  if (secret !== WEBHOOK_SECRET) return res.sendStatus(401);
  if (!status_id) return res.status(400).json({ error: 'status_id required' });

  res.json({ queued: true, status_id });
  queueGeneration(status_id as string).catch(console.error);
});

/**
 * App-callable trigger — the mobile app calls this when it enters the
 * "waiting for video" state, ensuring generation is queued even if the
 * pg_net webhook trigger misfired or was never reached.
 *
 * No secret required: we validate server-side that the status is genuinely
 * paid/waived before queuing.  CORS is open so Expo web can call it.
 */
app.options('/request-generation', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.post('/request-generation', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { status_id } = req.body ?? {};
  if (!status_id) return res.status(400).json({ error: 'status_id required' });

  console.log(`[/request-generation] Queueing ${status_id}`);
  res.json({ queued: true, status_id });
  queueGeneration(status_id as string).catch(console.error);
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`PrimeStatus video generator on :${PORT}`));
