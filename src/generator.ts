import puppeteer, { type Browser } from 'puppeteer';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APP_URL   = (process.env.APP_URL ?? '').replace(/\/$/, ''); // e.g. https://primestatus.site
const SECRET    = process.env.GENERATION_SECRET!;
const BUCKET    = 'generated-videos';

// Limit concurrent Puppeteer instances so we don't OOM the Railway container
const MAX_CONCURRENT = 2;
let   activeCount    = 0;
const pending: string[] = [];

export async function queueGeneration(statusId: string): Promise<void> {
  pending.push(statusId);
  drain();
}

function drain() {
  if (activeCount >= MAX_CONCURRENT || pending.length === 0) return;
  const id = pending.shift()!;
  activeCount++;
  generateVideo(id)
    .catch(console.error)
    .finally(() => { activeCount--; drain(); });
}

async function generateVideo(statusId: string): Promise<void> {
  console.log(`[${statusId}] Starting…`);

  await supabase
    .from('statuses')
    .update({ video_generation_status: 'processing' })
    .eq('id', statusId);

  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // Allow canvas.captureStream() + MediaRecorder without a real mic/cam
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        // Let audio elements autoplay without a gesture
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Capture console messages from the page for debugging
    page.on('console', msg => console.log(`[${statusId}][page] ${msg.text()}`));
    page.on('pageerror', err => console.error(`[${statusId}][page error]`, err));

    const base64 = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timeout: video generation took more than 4 minutes')),
        4 * 60 * 1000,
      );

      // These functions are called by the generate-video page when done / failed
      page.exposeFunction('__videoReady', (b64: string) => {
        clearTimeout(timer);
        resolve(b64);
      }).catch(() => {});

      page.exposeFunction('__videoError', (msg: string) => {
        clearTimeout(timer);
        reject(new Error(msg));
      }).catch(() => {});

      const url =
        `${APP_URL}/generate-video` +
        `?status_id=${encodeURIComponent(statusId)}` +
        `&secret=${encodeURIComponent(SECRET)}`;

      page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 }).catch(reject);
    });

    const videoBuffer = Buffer.from(base64, 'base64');
    console.log(`[${statusId}] Generated ${(videoBuffer.length / 1e6).toFixed(1)} MB — uploading…`);

    const filename = `${statusId}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(filename, videoBuffer, { contentType: 'video/mp4', upsert: true });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(filename);

    const { error: updateError } = await supabase
      .from('statuses')
      .update({
        generated_video_url:      urlData.publicUrl,
        video_generation_status:  'done',
      })
      .eq('id', statusId);

    if (updateError) throw updateError;

    console.log(`[${statusId}] Done → ${urlData.publicUrl}`);

  } catch (err) {
    console.error(`[${statusId}] Failed:`, err);
    await supabase
      .from('statuses')
      .update({ video_generation_status: 'failed' })
      .eq('id', statusId)
      .then(undefined, console.error);
  } finally {
    await browser?.close().catch(() => {});
  }
}
