// ClubGG Gmail watcher — runs on Railway 24/7
// Monitors Gmail via IMAP IDLE and uploads report the moment the email arrives.

const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const API_URL        = process.env.API_URL || 'https://7max-tracker-production.up.railway.app/api/reports/upload-auto';
const API_KEY        = process.env.API_KEY;

const FROM_ADDRESS  = 'support@clubgg.com';
const SUBJECT_MATCH = '[MAX 7] - Club Data Report';

if (!GMAIL_USER || !GMAIL_PASSWORD || !API_URL || !API_KEY) {
  console.error('Missing required env vars: GMAIL_USER, GMAIL_PASSWORD, API_URL, API_KEY');
  process.exit(1);
}

const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const AdmZip           = require('adm-zip');
const axios            = require('axios');
const FormData         = require('form-data');

const processedUids = new Set();

function now() {
  return new Date().toISOString().slice(11, 19);
}

async function processEmail(client, uid) {
  if (processedUids.has(uid)) return;
  processedUids.add(uid);

  let xlsBuffer = null;
  let xlsFilename = null;

  for await (const msg of client.fetch([uid], { source: true })) {
    const parsed = await simpleParser(msg.source);
    console.log(`[${now()}] Processing: "${parsed.subject}"`);

    for (const att of parsed.attachments || []) {
      if (att.filename && att.filename.toLowerCase().endsWith('.zip')) {
        console.log(`[${now()}] Found ZIP: ${att.filename}`);

        const zip = new AdmZip(att.content);
        const xlsEntry = zip.getEntries().find(e => e.name.toLowerCase().endsWith('.xlsx'));
        if (!xlsEntry) { console.error('No .xlsx in ZIP'); return; }

        xlsBuffer = xlsEntry.getData();

        // Name file as yesterday's date: DD.M.YYYY.xlsx
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const d = yesterday.getDate();
        const m = yesterday.getMonth() + 1;
        const y = yesterday.getFullYear();
        xlsFilename = `${d}.${m}.${y}.xlsx`;

        console.log(`[${now()}] Extracted → ${xlsFilename} (${xlsBuffer.length} bytes)`);
        break;
      }
    }
  }

  if (!xlsBuffer) { console.error('No ZIP attachment found'); return; }

  console.log(`[${now()}] Uploading to tracker...`);
  const form = new FormData();
  form.append('file', xlsBuffer, {
    filename: xlsFilename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  try {
    const res = await axios.post(API_URL, form.getBuffer(), {
      headers: {
        'X-Api-Key': API_KEY,
        'Content-Type': `multipart/form-data; boundary=${form.getBoundary()}`
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    console.log(`[${now()}] ✅ Upload successful! Period: ${res.data.periodEnd || 'done'}`);
  } catch (e) {
    const msg = e.response?.data?.error || e.message;
    console.error(`[${now()}] ❌ Upload failed:`, msg);
    processedUids.delete(uid); // allow retry
  }
}

async function checkForTodaysEmail(client) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const uids = await client.search({
    from: FROM_ADDRESS,
    subject: SUBJECT_MATCH,
    since
  });

  for (const uid of uids) {
    await processEmail(client, uid);
  }
}

async function connect() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_PASSWORD },
    logger: false
  });

  await client.connect();
  console.log(`[${now()}] Connected to Gmail. Watching for ClubGG email...`);

  await client.mailboxOpen('INBOX');
  await checkForTodaysEmail(client);

  client.on('exists', async () => {
    await checkForTodaysEmail(client);
  });

  while (true) {
    try {
      await client.idle();
    } catch (e) {
      console.error(`[${now()}] IDLE error:`, e.message);
      break;
    }
  }

  try { await client.logout(); } catch {}
}

async function main() {
  console.log(`[${now()}] ClubGG watcher starting...`);
  while (true) {
    try {
      await connect();
    } catch (e) {
      console.error(`[${now()}] Connection failed: ${e.message} — reconnecting in 30s`);
    }
    await new Promise(r => setTimeout(r, 30000));
  }
}

main();
