// Kick live alerts — Telegram bot on Cloudflare Workers (free tier)
// Bindings: D1 database as DB
// Secrets: BOT_TOKEN, KICK_CLIENT_ID, KICK_CLIENT_SECRET, WEBHOOK_SECRET
// Cron trigger: * * * * *   (every minute)

const DEFAULT_TPL = '🔴 <b>{streamer}</b> is live on Kick!\n\n{title}\n🎮 {category}\n\n{url}';
const DEFAULT_OFFLINE_TPL = '⚫ <b>{streamer}</b> was live on Kick — stream ended.\n\n{title}\n⏱ {duration}';
const COOLDOWN_MS = 0; // 0 = alert every time they go live. e.g. 10 * 60 * 1000 = skip re-alerts within 10 min
const KICK_BATCH = 25;
const UNPIN_AFTER_MS = 5 * 60 * 1000; // unpin a pinned alert this long after the stream ends
const VERSION = '2026-11-09 topics';
const CHECKS_PER_MINUTE = 3; // 3 = every 20 seconds. Keep it at 4 or less.

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, title TEXT, added_by INTEGER)',
  'CREATE TABLE IF NOT EXISTS subs (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, slug TEXT, template TEXT, photo INTEGER DEFAULT 0, UNIQUE(chat_id, slug))',
  'CREATE TABLE IF NOT EXISTS streamers (slug TEXT PRIMARY KEY, is_live INTEGER DEFAULT 0, last_notified INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS pending (user_id INTEGER PRIMARY KEY, action TEXT, data TEXT)',
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, name TEXT, code TEXT, added_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, created_at INTEGER, used_by INTEGER)',
  // forum topics the bot has learned (Telegram doesn't let bots list them)
  'CREATE TABLE IF NOT EXISTS topics (chat_id INTEGER, thread_id INTEGER, name TEXT, PRIMARY KEY (chat_id, thread_id))',
];

// Columns added in later versions (added to existing databases automatically)
const NEW_COLUMNS = [
  'ALTER TABLE subs ADD COLUMN preview INTEGER DEFAULT 1',
  'ALTER TABLE subs ADD COLUMN offline_edit INTEGER DEFAULT 0',
  'ALTER TABLE subs ADD COLUMN offline_tpl TEXT',
  'ALTER TABLE subs ADD COLUMN last_msg_id INTEGER',
  'ALTER TABLE subs ADD COLUMN last_msg_photo INTEGER DEFAULT 0',
  'ALTER TABLE subs ADD COLUMN last_vars TEXT',
  'ALTER TABLE streamers ADD COLUMN live_at INTEGER',
  'ALTER TABLE subs ADD COLUMN enabled INTEGER DEFAULT 1',
  'ALTER TABLE subs ADD COLUMN pin INTEGER DEFAULT 0',
  'ALTER TABLE subs ADD COLUMN pinned_msg_id INTEGER',
  'ALTER TABLE subs ADD COLUMN unpin_at INTEGER',
  'ALTER TABLE subs ADD COLUMN thread_id INTEGER', // forum topic to post in (NULL = General)
  'ALTER TABLE chats ADD COLUMN is_forum INTEGER DEFAULT 0',
];

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  for (const sql of NEW_COLUMNS) {
    try { await env.DB.prepare(sql).run(); } catch (_) { /* column already exists */ }
  }
  schemaReady = true;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/tg' && req.method === 'POST') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        await handleUpdate(await req.json(), env);
      } catch (e) {
        console.error('update error', e && e.stack || e);
      }
      return new Response('ok');
    }

    if (url.pathname === '/setup') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) {
        return new Response('wrong secret', { status: 403 });
      }
      await ensureSchema(env);
      const me = await tg(env, 'getMe', {});
      if (me.ok) await kvSet(env, 'bot_username', me.result.username);
      const webhook = await tg(env, 'setWebhook', {
        url: url.origin + '/tg',
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        drop_pending_updates: true,
      });
      await tg(env, 'setMyCommands', {
        commands: [
          { command: 'start', description: 'Manage your Kick live alerts' },
          { command: 'app', description: 'Open the app' },
          { command: 'status', description: 'Check that live checks are working' },
          { command: 'cancel', description: 'Cancel the current step' },
        ],
        scope: { type: 'all_private_chats' },
      });
      await tg(env, 'setMyCommands', {
        commands: [{ command: 'here', description: 'Let me post alerts in this topic' }],
        scope: { type: 'all_chat_administrators' },
      });
      // the "Open app" button next to the message box
      const appUrl = url.origin + '/app';
      await kvSet(env, 'app_url', appUrl);
      const menu = await tg(env, 'setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Open app', web_app: { url: appUrl } },
      });
      let kick = 'ok';
      try { await kickToken(env, true); } catch (e) { kick = String(e.message || e); }
      return Response.json({ bot: me.ok ? '@' + me.result.username : me, webhook, kick, app: menu.ok ? appUrl : menu },
        { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/app') {
      return new Response(APP_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api' && req.method === 'POST') {
      try {
        return await handleApi(req, env);
      } catch (e) {
        console.error('api error', e && e.stack || e);
        return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
      }
    }

    return new Response('Kick live bot is running. Version: ' + VERSION);
  },

  // Cron fires once a minute; inside each run we check several times, spaced out
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      for (let i = 0; i < CHECKS_PER_MINUTE; i++) {
        if (i) await new Promise((r) => setTimeout(r, 60000 / CHECKS_PER_MINUTE));
        await poll(env);
      }
    })());
  },
};

/* ---------------- Telegram helpers ---------------- */

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Turn a Telegram message's formatting (bold, italic, links...) into HTML
function toHtml(text, entities = []) {
  const tags = { bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code', spoiler: 'tg-spoiler' };
  const opens = {};
  const closes = {};
  for (const e of entities) {
    let open, close;
    if (tags[e.type]) { open = `<${tags[e.type]}>`; close = `</${tags[e.type]}>`; }
    else if (e.type === 'text_link') { open = `<a href="${esc(e.url)}">`; close = '</a>'; }
    else continue;
    (opens[e.offset] ||= []).push(open);
    (closes[e.offset + e.length] ||= []).unshift(close);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    if (closes[i]) out += closes[i].join('');
    if (opens[i]) out += opens[i].join('');
    if (i < text.length) out += esc(text[i]);
  }
  return out;
}

function render(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
}

function previewOpts(sub, vars) {
  return sub.preview === 0
    ? { is_disabled: true }
    : { url: vars.url, prefer_large_media: true };
}

// Returns Telegram's answer; r.asPhoto is true when it went out as a photo
async function sendAlert(env, chatId, sub, vars) {
  const text = render(sub.template, vars);
  // into the chosen forum topic, but only when posting to the alert's own chat
  const where = { chat_id: chatId, ...(chatId === sub.chat_id && sub.thread_id ? { message_thread_id: sub.thread_id } : {}) };
  if (sub.photo && vars.thumbnail) {
    const r = await toTopic(env, 'sendPhoto', { ...where, photo: vars.thumbnail, caption: text.slice(0, 1024), parse_mode: 'HTML' }, sub);
    if (r.ok) { r.asPhoto = true; return r; }
  }
  return toTopic(env, 'sendMessage', { ...where, text, parse_mode: 'HTML', link_preview_options: previewOpts(sub, vars) }, sub);
}

// Send to a topic; if the topic was deleted or closed, post in General instead and note it
async function toTopic(env, method, body, sub) {
  const r = await tg(env, method, body);
  if (!r.ok && body.message_thread_id && /thread|topic/i.test(r.description || '')) {
    const { message_thread_id, ...general } = body;
    const r2 = await tg(env, method, general);
    if (r2.ok) r2.topicFallback = r.description;
    return r2;
  }
  return r;
}

async function topicName(env, chatId, threadId) {
  if (!threadId) return 'General';
  const t = await db(env, 'SELECT name FROM topics WHERE chat_id=? AND thread_id=?', chatId, threadId).first();
  return t ? t.name : 'Topic #' + threadId;
}

// Ask Telegram whether a group has topics turned on (it can change at any time)
async function refreshForum(env, chatId) {
  const c = await tg(env, 'getChat', { chat_id: chatId });
  if (!c.ok) return null;
  const f = c.result.is_forum ? 1 : 0;
  await db(env, 'UPDATE chats SET is_forum=? WHERE chat_id=?', f, chatId).run();
  return f;
}

async function listTopics(env, chatId) {
  const { results } = await db(env, 'SELECT thread_id, name FROM topics WHERE chat_id=? ORDER BY name COLLATE NOCASE', chatId).all();
  return results.map((t) => ({ id: t.thread_id, name: t.name || 'Topic #' + t.thread_id }));
}

async function hereCommand(env) {
  const bot = await kvGet(env, 'bot_username');
  return '/here' + (bot ? '@' + bot : '');
}

// Remember a forum topic (from a topic being created/renamed, or /here sent inside it)
async function learnTopic(env, chatId, threadId, name) {
  if (!threadId) return;
  await env.DB.batch([
    db(env, 'INSERT INTO topics (chat_id,thread_id,name) VALUES (?,?,?) ON CONFLICT(chat_id,thread_id) DO UPDATE SET name=COALESCE(excluded.name, topics.name)',
      chatId, threadId, name || null),
    db(env, 'UPDATE chats SET is_forum=1 WHERE chat_id=?', chatId),
  ]);
}

function formatDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

// offline_edit: 0 = nothing, 1 = edit the live alert, 2 = post a new message
const OFFLINE_MODES = ['nothing', 'edit alert', 'new message'];
// pin: 0 = don't pin, 1 = pin quietly, 2 = pin and notify all members
const PIN_MODES = ['off', 'pin quietly', 'pin + notify all'];

// Can the bot pin in this chat? Returns null if yes, otherwise what's missing.
async function pinProblem(env, chatId) {
  let botId = await kvGet(env, 'bot_id');
  if (!botId) {
    const me = await tg(env, 'getMe', {});
    if (!me.ok) return null;
    botId = String(me.result.id);
    await kvSet(env, 'bot_id', botId);
  }
  const [m, c] = await Promise.all([
    tg(env, 'getChatMember', { chat_id: chatId, user_id: Number(botId) }),
    tg(env, 'getChat', { chat_id: chatId }),
  ]);
  if (!m.ok || !c.ok) return null; // can't tell, don't nag
  const r = m.result, isChannel = c.result.type === 'channel';
  if (r.status !== 'administrator') return "I'm not an admin in this chat, so I can't pin.";
  if (isChannel ? r.can_edit_messages === false : r.can_pin_messages === false) {
    return `I'm an admin but missing the “${isChannel ? 'Edit messages' : 'Pin messages'}” right, so I can't pin.`;
  }
  return null;
}

// The "stream ended" message: edits the live alert, or posts a new one
async function editToOffline(env, sub, liveAt) {
  const vars = { ...(sub.last_vars ? JSON.parse(sub.last_vars) : sampleVars(sub.slug)) };
  vars.duration = liveAt ? formatDuration(Date.now() - liveAt) : '';
  vars.viewers = '';
  const text = render(sub.offline_tpl || DEFAULT_OFFLINE_TPL, vars);
  if (sub.offline_edit === 2) {
    return toTopic(env, 'sendMessage', {
      chat_id: sub.chat_id, ...(sub.thread_id ? { message_thread_id: sub.thread_id } : {}),
      text, parse_mode: 'HTML', link_preview_options: previewOpts(sub, vars),
    }, sub);
  }
  return sub.last_msg_photo
    ? tg(env, 'editMessageCaption', { chat_id: sub.chat_id, message_id: sub.last_msg_id, caption: text.slice(0, 1024), parse_mode: 'HTML' })
    : tg(env, 'editMessageText', { chat_id: sub.chat_id, message_id: sub.last_msg_id, text, parse_mode: 'HTML', link_preview_options: previewOpts(sub, vars) });
}

/* ---------------- DB helpers ---------------- */

const db = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);

async function kvGet(env, k) {
  const r = await db(env, 'SELECT v FROM kv WHERE k=?', k).first();
  return r ? r.v : null;
}
async function kvSet(env, k, v) {
  await db(env, 'INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)', k, v).run();
}
async function setPending(env, userId, action, data) {
  await db(env, 'INSERT OR REPLACE INTO pending (user_id,action,data) VALUES (?,?,?)', userId, action, String(data)).run();
}
async function clearPending(env, userId) {
  await db(env, 'DELETE FROM pending WHERE user_id=?', userId).run();
}
async function cleanupStreamers(env) {
  await db(env, 'DELETE FROM streamers WHERE slug NOT IN (SELECT slug FROM subs)').run();
}

/* ---------------- Kick API ---------------- */

async function kickToken(env, force = false) {
  if (!force) {
    const raw = await kvGet(env, 'kick_token');
    if (raw) {
      const t = JSON.parse(raw);
      if (t.exp > Date.now() + 60000) return t.token;
    }
  }
  const r = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Kick login failed — check KICK_CLIENT_ID / KICK_CLIENT_SECRET (' + r.status + ')');
  await kvSet(env, 'kick_token', JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }));
  return j.access_token;
}

async function kickChannels(env, slugs) {
  const out = {};
  for (let i = 0; i < slugs.length; i += KICK_BATCH) {
    const qs = slugs.slice(i, i + KICK_BATCH).map((s) => 'slug=' + encodeURIComponent(s)).join('&');
    const get = (token) => fetch('https://api.kick.com/public/v1/channels?' + qs, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    let r = await get(await kickToken(env));
    if (r.status === 401) r = await get(await kickToken(env, true));
    if (!r.ok) throw new Error('Kick API ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    for (const c of j.data || []) out[String(c.slug || '').toLowerCase()] = c;
  }
  return out;
}

function varsFrom(c, slug) {
  const s = (c && c.stream) || {};
  return {
    streamer: (c && c.slug) || slug,
    title: (c && c.stream_title) || '',
    category: (c && c.category && c.category.name) || '',
    viewers: s.viewer_count != null ? String(s.viewer_count) : '',
    url: 'https://kick.com/' + slug,
    thumbnail: s.thumbnail || '',
  };
}

function sampleVars(slug) {
  return { streamer: slug, title: 'Example stream title', category: 'Just Chatting', viewers: '1234', url: 'https://kick.com/' + slug, thumbnail: '', duration: '2h 15m' };
}

function parseSlug(input) {
  let s = input.trim().replace(/^@/, '');
  const m = s.match(/kick\.com\/([A-Za-z0-9_-]+)/i);
  if (m) s = m[1];
  return /^[A-Za-z0-9_-]{2,40}$/.test(s) ? s.toLowerCase() : null;
}

/* ---------------- Poller (cron) ---------------- */

async function poll(env) {
  const status = { at: Date.now(), error: null, streamers: {}, sendErrors: [], fields: null };
  try {
    await pollInner(env, status);
  } catch (e) {
    status.error = String(e && e.message || e);
    console.error('poll error', e && e.stack || e);
  }
  await kvSet(env, 'status', JSON.stringify(status));
  if (status.sendErrors.length) {
    await kvSet(env, 'send_errors', JSON.stringify({ at: status.at, list: status.sendErrors }));
  }
}

async function statusText(env, userId) {
  // only this person's own streamers and chats
  const { results: mine } = await db(env,
    'SELECT DISTINCT subs.slug FROM subs JOIN chats ON chats.chat_id = subs.chat_id WHERE chats.added_by=?', userId).all();
  const mySlugs = new Set(mine.map((r) => r.slug));
  const { results: myChats } = await db(env, 'SELECT chat_id FROM chats WHERE added_by=?', userId).all();
  const myChatIds = myChats.map((c) => String(c.chat_id));

  const raw = await kvGet(env, 'status');
  if (!raw) return '⚠️ The background check has <b>never run</b>. Check the Cron Trigger (<code>* * * * *</code>) in Cloudflare → Settings → Trigger events.';
  const s = JSON.parse(raw);
  const ago = Math.round((Date.now() - s.at) / 1000);
  let t = `<b>Last check:</b> ${ago}s ago ${ago > 150 ? '⚠️ (cron may have stopped)' : '✅'}\n`;
  if (s.error) t += `\n❌ <b>Error:</b> ${esc(s.error)}\n`;
  const names = Object.keys(s.streamers).filter((n) => mySlugs.has(n));
  t += '\n<b>What Kick reports:</b>\n' + (names.length
    ? names.map((n) => `• ${esc(n)}: ${esc(s.streamers[n])}`).join('\n')
    : '(no streamers added yet)');
  const rows = (await db(env, 'SELECT slug, is_live, last_notified FROM streamers').all()).results.filter((r) => mySlugs.has(r.slug));
  if (rows.length) {
    t += '\n\n<b>Bot memory:</b>\n' + rows.map((r) =>
      `• ${esc(r.slug)}: ${r.is_live ? 'live' : 'offline'}, last alert ${r.last_notified ? new Date(r.last_notified).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}`
    ).join('\n');
  }
  const se = await kvGet(env, 'send_errors');
  const e = se ? JSON.parse(se) : null;
  const myErrors = e ? e.list.filter((line) => myChatIds.some((id) => line.includes('→ ' + id + ':'))) : [];
  if (myErrors.length) {
    e.list = myErrors;
    t += `\n\n<b>Last failed alert</b> (${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} UTC):\n` + e.list.map(esc).join('\n');
  }
  if (s.fields) t += `\n\n<i>Kick fields: ${esc(s.fields.channel.join(', '))} | stream: ${esc((s.fields.stream || []).join(', '))}</i>`;
  return t;
}

async function pollInner(env, status) {
  await ensureSchema(env);
  const now = Date.now();

  // unpin alerts whose stream ended at least UNPIN_AFTER_MS ago
  const { results: due } = await db(env,
    'SELECT id, chat_id, slug, pinned_msg_id FROM subs WHERE unpin_at IS NOT NULL AND unpin_at <= ?', now).all();
  for (const sub of due) {
    const r = await tg(env, 'unpinChatMessage', { chat_id: sub.chat_id, message_id: sub.pinned_msg_id });
    if (!r.ok && !/not found|not modified|MESSAGE_ID_INVALID/i.test(r.description || '')) {
      status.sendErrors.push(`${sub.slug} → ${sub.chat_id}: unpin failed: ${r.description}`);
    }
    await db(env, 'UPDATE subs SET pinned_msg_id=NULL, unpin_at=NULL WHERE id=?', sub.id).run();
  }

  const { results: rows } = await db(env, 'SELECT * FROM streamers').all();
  if (!rows.length) return;
  const data = await kickChannels(env, rows.map((r) => r.slug));
  const any = Object.values(data)[0];
  if (any) status.fields = { channel: Object.keys(any), stream: any.stream ? Object.keys(any.stream) : null };

  for (const s of rows) {
    const c = data[s.slug];
    if (!c) { status.streamers[s.slug] = 'not returned by Kick'; continue; } // don't flip state
    const live = c.stream && c.stream.is_live ? 1 : 0;
    status.streamers[s.slug] = live ? 'live' : 'offline';
    if (live === s.is_live) continue;

    if (live && now - (s.last_notified || 0) > COOLDOWN_MS) {
      await db(env, 'UPDATE streamers SET is_live=1, last_notified=?, live_at=? WHERE slug=?', now, now, s.slug).run();
      const { results: subs } = await db(env, 'SELECT * FROM subs WHERE slug=? AND COALESCE(enabled,1)=1', s.slug).all();
      const vars = varsFrom(c, s.slug);
      for (const sub of subs) {
        const r = await sendAlert(env, sub.chat_id, sub, vars);
        if (r.ok && r.topicFallback) {
          status.sendErrors.push(`${s.slug} → ${sub.chat_id}: topic unavailable (${r.topicFallback}), posted in General instead`);
        }
        if (r.ok) {
          // remember the message so it can be edited when the stream ends
          await db(env, 'UPDATE subs SET last_msg_id=?, last_msg_photo=?, last_vars=? WHERE id=?',
            r.result.message_id, r.asPhoto ? 1 : 0, JSON.stringify(vars), sub.id).run();
          if (sub.pin) {
            // back live before the last alert was unpinned: unpin the old one now
            if (sub.pinned_msg_id) {
              await tg(env, 'unpinChatMessage', { chat_id: sub.chat_id, message_id: sub.pinned_msg_id });
            }
            const pr = await tg(env, 'pinChatMessage', {
              chat_id: sub.chat_id, message_id: r.result.message_id, disable_notification: sub.pin !== 2,
            });
            if (pr.ok) {
              await db(env, 'UPDATE subs SET pinned_msg_id=?, unpin_at=NULL WHERE id=?', r.result.message_id, sub.id).run();
            } else {
              status.sendErrors.push(`${s.slug} → ${sub.chat_id}: pin failed: ${pr.description}`);
            }
          }
        } else {
          status.sendErrors.push(`${s.slug} → ${sub.chat_id}: ${r.description}`);
          console.error('send failed', sub.chat_id, r.description);
        }
      }
      status.streamers[s.slug] = 'live — alert sent';
    } else if (live) {
      await db(env, 'UPDATE streamers SET is_live=1, live_at=COALESCE(live_at, ?) WHERE slug=?', now, s.slug).run();
    } else {
      // stream ended
      await db(env, 'UPDATE streamers SET is_live=0 WHERE slug=?', s.slug).run();
      // schedule the pinned alert to be unpinned in 5 minutes
      await db(env, 'UPDATE subs SET unpin_at=? WHERE slug=? AND pinned_msg_id IS NOT NULL AND unpin_at IS NULL',
        now + UNPIN_AFTER_MS, s.slug).run();
      const { results: subs } = await db(env,
        'SELECT * FROM subs WHERE slug=? AND offline_edit>0 AND last_msg_id IS NOT NULL', s.slug).all();
      for (const sub of subs) {
        const r = await editToOffline(env, sub, s.live_at);
        if (!r.ok) status.sendErrors.push(`${s.slug} → ${sub.chat_id}: stream-ended message failed: ${r.description}`);
        await db(env, 'UPDATE subs SET last_msg_id=NULL WHERE id=?', sub.id).run();
      }
      if (subs.length) status.streamers[s.slug] = 'offline — stream-ended message done';
    }
  }
}

/* ---------------- Updates ---------------- */

async function handleUpdate(u, env) {
  await ensureSchema(env);
  if (u.my_chat_member) return onMembership(u.my_chat_member, env);
  if (u.callback_query) return onCallback(u.callback_query, env);
  if (u.message) return onMessage(u.message, env);
}

/* ---------------- Access control ---------------- */

async function ownerId(env) {
  const v = await kvGet(env, 'owner');
  return v ? Number(v) : null;
}

async function isAllowed(env, userId) {
  if (userId === (await ownerId(env))) return true;
  return !!(await db(env, 'SELECT 1 AS x FROM users WHERE user_id=?', userId).first());
}

function displayName(u) {
  return u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id);
}

function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}

// Try an access code (or the owner secret). Returns 'owner', 'ok' or 'invalid'.
async function redeemCode(env, user, rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return 'invalid';
  if (!(await ownerId(env)) && code === env.WEBHOOK_SECRET) {
    await kvSet(env, 'owner', String(user.id));
    if (user.username) await kvSet(env, 'owner_username', user.username);
    return 'owner';
  }
  const row = await db(env, 'SELECT * FROM codes WHERE code=? AND used_by IS NULL', code.toUpperCase()).first();
  if (!row) return 'invalid';
  const name = displayName(user);
  await env.DB.batch([
    db(env, 'UPDATE codes SET used_by=? WHERE code=?', user.id, row.code),
    db(env, 'INSERT OR REPLACE INTO users (user_id,name,code,added_at) VALUES (?,?,?,?)', user.id, name, row.code, Date.now()),
  ]);
  const owner = await ownerId(env);
  if (owner) await reply(env, owner, `✅ ${esc(name)} joined with code <code>${row.code}</code>.`);
  return 'ok';
}

// Messages from people who don't have access yet
async function handleLocked(env, msg) {
  const userId = msg.from.id;
  const code = msg.text.trim().replace(/^\/start\s*/, '').trim();
  if (!code) return show(env, userId, await lockedScreen(env));
  const result = await redeemCode(env, msg.from, code);
  if (result === 'invalid') return show(env, userId, await lockedScreen(env, "❌ That code isn't valid or was already used."));
  await reply(env, userId, result === 'owner'
    ? '👑 You are now the owner. Use the <b>👑 Access</b> button to make codes for other people.'
    : '✅ Access granted!');
  return show(env, userId, await mainScreen(env, userId));
}

async function lockedScreen(env, note = '') {
  const uname = await kvGet(env, 'owner_username');
  const kb = [];
  const app = await appButton(env);
  if (app) kb.push([app]);
  if (uname) kb.push([{ text: '💬 Message the owner', url: `https://t.me/${uname}` }]);
  kb.push([{ text: '🙋 Request access', callback_data: 'req' }]);
  return {
    text: (note ? note + '\n\n' : '') +
      '🔒 <b>This bot is private.</b>\n\nIf you have an access code, send it here. ' +
      'To get one, contact the owner or tap <b>Request access</b>.',
    kb,
  };
}

// A person without access tapped "Request access"
async function onAccessRequest(env, cq) {
  return requestAccess(env, cq.from);
}

async function requestAccess(env, u) {
  const owner = await ownerId(env);
  if (!owner) return 'The bot has no owner yet.';
  const key = 'req:' + u.id;
  const prev = await kvGet(env, key);
  if (prev && Date.now() - JSON.parse(prev).at < 3600000) return 'Already requested. The owner will get back to you.';
  const name = displayName(u);
  await kvSet(env, key, JSON.stringify({ at: Date.now(), name }));
  await tg(env, 'sendMessage', {
    chat_id: owner,
    text: `🙋 <b>${esc(name)}</b> is asking for access to the bot.` + (u.username ? '' : `\n(user ID ${u.id})`),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Give access', callback_data: 'ok:' + u.id },
      { text: '✖️ Ignore', callback_data: 'no:' + u.id },
    ]] },
  });
  return 'Request sent to the owner ✅';
}

// Owner approves (ok=true) or ignores an access request. Returns the person's name.
async function decideRequest(env, uid, ok) {
  const req = await kvGet(env, 'req:' + uid);
  const name = req ? JSON.parse(req).name : String(uid);
  await db(env, 'DELETE FROM kv WHERE k=?', 'req:' + uid).run();
  if (ok) {
    await db(env, 'INSERT OR REPLACE INTO users (user_id,name,code,added_at) VALUES (?,?,?,?)', uid, name, 'request', Date.now()).run();
    await reply(env, uid, '✅ The owner gave you access!');
    await show(env, uid, await mainScreen(env, uid));
  }
  return name;
}

async function createCode(env) {
  const code = newCode();
  await db(env, 'INSERT INTO codes (code,created_at) VALUES (?,?)', code, Date.now()).run();
  return code;
}

// Remove a person: leave the chats they added and delete their setup. Returns their name.
async function removeUser(env, uid) {
  const u = await db(env, 'SELECT * FROM users WHERE user_id=?', uid).first();
  const { results: ch } = await db(env, 'SELECT chat_id FROM chats WHERE added_by=?', uid).all();
  for (const c of ch) await tg(env, 'leaveChat', { chat_id: c.chat_id });
  await env.DB.batch([
    db(env, 'DELETE FROM subs WHERE chat_id IN (SELECT chat_id FROM chats WHERE added_by=?)', uid),
    db(env, 'DELETE FROM chats WHERE added_by=?', uid),
    db(env, 'DELETE FROM users WHERE user_id=?', uid),
    db(env, 'DELETE FROM pending WHERE user_id=?', uid),
  ]);
  await cleanupStreamers(env);
  return u ? u.name : String(uid);
}

async function codeNote(env, code) {
  const bot = await kvGet(env, 'bot_username');
  return `🔑 New code: <code>${code}</code>\n` +
    (bot ? `Or send them this link, which enters the code for them:\n<code>https://t.me/${bot}?start=${code}</code>` : '');
}

async function accessScreen(env, note = '') {
  const { results: users } = await db(env, 'SELECT * FROM users ORDER BY added_at').all();
  const { results: codes } = await db(env, 'SELECT code FROM codes WHERE used_by IS NULL ORDER BY created_at').all();
  return {
    text: (note ? note + '\n\n' : '') +
      `<b>👑 Access</b>\nPeople with access: ${users.length}\nUnused codes: ${codes.length}\n\n` +
      'Each code works once. Tap ❌ to remove a person (I also leave the groups they added) or delete an unused code.',
    kb: [
      [{ text: '🔑 New code', callback_data: 'nc' }],
      ...users.map((u) => [{ text: '❌ ' + u.name, callback_data: 'ux:' + u.user_id }]),
      ...codes.map((c) => [{ text: '❌ code ' + c.code, callback_data: 'cx:' + c.code }]),
      [{ text: '« Back', callback_data: 'm' }],
    ],
  };
}

async function onMembership(m, env) {
  const chat = m.chat;
  if (chat.type === 'private') return;
  const st = m.new_chat_member.status;

  if ((st === 'member' || st === 'administrator') && !(await isAllowed(env, m.from.id))) {
    await tg(env, 'leaveChat', { chat_id: chat.id });
    await reply(env, m.from.id, '🔒 This bot is private, so I left that chat. Send me an access code from the owner first.');
    return;
  }

  if (st === 'member' || st === 'administrator') {
    await db(env,
      'INSERT INTO chats (chat_id,title,added_by,is_forum) VALUES (?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, is_forum=excluded.is_forum',
      chat.id, chat.title || String(chat.id), m.from.id, chat.is_forum ? 1 : 0).run();
    const old = m.old_chat_member.status;
    if (old === 'left' || old === 'kicked') {
      await tg(env, 'sendMessage', {
        chat_id: m.from.id,
        text: `✅ I was added to <b>${esc(chat.title || chat.id)}</b>.\nTap /start to pick which Kick streamers to announce there.`,
        parse_mode: 'HTML',
      });
    }
  } else if (st === 'left' || st === 'kicked') {
    await env.DB.batch([
      db(env, 'DELETE FROM subs WHERE chat_id=?', chat.id),
      db(env, 'DELETE FROM topics WHERE chat_id=?', chat.id),
      db(env, 'DELETE FROM chats WHERE chat_id=?', chat.id),
    ]);
    await cleanupStreamers(env);
  }
}

// Messages inside groups: only used to learn forum topics
async function onGroupMessage(msg, env) {
  const chatId = msg.chat.id;
  const tid = msg.message_thread_id;
  if (msg.forum_topic_created) return learnTopic(env, chatId, tid, msg.forum_topic_created.name);
  if (msg.forum_topic_edited && msg.forum_topic_edited.name) return learnTopic(env, chatId, tid, msg.forum_topic_edited.name);

  const cmd = (msg.text || '').trim().split(/\s+/)[0].toLowerCase();
  if (cmd !== '/here' && !cmd.startsWith('/here@')) return;
  const chat = await db(env, 'SELECT * FROM chats WHERE chat_id=?', chatId).first();
  if (!chat || chat.added_by !== msg.from.id) return; // only the person who set the bot up here
  if (!msg.chat.is_forum || !msg.is_topic_message || !tid) {
    await tg(env, 'sendMessage', { chat_id: chatId, ...(tid ? { message_thread_id: tid } : {}),
      text: 'This is the General topic. Alerts go here unless you pick another topic.' });
    return;
  }
  // in a topic, messages reply to the "topic created" message, which carries the name
  const created = msg.reply_to_message && msg.reply_to_message.forum_topic_created;
  await learnTopic(env, chatId, tid, created ? created.name : null);
  const name = await topicName(env, chatId, tid);
  await tg(env, 'sendMessage', { chat_id: chatId, message_thread_id: tid, parse_mode: 'HTML',
    text: `✅ Got it. <b>${esc(name)}</b> can now be picked for alerts in the bot.` });
  await tg(env, 'deleteMessage', { chat_id: chatId, message_id: msg.message_id }); // tidy up if allowed
}

async function onMessage(msg, env) {
  // group upgraded to supergroup: chat id changes
  if (msg.migrate_to_chat_id) {
    await env.DB.batch([
      db(env, 'UPDATE OR IGNORE chats SET chat_id=? WHERE chat_id=?', msg.migrate_to_chat_id, msg.chat.id),
      db(env, 'UPDATE OR IGNORE subs SET chat_id=? WHERE chat_id=?', msg.migrate_to_chat_id, msg.chat.id),
      db(env, 'UPDATE OR IGNORE topics SET chat_id=? WHERE chat_id=?', msg.migrate_to_chat_id, msg.chat.id),
    ]);
    return;
  }
  if (msg.chat.type !== 'private') return onGroupMessage(msg, env);
  if (!msg.text) return;

  const userId = msg.from.id;
  const text = msg.text.trim();

  if (!(await isAllowed(env, userId))) return handleLocked(env, msg);

  // keep the owner's @username current for the "Message the owner" button
  if (userId === (await ownerId(env)) && msg.from.username &&
      msg.from.username !== (await kvGet(env, 'owner_username'))) {
    await kvSet(env, 'owner_username', msg.from.username);
  }

  if (text === '/newcode' && userId === (await ownerId(env))) {
    const code = await createCode(env);
    return show(env, userId, await accessScreen(env, await codeNote(env, code)));
  }
  if (text === '/app') {
    const app = await appButton(env);
    return app
      ? show(env, userId, { text: 'Tap below to open the app.', kb: [[app]] })
      : reply(env, userId, 'The app isn\'t set up yet. The owner needs to open the setup link once.');
  }
  if (text.startsWith('/start') || text === '/menu') {
    await clearPending(env, userId);
    return show(env, userId, await mainScreen(env, userId));
  }
  if (text === '/status') {
    return reply(env, userId, await statusText(env, userId));
  }
  if (text === '/cancel') {
    await clearPending(env, userId);
    return show(env, userId, await mainScreen(env, userId));
  }

  const p = await db(env, 'SELECT * FROM pending WHERE user_id=?', userId).first();
  if (!p) return show(env, userId, await mainScreen(env, userId));

  if (p.action === 'add') {
    const chatId = Number(p.data);
    const r = await addStreamer(env, userId, chatId, text);
    if (r.gone) { await clearPending(env, userId); return reply(env, userId, r.error); }
    if (r.error) return reply(env, userId, r.error + ' Or /cancel.');
    await clearPending(env, userId);
    return show(env, userId, await subScreen(env, userId, r.subId, `✅ Now watching <b>${esc(r.slug)}</b>.`));
  }

  if (p.action === 'tpl' || p.action === 'otpl') {
    const sub = await getSub(env, Number(p.data));
    if (!sub || !(await canManage(env, userId, sub.chat_id))) { await clearPending(env, userId); return reply(env, userId, 'That alert no longer exists.'); }
    const tpl = toHtml(msg.text, msg.entities || []);
    // validate by sending a preview to the user
    const test = await sendAlert(env, userId, { ...sub, template: tpl, photo: 0 }, sampleVars(sub.slug));
    if (!test.ok) return reply(env, userId, 'Telegram rejected that message: ' + esc(test.description || 'unknown error') + '\nTry again or /cancel.');
    await db(env, `UPDATE subs SET ${p.action === 'tpl' ? 'template' : 'offline_tpl'}=? WHERE id=?`, tpl, sub.id).run();
    await clearPending(env, userId);
    return show(env, userId, await subScreen(env, userId, sub.id, '✅ Message saved (preview above).'));
  }

  await clearPending(env, userId);
  return show(env, userId, await mainScreen(env, userId));
}

async function onCallback(cq, env) {
  const userId = cq.from.id;
  const msgId = cq.message && cq.message.message_id;
  const [act, arg] = String(cq.data || '').split(':');
  let toast = '';

  try {
    if (!(await isAllowed(env, userId))) {
      toast = act === 'req' ? await onAccessRequest(env, cq) : 'This bot is private. Send your access code first.';
      return;
    }
    const isOwner = userId === (await ownerId(env));

    if (['acc', 'nc', 'ux', 'uxy', 'cx', 'ok', 'no'].includes(act)) {
      if (!isOwner) { toast = 'Owner only'; return; }
      if (act === 'ok' || act === 'no') {
        const name = await decideRequest(env, Number(arg), act === 'ok');
        await tg(env, 'editMessageText', {
          chat_id: userId, message_id: msgId, parse_mode: 'HTML',
          text: act === 'ok' ? `✅ Gave access to <b>${esc(name)}</b>.` : `✖️ Ignored the request from <b>${esc(name)}</b>.`,
        });
      } else if (act === 'acc') {
        await clearPending(env, userId);
        await show(env, userId, await accessScreen(env), msgId);
      } else if (act === 'nc') {
        const code = await createCode(env);
        await show(env, userId, await accessScreen(env, await codeNote(env, code)), msgId);
      } else if (act === 'cx') {
        await db(env, 'DELETE FROM codes WHERE code=? AND used_by IS NULL', arg).run();
        await show(env, userId, await accessScreen(env, `🗑 Code ${esc(arg)} deleted.`), msgId);
      } else if (act === 'ux') {
        const u = await db(env, 'SELECT * FROM users WHERE user_id=?', Number(arg)).first();
        if (!u) { await show(env, userId, await accessScreen(env), msgId); return; }
        const { results: ch } = await db(env, 'SELECT title FROM chats WHERE added_by=?', u.user_id).all();
        await show(env, userId, {
          text: `Remove <b>${esc(u.name)}</b>?\n\n` + (ch.length
            ? `I'll also leave the chats they added:\n${ch.map((c) => '• ' + esc(c.title)).join('\n')}`
            : "They haven't added me to any chats."),
          kb: [[{ text: '❌ Yes, remove', callback_data: 'uxy:' + u.user_id }], [{ text: '« Back', callback_data: 'acc' }]],
        }, msgId);
      } else if (act === 'uxy') {
        const name = await removeUser(env, Number(arg));
        await show(env, userId, await accessScreen(env, `🗑 Removed ${esc(name)}.`), msgId);
      }
    } else if (act === 'ad') {
      await show(env, userId, await addScreen(env, arg === '1'), msgId);
    } else if (act === 'm') {
      await clearPending(env, userId);
      await show(env, userId, await mainScreen(env, userId), msgId);
    } else if (act === 'c') {
      await clearPending(env, userId);
      await show(env, userId, await chatScreen(env, userId, Number(arg)), msgId);
    } else if (act === 's') {
      await clearPending(env, userId);
      await show(env, userId, await subScreen(env, userId, Number(arg)), msgId);
    } else if (act === 'a') {
      if (!(await canManage(env, userId, Number(arg)))) toast = 'Not allowed';
      else {
        await setPending(env, userId, 'add', arg);
        await show(env, userId, {
          text: 'Send me the Kick username or channel link, e.g. <code>xqc</code> or <code>https://kick.com/xqc</code>',
          kb: [[{ text: '« Cancel', callback_data: 'c:' + arg }]],
        }, msgId);
      }
    } else {
      const sub = await getSub(env, Number(String(arg).split('_')[0]));
      if (!sub || !(await canManage(env, userId, sub.chat_id))) toast = 'Not found';
      else if (act === 'tp') {
        await show(env, userId, await topicScreen(env, sub), msgId);
      } else if (act === 'ts') {
        const tid = Number(String(arg).split('_')[1]) || 0;
        const known = !tid || (await db(env, 'SELECT 1 AS x FROM topics WHERE chat_id=? AND thread_id=?', sub.chat_id, tid).first());
        if (!known) toast = 'Unknown topic';
        else {
          await db(env, 'UPDATE subs SET thread_id=? WHERE id=?', tid || null, sub.id).run();
          await show(env, userId, await subScreen(env, userId, sub.id, `💬 Alerts now go to <b>${esc(await topicName(env, sub.chat_id, tid))}</b>.`), msgId);
        }
      }
      else if (act === 'e') {
        await setPending(env, userId, 'tpl', sub.id);
        await show(env, userId, {
          text:
            'Send the new alert message.\n\nYou can use Telegram formatting (bold, italic, links) and these placeholders:\n' +
            '<code>{streamer}</code> – channel name\n<code>{title}</code> – stream title\n<code>{category}</code> – game/category\n' +
            '<code>{viewers}</code> – viewer count\n<code>{url}</code> – stream link\n\n' +
            'Example:\n<code>' + esc('{streamer} is live: {title}\n{url}') + '</code>',
          kb: [[{ text: '« Cancel', callback_data: 's:' + sub.id }]],
        }, msgId);
      } else if (act === 'eo') {
        await setPending(env, userId, 'otpl', sub.id);
        await show(env, userId, {
          text:
            'Send the "stream ended" message.\n\nPlaceholders:\n' +
            '<code>{streamer}</code> – channel name\n<code>{title}</code> – the stream\'s title\n<code>{category}</code> – game/category\n' +
            '<code>{duration}</code> – how long they were live\n<code>{url}</code> – channel link\n\n' +
            'Example:\n<code>' + esc('Stream is offline. {streamer} was live for {duration}.') + '</code>',
          kb: [[{ text: '« Cancel', callback_data: 's:' + sub.id }]],
        }, msgId);
      } else if (act === 'pn') {
        await db(env, 'UPDATE subs SET pin=? WHERE id=?', ((sub.pin || 0) + 1) % 3, sub.id).run();
        await show(env, userId, await subScreen(env, userId, sub.id), msgId);
      } else if (act === 'oe') {
        await db(env, 'UPDATE subs SET offline_edit=? WHERE id=?', ((sub.offline_edit || 0) + 1) % 3, sub.id).run();
        await show(env, userId, await subScreen(env, userId, sub.id), msgId);
      } else if (act === 'ph' || act === 'lp' || act === 'en') {
        const col = { ph: 'photo', lp: 'preview', en: 'enabled' }[act];
        const on = (act === 'lp' || act === 'en') ? sub[col] !== 0 : !!sub[col];
        await db(env, `UPDATE subs SET ${col}=? WHERE id=?`, on ? 0 : 1, sub.id).run();
        await show(env, userId, await subScreen(env, userId, sub.id), msgId);
      } else if (act === 'r') {
        await db(env, 'UPDATE subs SET template=?, offline_tpl=NULL WHERE id=?', DEFAULT_TPL, sub.id).run();
        await show(env, userId, await subScreen(env, userId, sub.id, '↩️ Messages reset to default.'), msgId);
      } else if (act === 'p' || act === 't') {
        const r = await sendSample(env, userId, sub, act === 'p' ? 'preview' : 'test');
        toast = r.ok ? (act === 'p' ? 'Preview sent below' : 'Test sent to the chat') : 'Failed: ' + (r.description || '').slice(0, 150);
      } else if (act === 'd') {
        await removeSub(env, sub);
        await show(env, userId, await chatScreen(env, userId, sub.chat_id, `🗑 Removed <b>${esc(sub.slug)}</b>.`), msgId);
      }
    }
  } finally {
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: toast || undefined, show_alert: toast.startsWith('Failed') });
  }
}

/* ---------------- Shared actions (chat + app) ---------------- */

// Add a Kick streamer to one of the user's chats.
// Returns { subId, slug } or { error } (gone: true when the chat can't be managed anymore).
async function addStreamer(env, userId, chatId, input) {
  if (!(await canManage(env, userId, chatId))) return { error: "You can't manage that chat anymore.", gone: true };
  const slug = parseSlug(String(input || ''));
  if (!slug) return { error: 'That doesn\'t look like a Kick username. Send something like <code>xqc</code> or <code>https://kick.com/xqc</code>.' };
  let ch;
  try { ch = (await kickChannels(env, [slug]))[slug]; }
  catch (e) { return { error: 'Kick API error: ' + esc(e.message) + '. Try again in a minute.' }; }
  if (!ch) return { error: `Couldn't find <b>kick.com/${esc(slug)}</b>. Check the spelling.` };
  await db(env, 'INSERT OR IGNORE INTO subs (chat_id,slug,template,photo) VALUES (?,?,?,0)', chatId, slug, DEFAULT_TPL).run();
  await db(env, 'INSERT OR IGNORE INTO streamers (slug,is_live,last_notified) VALUES (?,?,0)', slug, ch.stream && ch.stream.is_live ? 1 : 0).run();
  const sub = await db(env, 'SELECT id FROM subs WHERE chat_id=? AND slug=?', chatId, slug).first();
  return { subId: sub.id, slug };
}

// Send the alert as a preview to the user ('preview') or into the chat ('test')
async function sendSample(env, userId, sub, mode) {
  let vars = sampleVars(sub.slug);
  try {
    const ch = (await kickChannels(env, [sub.slug]))[sub.slug];
    if (ch && ch.stream && ch.stream.is_live) vars = varsFrom(ch, sub.slug);
  } catch (_) { /* fall back to sample values */ }
  const r = await sendAlert(env, mode === 'preview' ? userId : sub.chat_id, sub, vars);
  if (r.ok && mode === 'preview' && sub.offline_edit) {
    // also show what it turns into when the stream ends
    await sendAlert(env, userId, { ...sub, template: (sub.offline_edit === 2 ? '<i>When the stream ends, it posts:</i>\n\n' : '<i>When the stream ends, the alert changes to:</i>\n\n') + (sub.offline_tpl || DEFAULT_OFFLINE_TPL), photo: 0 },
      { ...vars, duration: '2h 15m', viewers: '' });
  }
  return r;
}

async function removeSub(env, sub) {
  await db(env, 'DELETE FROM subs WHERE id=?', sub.id).run();
  await cleanupStreamers(env);
}

// Check a template by sending it to the user and deleting it straight away.
// Returns null if Telegram accepts it, otherwise Telegram's error.
async function checkTemplate(env, userId, sub, tpl) {
  const r = await tg(env, 'sendMessage', {
    chat_id: userId, text: render(tpl, sampleVars(sub.slug)), parse_mode: 'HTML',
    disable_notification: true, link_preview_options: { is_disabled: true },
  });
  if (!r.ok) return r.description || 'Telegram rejected the message';
  await tg(env, 'deleteMessage', { chat_id: userId, message_id: r.result.message_id });
  return null;
}

/* ---------------- Permissions ---------------- */

async function canManage(env, userId, chatOrId) {
  if (!(await isAllowed(env, userId))) return false;
  const chat = typeof chatOrId === 'object' ? chatOrId : await db(env, 'SELECT * FROM chats WHERE chat_id=?', chatOrId).first();
  // each person only ever sees and manages the chats they added themselves
  return !!chat && chat.added_by === userId;
}

async function getSub(env, id) {
  return db(env, 'SELECT subs.*, chats.title AS chat_title, chats.is_forum AS chat_is_forum FROM subs JOIN chats ON chats.chat_id = subs.chat_id WHERE subs.id=?', id).first();
}

/* ---------------- Screens ---------------- */

async function show(env, userId, screen, editMsgId) {
  const body = {
    chat_id: userId,
    text: screen.text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: screen.kb || [] },
    link_preview_options: { is_disabled: true },
  };
  if (editMsgId) {
    const r = await tg(env, 'editMessageText', { ...body, message_id: editMsgId });
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }
  await tg(env, 'sendMessage', body);
}

// Inline button that opens the Mini App (null until /setup has run)
async function appButton(env) {
  const url = await kvGet(env, 'app_url');
  return url ? { text: '📱 Open app', web_app: { url } } : null;
}

function reply(env, userId, text) {
  return tg(env, 'sendMessage', { chat_id: userId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

// Telegram's "add bot" links. pin=true also asks for pin rights (and edit rights in channels).
function addLinks(bot, pin) {
  return {
    group: `https://t.me/${bot}?startgroup=true` + (pin ? '&admin=pin_messages' : ''),
    channel: `https://t.me/${bot}?startchannel=true&admin=post_messages` + (pin ? '+edit_messages+pin_messages' : ''),
  };
}

async function addScreen(env, pin) {
  const bot = await kvGet(env, 'bot_username');
  const l = addLinks(bot, pin);
  return {
    text: (pin ? '📌 <b>Add with pin permissions</b>\nI\'ll ask to be an admin that can pin alerts.' : '➕ <b>Add me</b>') +
      '\n\nWhere do you want me?',
    kb: [
      [{ text: '👥 Group', url: l.group }, { text: '📢 Channel', url: l.channel }],
      [{ text: '« Back', callback_data: 'm' }],
    ],
  };
}

async function mainScreen(env, userId) {
  const { results } = await db(env, 'SELECT * FROM chats').all();
  const mine = (await Promise.all(results.map(async (c) => ((await canManage(env, userId, c)) ? c : null)))).filter(Boolean);
  const bot = await kvGet(env, 'bot_username');
  const addRow = bot ? [
    [{ text: '➕ Add to group/channel', callback_data: 'ad:0' }],
    [{ text: '📌 Add to group/channel with pin permissions', callback_data: 'ad:1' }],
  ] : [];
  if (userId === (await ownerId(env))) addRow.push([{ text: '👑 Access', callback_data: 'acc' }]);
  const app = await appButton(env);
  if (app) addRow.unshift([app]);

  if (!mine.length) {
    return {
      text: '👋 I post a message in your Telegram group or channel whenever a Kick streamer goes live.\n\n1. Add me to your group (or to your channel as admin).\n2. Come back here and tap Refresh.',
      kb: [...addRow, [{ text: '🔄 Refresh', callback_data: 'm' }]],
    };
  }
  const counts = await db(env, 'SELECT chat_id, COUNT(*) AS n FROM subs GROUP BY chat_id').all();
  const n = Object.fromEntries(counts.results.map((r) => [r.chat_id, r.n]));
  return {
    text: '<b>Your chats</b>\nPick one to manage its Kick alerts:',
    kb: [
      ...mine.map((c) => [{ text: `${c.title} (${n[c.chat_id] || 0})`, callback_data: 'c:' + c.chat_id }]),
      ...addRow,
    ],
  };
}

async function chatScreen(env, userId, chatId, note = '') {
  const chat = await db(env, 'SELECT * FROM chats WHERE chat_id=?', chatId).first();
  if (!chat || !(await canManage(env, userId, chat))) {
    return { text: "That chat isn't in your list.", kb: [[{ text: '« Back', callback_data: 'm' }]] };
  }
  const { results: subs } = await db(env,
    'SELECT subs.id, subs.slug, subs.enabled, streamers.is_live FROM subs LEFT JOIN streamers ON streamers.slug = subs.slug WHERE chat_id=? ORDER BY subs.slug', chatId).all();
  return {
    text: (note ? note + '\n\n' : '') + `<b>${esc(chat.title)}</b>\n` +
      (subs.length ? 'Streamers I announce here (🔴 = live now):' : 'No streamers yet. Add one below.'),
    kb: [
      ...subs.map((s) => [{ text: (s.is_live ? '🔴 ' : '⚪ ') + s.slug + (s.enabled === 0 ? '  🔕 paused' : ''), callback_data: 's:' + s.id }]),
      [{ text: '➕ Add streamer', callback_data: 'a:' + chatId }],
      [{ text: '« Back', callback_data: 'm' }],
    ],
  };
}

async function topicScreen(env, sub) {
  const topics = await listTopics(env, sub.chat_id);
  const mark = (id) => ((sub.thread_id || 0) === id ? '✅ ' : '');
  return {
    text: `<b>Which topic should ${esc(sub.slug)} alerts go to?</b>\n\n` +
      `Don't see a topic? Open it in <b>${esc(sub.chat_title)}</b> and send <code>${esc(await hereCommand(env))}</code> there once. ` +
      'New topics show up here by themselves.',
    kb: [
      [{ text: mark(0) + '# General', callback_data: `ts:${sub.id}_0` }],
      ...topics.map((t) => [{ text: mark(t.id) + '# ' + t.name, callback_data: `ts:${sub.id}_${t.id}` }]),
      [{ text: '🔄 Refresh', callback_data: 'tp:' + sub.id }],
      [{ text: '« Back', callback_data: 's:' + sub.id }],
    ],
  };
}

async function subScreen(env, userId, subId, note = '') {
  const sub = await getSub(env, subId);
  if (!sub || !(await canManage(env, userId, sub.chat_id))) {
    return { text: 'That alert no longer exists.', kb: [[{ text: '« Back', callback_data: 'm' }]] };
  }
  const enabled = sub.enabled !== 0;
  const preview = sub.preview !== 0;
  const onOff = (v) => (v ? 'on' : 'off');
  const sample = { ...sampleVars(sub.slug), viewers: '' };
  const pinWarn = sub.pin ? await pinProblem(env, sub.chat_id) : null;
  const forum = sub.chat_id < 0 && (await refreshForum(env, sub.chat_id)) === 1;
  const topic = forum ? await topicName(env, sub.chat_id, sub.thread_id) : null;
  return {
    text: (note ? note + '\n\n' : '') +
      `<b>kick.com/${esc(sub.slug)}</b> → ${esc(sub.chat_title)}${topic ? ' › ' + esc(topic) : ''}\n` +
      (enabled ? '🔔 Alerts are <b>on</b>' : '🔕 Alerts are <b>paused</b>. Nothing is posted until you turn them back on.') + '\n\n' +
      `<i>Alert message (example values):</i>\n${render(sub.template, sampleVars(sub.slug))}\n\n` +
      (sub.offline_edit
        ? `<i>When the stream ends, ${sub.offline_edit === 2 ? 'it posts' : 'the alert changes to'}:</i>\n${render(sub.offline_tpl || DEFAULT_OFFLINE_TPL, sample)}\n\n`
        : '') +
      `Thumbnail photo: ${onOff(sub.photo)} · Link preview: ${onOff(preview)} · When stream ends: ${OFFLINE_MODES[sub.offline_edit || 0]} · Pin: ${PIN_MODES[sub.pin || 0]}` +
      (pinWarn ? `\n\n⚠️ ${pinWarn} Make me an admin there with that right, or remove me and re-add me with 📌 Add to group/channel with pin permissions in /start.` : ''),
    kb: [
      [{ text: enabled ? '🔕 Pause alerts' : '🔔 Resume alerts', callback_data: 'en:' + sub.id }],
      [{ text: '✏️ Edit message', callback_data: 'e:' + sub.id }],
      ...(forum ? [[{ text: `💬 Topic: ${topic}`, callback_data: 'tp:' + sub.id }]] : []),
      [{ text: `🖼 Thumbnail: ${onOff(sub.photo)}`, callback_data: 'ph:' + sub.id }, { text: `🔗 Link preview: ${onOff(preview)}`, callback_data: 'lp:' + sub.id }],
      [{ text: `📌 Pin alert: ${PIN_MODES[sub.pin || 0]}`, callback_data: 'pn:' + sub.id }],
      [{ text: `⏹ When stream ends: ${OFFLINE_MODES[sub.offline_edit || 0]}`, callback_data: 'oe:' + sub.id }],
      ...(sub.offline_edit ? [[{ text: '✏️ Edit "stream ended" message', callback_data: 'eo:' + sub.id }]] : []),
      [{ text: '👁 Preview here', callback_data: 'p:' + sub.id }, { text: '📣 Test in chat', callback_data: 't:' + sub.id }],
      [{ text: '↩️ Default messages', callback_data: 'r:' + sub.id }, { text: '🗑 Remove', callback_data: 'd:' + sub.id }],
      [{ text: '« Back', callback_data: 'c:' + sub.chat_id }],
    ],
  };
}

/* ---------------- Mini App API ---------------- */

const enc = new TextEncoder();
const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// Check that initData really comes from Telegram for this bot. Returns the user or null.
async function verifyInitData(env, initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(env.BOT_TOKEN));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = toHex(await crypto.subtle.sign('HMAC', k2, enc.encode(check)));
  if (sig.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null; // older than a day
  try { return JSON.parse(p.get('user')); } catch (_) { return null; }
}

const SUB_FIELDS = { enabled: [0, 1], photo: [0, 1], preview: [0, 1], pin: [0, 1, 2], offline_edit: [0, 1, 2] };

async function handleApi(req, env) {
  await ensureSchema(env);
  const json = (data, status = 200) => Response.json(data, { status });
  let body;
  try { body = await req.json(); } catch (_) { return json({ error: 'Bad request' }, 400); }
  const user = await verifyInitData(env, body.initData);
  if (!user || !user.id) return json({ error: 'auth' }, 401);

  const uid = user.id;
  const a = body.action;
  const owner = await ownerId(env);
  const isOwner = uid === owner;
  const allowed = await isAllowed(env, uid);
  if (isOwner && user.username && user.username !== (await kvGet(env, 'owner_username'))) {
    await kvSet(env, 'owner_username', user.username);
  }

  if (a === 'me') {
    return json({ allowed, isOwner, ownerUsername: await kvGet(env, 'owner_username'), hasOwner: !!owner });
  }

  // people without access can only unlock or ask
  if (!allowed) {
    if (a === 'redeem') return json({ result: await redeemCode(env, user, body.code) });
    if (a === 'request') return json({ message: await requestAccess(env, user) });
    return json({ error: 'locked' }, 403);
  }

  const mySub = async () => {
    const sub = await getSub(env, Number(body.id));
    return sub && (await canManage(env, uid, sub.chat_id)) ? sub : null;
  };

  switch (a) {
    case 'home': {
      const { results: chats } = await db(env,
        'SELECT chats.chat_id, chats.title, COUNT(subs.id) AS n, SUM(CASE WHEN streamers.is_live=1 THEN 1 ELSE 0 END) AS live ' +
        'FROM chats LEFT JOIN subs ON subs.chat_id = chats.chat_id LEFT JOIN streamers ON streamers.slug = subs.slug ' +
        'WHERE chats.added_by=? GROUP BY chats.chat_id ORDER BY chats.title', uid).all();
      return json({ chats, bot: await kvGet(env, 'bot_username'), isOwner });
    }

    case 'chat': {
      const chat = await db(env, 'SELECT * FROM chats WHERE chat_id=?', Number(body.chatId)).first();
      if (!chat || !(await canManage(env, uid, chat))) return json({ error: "That chat isn't in your list." }, 404);
      const { results: subs } = await db(env,
        'SELECT subs.id, subs.slug, subs.enabled, subs.pin, streamers.is_live, ' +
        "CASE WHEN chats.is_forum=1 THEN COALESCE(topics.name, CASE WHEN subs.thread_id IS NULL THEN 'General' ELSE 'Topic #' || subs.thread_id END) END AS topic " +
        'FROM subs JOIN chats ON chats.chat_id = subs.chat_id LEFT JOIN streamers ON streamers.slug = subs.slug ' +
        'LEFT JOIN topics ON topics.chat_id = subs.chat_id AND topics.thread_id = subs.thread_id ' +
        'WHERE subs.chat_id=? ORDER BY subs.slug', chat.chat_id).all();
      return json({ chat: { id: chat.chat_id, title: chat.title }, subs });
    }

    case 'addStreamer': {
      const r = await addStreamer(env, uid, Number(body.chatId), body.input);
      return r.error ? json({ error: r.error.replace(/<[^>]+>/g, '') }, 400) : json(r);
    }

    case 'sub': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      const st = await db(env, 'SELECT is_live FROM streamers WHERE slug=?', sub.slug).first();
      const forum = sub.chat_id < 0 && (await refreshForum(env, sub.chat_id)) === 1;
      return json({
        topics: forum ? { current: sub.thread_id || 0, list: await listTopics(env, sub.chat_id), here: await hereCommand(env) } : null,
        sub: {
          id: sub.id, slug: sub.slug, chatId: sub.chat_id, chatTitle: sub.chat_title,
          enabled: sub.enabled !== 0 ? 1 : 0, photo: sub.photo ? 1 : 0, preview: sub.preview !== 0 ? 1 : 0,
          pin: sub.pin || 0, offline_edit: sub.offline_edit || 0,
          template: sub.template, offline_tpl: sub.offline_tpl || DEFAULT_OFFLINE_TPL,
          isLive: !!(st && st.is_live),
        },
        pinWarn: sub.pin ? await pinProblem(env, sub.chat_id) : null,
      });
    }

    case 'setSub': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      const ok = SUB_FIELDS[body.field];
      const v = Number(body.value);
      if (!ok || !ok.includes(v)) return json({ error: 'Bad setting' }, 400);
      await db(env, `UPDATE subs SET ${body.field}=? WHERE id=?`, v, sub.id).run();
      return json({ ok: true, pinWarn: body.field === 'pin' && v ? await pinProblem(env, sub.chat_id) : null });
    }

    case 'saveTemplate': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      const tpl = String(body.text || '').replace(/\r\n/g, '\n').trim();
      if (!tpl) return json({ error: 'The message is empty.' }, 400);
      if (tpl.length > 3500) return json({ error: 'That message is too long (max 3500 characters).' }, 400);
      const problem = await checkTemplate(env, uid, sub, tpl);
      if (problem) return json({ error: 'Telegram rejected that message: ' + problem }, 400);
      await db(env, `UPDATE subs SET ${body.which === 'offline' ? 'offline_tpl' : 'template'}=? WHERE id=?`, tpl, sub.id).run();
      return json({ ok: true });
    }

    case 'reset': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      await db(env, 'UPDATE subs SET template=?, offline_tpl=NULL WHERE id=?', DEFAULT_TPL, sub.id).run();
      return json({ ok: true });
    }

    case 'preview':
    case 'test': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      const r = await sendSample(env, uid, sub, a);
      return r.ok ? json({ ok: true }) : json({ error: 'Failed: ' + (r.description || 'unknown error') }, 400);
    }

    case 'setTopic': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      const tid = Number(body.threadId) || 0;
      if (tid && !(await db(env, 'SELECT 1 AS x FROM topics WHERE chat_id=? AND thread_id=?', sub.chat_id, tid).first())) {
        return json({ error: 'Unknown topic' }, 400);
      }
      await db(env, 'UPDATE subs SET thread_id=? WHERE id=?', tid || null, sub.id).run();
      return json({ ok: true, name: await topicName(env, sub.chat_id, tid) });
    }

    case 'removeSub': {
      const sub = await mySub();
      if (!sub) return json({ error: 'That alert no longer exists.' }, 404);
      await removeSub(env, sub);
      return json({ ok: true });
    }

    case 'status':
      return json({ html: await statusText(env, uid) });
  }

  // owner only from here
  if (!isOwner) return json({ error: 'Owner only' }, 403);
  switch (a) {
    case 'access': {
      const { results: users } = await db(env, 'SELECT user_id, name, added_at FROM users ORDER BY added_at').all();
      const { results: codes } = await db(env, 'SELECT code, created_at FROM codes WHERE used_by IS NULL ORDER BY created_at').all();
      const { results: reqRows } = await db(env, "SELECT k, v FROM kv WHERE k LIKE 'req:%'").all();
      const requests = reqRows.map((r) => ({ userId: Number(r.k.slice(4)), ...JSON.parse(r.v) }));
      const { results: chatCounts } = await db(env, 'SELECT added_by, COUNT(*) AS n FROM chats GROUP BY added_by').all();
      const n = Object.fromEntries(chatCounts.map((r) => [r.added_by, r.n]));
      return json({
        users: users.map((u) => ({ ...u, chats: n[u.user_id] || 0 })),
        codes, requests, bot: await kvGet(env, 'bot_username'),
      });
    }
    case 'newCode':
      return json({ code: await createCode(env), bot: await kvGet(env, 'bot_username') });
    case 'deleteCode':
      await db(env, 'DELETE FROM codes WHERE code=? AND used_by IS NULL', String(body.code || '')).run();
      return json({ ok: true });
    case 'removeUser':
      return json({ name: await removeUser(env, Number(body.userId)) });
    case 'decide':
      return json({ name: await decideRequest(env, Number(body.userId), !!body.ok) });
  }
  return json({ error: 'Unknown action' }, 400);
}

// APP_HTML_START (generated from src/app.html by scripts/build-app.mjs)
const APP_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Kick Live Alerts</title>\n<script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n<style>\n  :root {\n    --page: var(--tg-theme-secondary-bg-color, #0e1013);\n    --card: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, #181b20));\n    --text: var(--tg-theme-text-color, #eef0f2);\n    --hint: var(--tg-theme-hint-color, #8a919b);\n    --link: var(--tg-theme-link-color, #5fb4f5);\n    --head: var(--tg-theme-section-header-text-color, var(--hint));\n    --danger: var(--tg-theme-destructive-text-color, #ff5c5c);\n    --sep: rgba(127, 127, 127, .16);\n    --accent: #53fc18;\n    --accent-ink: #08130a;\n    --live: #ff3b4e;\n    --radius: 14px;\n  }\n  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }\n  html, body { margin: 0; background: var(--page); color: var(--text); }\n  body {\n    font: 15px/1.4 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, system-ui, sans-serif;\n    padding: 12px 16px calc(28px + env(safe-area-inset-bottom));\n    min-height: 100vh;\n  }\n  button, input, textarea { font: inherit; color: inherit; }\n  h1 { font-size: 22px; line-height: 1.2; margin: 6px 0 2px; letter-spacing: -.01em; }\n  .sub { color: var(--hint); font-size: 13.5px; margin: 0 0 16px; }\n  .section { color: var(--head); font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 22px 4px 8px; }\n  .card { background: var(--card); border-radius: var(--radius); overflow: hidden; }\n  .card + .card { margin-top: 10px; }\n  .row {\n    display: flex; align-items: center; gap: 12px; width: 100%; min-height: 50px; padding: 10px 14px;\n    background: none; border: 0; text-align: left; position: relative;\n  }\n  .row + .row::before { content: \"\"; position: absolute; top: 0; left: 14px; right: 0; border-top: 1px solid var(--sep); }\n  button.row { cursor: pointer; }\n  button.row:active { background: var(--sep); }\n  .row .grow { flex: 1; min-width: 0; }\n  .row .title { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n  .row .meta { color: var(--hint); font-size: 13px; }\n  .chev { color: var(--hint); font-size: 18px; line-height: 1; }\n  .icon { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; flex: none; font-size: 16px; background: var(--sep); }\n  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--hint); opacity: .5; flex: none; }\n  .dot.live { background: var(--live); opacity: 1; box-shadow: 0 0 0 4px rgba(255, 59, 78, .18); }\n  .tag { font-size: 11.5px; padding: 2px 7px; border-radius: 99px; background: var(--sep); color: var(--hint); white-space: nowrap; }\n  .tag.live { background: rgba(255, 59, 78, .16); color: var(--live); font-weight: 600; }\n  .tag.green { background: rgba(83, 252, 24, .16); color: #3cc80c; font-weight: 600; }\n\n  .btn {\n    display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 46px; padding: 10px 16px;\n    border: 0; border-radius: 12px; font-weight: 600; cursor: pointer; background: var(--card); color: var(--link);\n  }\n  .btn.primary { background: var(--accent); color: var(--accent-ink); }\n  .btn.danger { color: var(--danger); }\n  .btn:disabled { opacity: .5; }\n  .btn + .btn, .btns + .btn, .btn + .btns { margin-top: 10px; }\n  .btns { display: flex; gap: 10px; }\n  .btns .btn { margin: 0; }\n\n  .field { display: flex; gap: 8px; padding: 10px; }\n  input.text, textarea.text {\n    width: 100%; border: 1px solid var(--sep); background: var(--page); border-radius: 10px; padding: 11px 12px; outline: none;\n  }\n  input.text:focus, textarea.text:focus { border-color: var(--accent); }\n  textarea.text { min-height: 150px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px; line-height: 1.5; }\n  .field .btn { width: auto; flex: none; min-height: 44px; }\n\n  /* switch */\n  .switch { position: relative; width: 46px; height: 28px; flex: none; }\n  .switch input { opacity: 0; position: absolute; inset: 0; margin: 0; cursor: pointer; z-index: 1; }\n  .switch span { position: absolute; inset: 0; border-radius: 99px; background: var(--sep); transition: background .15s; }\n  .switch span::after { content: \"\"; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .15s; }\n  .switch input:checked + span { background: var(--accent); }\n  .switch input:checked + span::after { transform: translateX(18px); }\n\n  /* segmented */\n  .seg { display: flex; background: var(--page); border-radius: 10px; padding: 3px; gap: 3px; margin: 0 14px 12px; }\n  .seg button { flex: 1; border: 0; background: none; padding: 8px 4px; border-radius: 8px; font-size: 13px; font-weight: 550; color: var(--hint); cursor: pointer; }\n  .seg button.on { background: var(--card); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,.18); }\n  .seglabel { padding: 12px 14px 8px; font-weight: 550; }\n  .seglabel .meta { font-weight: 400; color: var(--hint); font-size: 13px; }\n\n  .msg {\n    margin: 0 14px 12px; padding: 10px 12px; border-radius: 12px 12px 12px 4px; background: var(--page);\n    white-space: pre-wrap; word-wrap: break-word; font-size: 14.5px;\n  }\n  .msg a { color: var(--link); }\n  .msg code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }\n  .msg tg-spoiler, .msg .tg-spoiler { background: var(--hint); color: transparent; border-radius: 3px; }\n  .msglabel { padding: 12px 14px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n  .msglabel b { font-weight: 550; }\n  .linkbtn { border: 0; background: none; color: var(--link); font-weight: 600; cursor: pointer; padding: 4px 0; }\n\n  .warn { margin: 10px 0 0; padding: 11px 13px; border-radius: 12px; background: rgba(255, 176, 32, .13); color: #e0a020; font-size: 13.5px; }\n  .note { padding: 12px 14px; color: var(--hint); font-size: 13.5px; }\n  .note code { font-family: ui-monospace, Menlo, monospace; color: var(--text); }\n  .err { color: var(--danger); font-size: 13.5px; padding: 0 14px 12px; }\n\n  .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 10px 4px; }\n  .chip { border: 1px solid var(--sep); background: none; border-radius: 99px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; color: var(--link); font-family: ui-monospace, Menlo, monospace; }\n  .tools { display: flex; gap: 6px; padding: 10px 10px 0; }\n  .tool { border: 0; background: var(--page); border-radius: 8px; min-width: 38px; height: 34px; cursor: pointer; font-size: 14px; }\n\n  .hero { text-align: center; padding: 28px 8px 8px; }\n  .hero .badge { width: 72px; height: 72px; margin: 0 auto 14px; border-radius: 22px; background: #000; display: grid; place-items: center; }\n  .hero h1 { margin-bottom: 6px; }\n  .hero p { color: var(--hint); margin: 0 auto 22px; max-width: 320px; }\n\n  .code { font: 600 22px/1.2 ui-monospace, Menlo, monospace; letter-spacing: .08em; text-align: center; padding: 16px 14px 6px; user-select: all; }\n  .codelink { text-align: center; color: var(--hint); font-size: 12.5px; padding: 0 14px 14px; word-break: break-all; user-select: all; }\n\n  .status { padding: 14px; white-space: pre-wrap; font-size: 14px; }\n  .skeleton { height: 50px; border-radius: var(--radius); background: var(--card); opacity: .6; margin-top: 10px; animation: pulse 1.2s ease-in-out infinite; }\n  @keyframes pulse { 50% { opacity: .3; } }\n  .center { text-align: center; color: var(--hint); padding: 40px 10px; }\n\n  #toast {\n    position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translate(-50%, 20px); opacity: 0;\n    background: rgba(20, 22, 26, .94); color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 14px; max-width: calc(100% - 32px);\n    transition: opacity .2s, transform .2s; pointer-events: none; z-index: 10; text-align: center;\n  }\n  #toast.show { opacity: 1; transform: translate(-50%, 0); }\n</style>\n</head>\n<body>\n<div id=\"app\"></div>\n<div id=\"toast\"></div>\n<script>\n(function () {\n  'use strict';\n  var TG = window.Telegram && window.Telegram.WebApp;\n  var initData = TG ? TG.initData : '';\n  var app = document.getElementById('app');\n  var stack = [];\n  var token = 0;\n\n  if (TG) {\n    TG.ready();\n    TG.expand();\n    try { TG.setHeaderColor('secondary_bg_color'); TG.setBackgroundColor('secondary_bg_color'); } catch (e) {}\n    TG.BackButton.onClick(function () { back(); });\n  }\n\n  var BANANA = \"<svg viewBox=\\\"0 0 17 15\\\" width=\\\"46\\\" height=\\\"40\\\" shape-rendering=\\\"crispEdges\\\" fill=\\\"#53fc18\\\"><rect x=\\\"13\\\" y=\\\"0\\\" width=\\\"1\\\" height=\\\"1\\\"/><rect x=\\\"13\\\" y=\\\"1\\\" width=\\\"2\\\" height=\\\"1\\\"/><rect x=\\\"12\\\" y=\\\"2\\\" width=\\\"3\\\" height=\\\"1\\\"/><rect x=\\\"12\\\" y=\\\"3\\\" width=\\\"4\\\" height=\\\"1\\\"/><rect x=\\\"12\\\" y=\\\"4\\\" width=\\\"4\\\" height=\\\"1\\\"/><rect x=\\\"11\\\" y=\\\"5\\\" width=\\\"5\\\" height=\\\"1\\\"/><rect x=\\\"11\\\" y=\\\"6\\\" width=\\\"5\\\" height=\\\"1\\\"/><rect x=\\\"10\\\" y=\\\"7\\\" width=\\\"5\\\" height=\\\"1\\\"/><rect x=\\\"9\\\" y=\\\"8\\\" width=\\\"6\\\" height=\\\"1\\\"/><rect x=\\\"8\\\" y=\\\"9\\\" width=\\\"6\\\" height=\\\"1\\\"/><rect x=\\\"6\\\" y=\\\"10\\\" width=\\\"7\\\" height=\\\"1\\\"/><rect x=\\\"4\\\" y=\\\"11\\\" width=\\\"8\\\" height=\\\"1\\\"/><rect x=\\\"1\\\" y=\\\"12\\\" width=\\\"9\\\" height=\\\"1\\\"/><rect x=\\\"0\\\" y=\\\"13\\\" width=\\\"7\\\" height=\\\"1\\\"/><rect x=\\\"1\\\" y=\\\"14\\\" width=\\\"3\\\" height=\\\"1\\\"/></svg>\";\n\n  /* ---------- helpers ---------- */\n  function h(tag, attrs) {\n    var el = document.createElement(tag);\n    if (attrs) for (var k in attrs) {\n      var v = attrs[k];\n      if (v == null || v === false) continue;\n      if (k === 'class') el.className = v;\n      else if (k === 'text') el.textContent = v;\n      else if (k === 'html') el.innerHTML = v;\n      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);\n      else el.setAttribute(k, v === true ? '' : v);\n    }\n    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);\n    return el;\n  }\n  function add(el, c) {\n    if (c == null || c === false) return;\n    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }\n    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);\n  }\n  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;'); }\n\n  var toastTimer;\n  function toast(msg) {\n    var t = document.getElementById('toast');\n    t.textContent = msg; t.classList.add('show');\n    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);\n  }\n  function haptic(kind) {\n    try {\n      if (kind === 'ok') TG.HapticFeedback.notificationOccurred('success');\n      else if (kind === 'err') TG.HapticFeedback.notificationOccurred('error');\n      else TG.HapticFeedback.selectionChanged();\n    } catch (e) {}\n  }\n  function alertBox(msg) {\n    return new Promise(function (res) {\n      if (TG && TG.showAlert) { try { TG.showAlert(msg, res); return; } catch (e) {} }\n      window.alert(msg); res();\n    });\n  }\n  function confirmBox(msg) {\n    return new Promise(function (res) {\n      if (TG && TG.showConfirm) { try { TG.showConfirm(msg, res); return; } catch (e) {} }\n      res(window.confirm(msg));\n    });\n  }\n  // ask Group or Channel, then open Telegram's add-bot screen\n  function addMe(bot, pin) {\n    var links = {\n      group: 'https://t.me/' + bot + '?startgroup=true' + (pin ? '&admin=pin_messages' : ''),\n      channel: 'https://t.me/' + bot + '?startchannel=true&admin=post_messages' + (pin ? '+edit_messages+pin_messages' : ''),\n    };\n    var msg = pin ? \"I'll ask to be an admin that can pin alerts. Where do you want me?\" : 'Where do you want me?';\n    if (TG && TG.showPopup) {\n      try {\n        TG.showPopup({\n          title: pin ? 'Add with pin permissions' : 'Add me',\n          message: msg,\n          buttons: [{ id: 'group', type: 'default', text: 'Group' }, { id: 'channel', type: 'default', text: 'Channel' }, { type: 'cancel' }],\n        }, function (id) { if (links[id]) openTg(links[id]); });\n        return;\n      } catch (e) {}\n    }\n    openTg(window.confirm(msg + '\\n\\nOK = Group, Cancel = Channel') ? links.group : links.channel);\n  }\n  function openTg(url) { if (TG && TG.openTelegramLink) TG.openTelegramLink(url); else window.open(url, '_blank'); }\n  function openUrl(url) { if (TG && TG.openLink) TG.openLink(url); else window.open(url, '_blank'); }\n\n  function api(action, data) {\n    var body = Object.assign({ initData: initData, action: action }, data || {});\n    return fetch('api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })\n      .then(function (r) {\n        return r.json().catch(function () { return { error: 'Bad response from the bot.' }; }).then(function (j) {\n          if (r.status === 401) throw new Error('Your session expired. Close the app and open it again.');\n          if (j.error === 'locked') { stack = [{ name: 'locked' }]; render(); throw new Error('locked'); }\n          if (j.error) throw new Error(j.error);\n          return j;\n        });\n      });\n  }\n  // run an action with a busy button; shows errors\n  function act(btn, fn) {\n    if (btn) btn.disabled = true;\n    return Promise.resolve().then(fn).catch(function (e) {\n      if (e.message !== 'locked') { haptic('err'); alertBox(e.message); }\n    }).then(function () { if (btn) btn.disabled = false; });\n  }\n\n  /* Telegram-HTML message preview (only safe tags survive) */\n  var OK_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, INS: 1, S: 1, STRIKE: 1, DEL: 1, CODE: 1, PRE: 1, A: 1, 'TG-SPOILER': 1, BLOCKQUOTE: 1, SPAN: 1, BR: 1 };\n  function cleanNode(node) {\n    Array.prototype.slice.call(node.childNodes).forEach(function (c) {\n      if (c.nodeType === 3) return;\n      if (c.nodeType !== 1 || /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH)$/.test(c.tagName)) { c.remove(); return; }\n      cleanNode(c);\n      if (!OK_TAGS[c.tagName]) { c.replaceWith.apply(c, Array.prototype.slice.call(c.childNodes)); return; }\n      var href = c.tagName === 'A' ? c.getAttribute('href') : null;\n      var cls = c.tagName === 'SPAN' && c.getAttribute('class') === 'tg-spoiler' ? 'tg-spoiler' : null;\n      Array.prototype.slice.call(c.attributes).forEach(function (at) { c.removeAttribute(at.name); });\n      if (href && /^https?:\\/\\//i.test(href)) {\n        c.setAttribute('href', href);\n        c.addEventListener('click', function (e) { e.preventDefault(); openUrl(href); });\n      }\n      if (cls) c.setAttribute('class', cls);\n    });\n  }\n  function msgView(html) {\n    var doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');\n    var root = doc.body.firstChild || doc.createElement('div');\n    cleanNode(root);\n    var box = h('div', { class: 'msg' });\n    while (root.firstChild) box.appendChild(document.adoptNode(root.firstChild));\n    box.querySelectorAll('a[href]').forEach(function (a) {\n      a.addEventListener('click', function (e) { e.preventDefault(); openUrl(a.getAttribute('href')); });\n    });\n    return box;\n  }\n  function sampleVars(slug) {\n    return { streamer: slug, title: 'Example stream title', category: 'Just Chatting', viewers: '1234', url: 'https://kick.com/' + slug, duration: '2h 15m' };\n  }\n  function renderTpl(tpl, vars) {\n    return tpl.replace(/\\{(\\w+)\\}/g, function (m, k) { return k in vars ? esc(vars[k]) : m; });\n  }\n\n  /* ---------- navigation ---------- */\n  function go(name, params) { stack.push({ name: name, params: params || {} }); render(); window.scrollTo(0, 0); }\n  function back() { if (stack.length > 1) { stack.pop(); render(); } }\n  function replaceTop(name, params) { stack[stack.length - 1] = { name: name, params: params || {} }; render(); }\n  function render() {\n    var cur = stack[stack.length - 1];\n    if (TG) { if (stack.length > 1) TG.BackButton.show(); else TG.BackButton.hide(); }\n    var my = ++token;\n    app.innerHTML = '';\n    app.appendChild(loading());\n    Promise.resolve(screens[cur.name](cur.params)).then(function (view) {\n      if (my !== token || !view) return;\n      app.innerHTML = '';\n      app.appendChild(view);\n    }).catch(function (e) {\n      if (my !== token || e.message === 'locked') return;\n      app.innerHTML = '';\n      app.appendChild(h('div', null,\n        h('div', { class: 'center', text: e.message }),\n        h('button', { class: 'btn', onclick: function () { render(); } }, 'Try again')));\n    });\n  }\n  function refresh() { render(); }\n  function loading() { return h('div', null, h('div', { class: 'skeleton', style: 'width:55%;height:26px;margin-top:6px' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })); }\n\n  function rowBtn(opts) {\n    return h('button', { class: 'row', onclick: opts.onclick },\n      opts.left,\n      h('div', { class: 'grow' }, h('div', { class: 'title', text: opts.title }), opts.meta ? h('div', { class: 'meta', text: opts.meta }) : null),\n      opts.right, h('span', { class: 'chev', text: '›' }));\n  }\n  function toggleRow(label, meta, checked, onchange) {\n    var input = h('input', { type: 'checkbox' });\n    input.checked = !!checked;\n    input.addEventListener('change', function () { haptic(); onchange(input.checked, input); });\n    return h('label', { class: 'row' },\n      h('div', { class: 'grow' }, h('div', { text: label }), meta ? h('div', { class: 'meta', text: meta }) : null),\n      h('span', { class: 'switch' }, input, h('span')));\n  }\n  function segmented(options, value, onpick) {\n    var wrap = h('div', { class: 'seg' });\n    options.forEach(function (o, i) {\n      wrap.appendChild(h('button', {\n        class: i === value ? 'on' : '', text: o,\n        onclick: function () {\n          if (i === value) return;\n          haptic();\n          wrap.querySelectorAll('button').forEach(function (b, j) { b.className = j === i ? 'on' : ''; });\n          value = i; onpick(i);\n        },\n      }));\n    });\n    return wrap;\n  }\n\n  /* ---------- screens ---------- */\n  var screens = {};\n\n  screens.outside = function () {\n    return h('div', { class: 'hero' },\n      h('div', { class: 'badge', html: BANANA }),\n      h('h1', { text: 'Kick Live Alerts' }),\n      h('p', { text: 'Open this app from the bot in Telegram.' }));\n  };\n\n  screens.boot = function () {\n    return api('me').then(function (me) {\n      window.__me = me;\n      replaceTop(me.allowed ? 'home' : 'locked');\n    });\n  };\n\n  screens.locked = function (p) {\n    return api('me').then(function (me) {\n      var input = h('input', { class: 'text', placeholder: 'Access code', autocomplete: 'off', autocapitalize: 'characters' });\n      var err = h('div', { class: 'err' });\n      function unlock(btn) {\n        err.textContent = '';\n        return act(btn, function () {\n          return api('redeem', { code: input.value }).then(function (r) {\n            if (r.result === 'invalid') { haptic('err'); err.textContent = \"That code isn't valid or was already used.\"; return; }\n            haptic('ok');\n            toast(r.result === 'owner' ? '👑 You are now the owner' : '✅ Access granted');\n            stack = [{ name: 'home' }]; render();\n          });\n        });\n      }\n      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });\n      var unlockBtn = h('button', { class: 'btn primary', onclick: function () { unlock(unlockBtn); } }, 'Unlock');\n      var reqBtn = h('button', {\n        class: 'btn',\n        onclick: function () {\n          act(reqBtn, function () { return api('request').then(function (r) { haptic('ok'); alertBox(r.message); }); });\n        },\n      }, '🙋 Request access');\n      return h('div', null,\n        h('div', { class: 'hero' },\n          h('div', { class: 'badge', html: BANANA }),\n          h('h1', { text: 'This bot is private' }),\n          h('p', { text: \"It's completely free. You just need access: enter a code from the owner, or ask for one.\" })),\n        h('div', { class: 'card' }, h('div', { class: 'field' }, input), err),\n        h('div', { style: 'height:10px' }),\n        unlockBtn,\n        h('div', { class: 'section', text: 'No code?' }),\n        reqBtn,\n        me.ownerUsername ? h('button', { class: 'btn', onclick: function () { openTg('https://t.me/' + me.ownerUsername); } }, '💬 Message the owner') : null);\n    });\n  };\n\n  screens.home = function () {\n    return api('home').then(function (d) {\n      var bot = d.bot;\n      var chats = d.chats.length\n        ? h('div', { class: 'card' }, d.chats.map(function (c) {\n            return rowBtn({\n              left: h('div', { class: 'icon', text: '💬' }),\n              title: c.title,\n              meta: c.n + (c.n === 1 ? ' streamer' : ' streamers'),\n              right: c.live ? h('span', { class: 'tag live', text: c.live + ' live' }) : null,\n              onclick: function () { go('chat', { chatId: c.chat_id }); },\n            });\n          }))\n        : h('div', { class: 'card' }, h('div', { class: 'note', text: \"You haven't added me to a group or channel yet. Add me below, then come back here.\" }));\n      var addLinks = bot ? h('div', { class: 'card' },\n        rowBtn({ left: h('div', { class: 'icon', text: '➕' }), title: 'Add to group/channel', meta: 'Posts alerts', onclick: function () { addMe(bot, false); } }),\n        rowBtn({ left: h('div', { class: 'icon', text: '📌' }), title: 'Add with pin permissions', meta: 'Group/channel · posts and pins alerts', onclick: function () { addMe(bot, true); } })) : null;\n      return h('div', null,\n        h('h1', { text: 'Kick Live Alerts' }),\n        h('p', { class: 'sub', text: 'Posts in your chats when your streamers go live.' }),\n        h('div', { class: 'section', text: 'Your chats' }), chats,\n        h('div', { class: 'section', text: 'Add me' }), addLinks,\n        h('div', { class: 'section', text: 'More' }),\n        h('div', { class: 'card' },\n          rowBtn({ left: h('div', { class: 'icon', text: '📊' }), title: 'Status', meta: 'Check that live checks are working', onclick: function () { go('status'); } }),\n          d.isOwner ? rowBtn({ left: h('div', { class: 'icon', text: '👑' }), title: 'Access', meta: 'Codes, requests and people', onclick: function () { go('access'); } }) : null));\n    });\n  };\n\n  screens.chat = function (p) {\n    return api('chat', { chatId: p.chatId }).then(function (d) {\n      var input = h('input', { class: 'text', placeholder: 'Kick name or link, e.g. xqc', autocomplete: 'off', autocapitalize: 'none' });\n      var err = h('div', { class: 'err' });\n      var addBtn = h('button', { class: 'btn primary', onclick: function () { addIt(); } }, 'Add');\n      function addIt() {\n        err.textContent = '';\n        if (!input.value.trim()) { input.focus(); return; }\n        act(addBtn, function () {\n          return api('addStreamer', { chatId: d.chat.id, input: input.value }).then(function (r) {\n            haptic('ok'); toast('✅ Now watching ' + r.slug);\n            input.value = '';\n            go('sub', { id: r.subId });\n          }).catch(function (e) { if (e.message !== 'locked') { haptic('err'); err.textContent = e.message; } });\n        });\n      }\n      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') addIt(); });\n      return h('div', null,\n        h('h1', { text: d.chat.title }),\n        h('p', { class: 'sub', text: 'Streamers I announce here' }),\n        d.subs.length ? h('div', { class: 'card' }, d.subs.map(function (s) {\n          var tags = [];\n          if (s.is_live) tags.push(h('span', { class: 'tag live', text: 'LIVE' }));\n          if (s.enabled === 0) tags.push(h('span', { class: 'tag', text: 'Paused' }));\n          if (s.pin) tags.push(h('span', { class: 'tag', text: '📌' }));\n          return rowBtn({\n            left: h('span', { class: 'dot' + (s.is_live ? ' live' : '') }),\n            title: s.slug, meta: s.topic ? '# ' + s.topic : null,\n            right: tags.length ? h('div', { style: 'display:flex;gap:6px' }, tags) : null,\n            onclick: function () { go('sub', { id: s.id }); },\n          });\n        })) : h('div', { class: 'card' }, h('div', { class: 'note', text: 'No streamers yet. Add one below.' })),\n        h('div', { class: 'section', text: 'Add streamer' }),\n        h('div', { class: 'card' }, h('div', { class: 'field' }, input, addBtn), err));\n    });\n  };\n\n  screens.sub = function (p) {\n    return api('sub', { id: p.id }).then(function (d) {\n      var s = d.sub;\n      var warnBox = h('div');\n      function showWarn(w) {\n        warnBox.innerHTML = '';\n        if (w) warnBox.appendChild(h('div', { class: 'warn', text: '⚠️ ' + w + ' Make me an admin there with that right, or remove me and re-add me with “Add to group/channel with pin permissions”.' }));\n      }\n      showWarn(d.pinWarn);\n      function set(field, value) {\n        return api('setSub', { id: s.id, field: field, value: value }).then(function (r) {\n          s[field] = value;\n          if (field === 'pin') showWarn(r.pinWarn);\n          return r;\n        }).catch(function (e) { if (e.message !== 'locked') { haptic('err'); alertBox(e.message); refresh(); } });\n      }\n      var vars = sampleVars(s.slug);\n      var offVars = Object.assign({}, vars, { viewers: '' });\n\n      // forum topic picker (only for groups with topics turned on)\n      var topicBlock = null, subLine = h('p', { class: 'sub' });\n      function topicLabel() {\n        if (!d.topics) return '';\n        if (!d.topics.current) return 'General';\n        var t = d.topics.list.filter(function (x) { return x.id === d.topics.current; })[0];\n        return t ? t.name : 'Topic #' + d.topics.current;\n      }\n      function drawSubLine() { subLine.textContent = 'kick.com/' + s.slug + ' → ' + s.chatTitle + (d.topics ? ' › ' + topicLabel() : ''); }\n      drawSubLine();\n      if (d.topics) {\n        var list = h('div', { class: 'card' });\n        var drawTopics = function () {\n          list.innerHTML = '';\n          [{ id: 0, name: 'General' }].concat(d.topics.list).forEach(function (t) {\n            var on = t.id === d.topics.current;\n            var row = h('button', { class: 'row', onclick: function () {\n              if (on) return;\n              haptic();\n              api('setTopic', { id: s.id, threadId: t.id }).then(function (r) {\n                d.topics.current = t.id; drawTopics(); drawSubLine(); toast('💬 Alerts now go to ' + r.name);\n              }).catch(function (e) { if (e.message !== 'locked') { haptic('err'); alertBox(e.message); } });\n            } },\n              h('div', { class: 'icon', text: '#' }),\n              h('div', { class: 'grow' }, h('div', { class: 'title', text: t.name })),\n              on ? h('span', { style: 'color:var(--accent);font-weight:700;font-size:18px', text: '✓' }) : null);\n            list.appendChild(row);\n          });\n        };\n        drawTopics();\n        topicBlock = [\n          h('div', { class: 'section', text: 'Post in topic' }),\n          list,\n          h('div', { class: 'note' }, 'Don’t see a topic? Open it in the group and send ',\n            h('code', { text: d.topics.here }), ' there once. New topics show up here by themselves. ',\n            h('button', { class: 'linkbtn', onclick: function () { copy(d.topics.here); } }, 'Copy command')),\n        ];\n      }\n\n      var offlineBlock = h('div');\n      function drawOffline() {\n        offlineBlock.innerHTML = '';\n        if (!s.offline_edit) return;\n        offlineBlock.appendChild(h('div', { class: 'msglabel' },\n          h('b', { text: s.offline_edit === 2 ? 'Stream-ended message' : 'Alert changes to' }),\n          h('button', { class: 'linkbtn', onclick: function () { go('editor', { id: s.id, which: 'offline', slug: s.slug, text: s.offline_tpl }); } }, 'Edit')));\n        offlineBlock.appendChild(msgView(renderTpl(s.offline_tpl, offVars)));\n      }\n      drawOffline();\n\n      var previewBtn = h('button', { class: 'btn', onclick: function () {\n        act(previewBtn, function () { return api('preview', { id: s.id }).then(function () { haptic('ok'); toast('👁 Preview sent to your chat with the bot'); }); });\n      } }, '👁 Preview');\n      var testBtn = h('button', { class: 'btn', onclick: function () {\n        confirmBox('Post a test alert in “' + s.chatTitle + '”? Everyone there will see it.').then(function (yes) {\n          if (yes) act(testBtn, function () { return api('test', { id: s.id }).then(function () { haptic('ok'); toast('📣 Test sent to ' + s.chatTitle); }); });\n        });\n      } }, '📣 Test in chat');\n      var resetBtn = h('button', { class: 'btn', onclick: function () {\n        confirmBox('Reset both messages to the default text?').then(function (yes) {\n          if (yes) act(resetBtn, function () { return api('reset', { id: s.id }).then(function () { haptic('ok'); toast('↩️ Messages reset'); refresh(); }); });\n        });\n      } }, '↩️ Default messages');\n      var removeBtn = h('button', { class: 'btn danger', onclick: function () {\n        confirmBox('Stop announcing ' + s.slug + ' in “' + s.chatTitle + '”?').then(function (yes) {\n          if (yes) act(removeBtn, function () { return api('removeSub', { id: s.id }).then(function () { haptic('ok'); toast('🗑 Removed ' + s.slug); back(); }); });\n        });\n      } }, '🗑 Remove streamer');\n\n      return h('div', null,\n        h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:6px' },\n          h('h1', { style: 'margin:0', text: s.slug }),\n          s.isLive ? h('span', { class: 'tag live', text: 'LIVE' }) : null),\n        subLine,\n\n        h('div', { class: 'card' },\n          toggleRow('Alerts', s.enabled ? 'On' : 'Paused. Nothing is posted.', s.enabled, function (on, el) {\n            set('enabled', on ? 1 : 0).then(function () { el.closest('.row').querySelector('.meta').textContent = on ? 'On' : 'Paused. Nothing is posted.'; });\n          })),\n        topicBlock,\n\n        h('div', { class: 'section', text: 'Live alert' }),\n        h('div', { class: 'card' },\n          h('div', { class: 'msglabel' }, h('b', { text: 'Message' }),\n            h('button', { class: 'linkbtn', onclick: function () { go('editor', { id: s.id, which: 'live', slug: s.slug, text: s.template }); } }, 'Edit')),\n          msgView(renderTpl(s.template, vars)),\n          toggleRow('Thumbnail photo', 'Post the stream picture with the alert', s.photo, function (on) { set('photo', on ? 1 : 0); }),\n          toggleRow('Link preview', 'Show the kick.com preview card', s.preview, function (on) { set('preview', on ? 1 : 0); })),\n\n        h('div', { class: 'section', text: 'Pin alert' }),\n        h('div', { class: 'card' },\n          h('div', { class: 'seglabel' }, h('div', { class: 'meta', text: 'Pinned alerts are unpinned 5 minutes after the stream ends.' })),\n          segmented(['Off', 'Quietly', 'Notify all'], s.pin, function (i) { set('pin', i); })),\n        warnBox,\n\n        h('div', { class: 'section', text: 'When the stream ends' }),\n        h('div', { class: 'card' },\n          h('div', { style: 'height:12px' }),\n          segmented(['Nothing', 'Edit alert', 'New message'], s.offline_edit, function (i) { set('offline_edit', i).then(function () { drawOffline(); }); }),\n          offlineBlock),\n\n        h('div', { class: 'section', text: 'Try it' }),\n        h('div', { class: 'btns' }, previewBtn, testBtn),\n        h('div', { class: 'section', text: 'Manage' }),\n        resetBtn, removeBtn);\n    });\n  };\n\n  screens.editor = function (p) {\n    var live = p.which === 'live';\n    var area = h('textarea', { class: 'text', spellcheck: 'false' });\n    area.value = p.text || '';\n    var prev = h('div');\n    var err = h('div', { class: 'err' });\n    var vars = sampleVars(p.slug);\n    if (!live) vars.viewers = '';\n    function draw() { prev.innerHTML = ''; prev.appendChild(msgView(renderTpl(area.value, vars))); }\n    area.addEventListener('input', draw);\n    draw();\n    function insert(before, after) {\n      var a = area.selectionStart, b = area.selectionEnd, v = area.value;\n      area.value = v.slice(0, a) + before + v.slice(a, b) + (after || '') + v.slice(b);\n      var pos = after ? a + before.length + (b - a) : a + before.length;\n      area.focus(); area.setSelectionRange(after ? a + before.length : pos, pos);\n      draw(); haptic();\n    }\n    function wrap(tag) { return function () { insert('<' + tag + '>', '</' + tag + '>'); }; }\n    var tools = h('div', { class: 'tools' },\n      h('button', { class: 'tool', onclick: wrap('b'), html: '<b>B</b>' }),\n      h('button', { class: 'tool', onclick: wrap('i'), html: '<i>I</i>' }),\n      h('button', { class: 'tool', onclick: wrap('u'), html: '<u>U</u>' }),\n      h('button', { class: 'tool', onclick: wrap('s'), html: '<s>S</s>' }),\n      h('button', { class: 'tool', onclick: wrap('code'), text: '</>' }),\n      h('button', { class: 'tool', onclick: function () { insert('<a href=\"https://\">', '</a>'); }, text: '🔗' }));\n    var names = live ? ['streamer', 'title', 'category', 'viewers', 'url'] : ['streamer', 'title', 'category', 'duration', 'url'];\n    var chips = h('div', { class: 'chips' }, names.map(function (n) {\n      return h('button', { class: 'chip', text: '{' + n + '}', onclick: function () { insert('{' + n + '}'); } });\n    }));\n    var saveBtn = h('button', { class: 'btn primary', onclick: function () {\n      err.textContent = '';\n      act(saveBtn, function () {\n        return api('saveTemplate', { id: p.id, which: p.which, text: area.value }).then(function () {\n          haptic('ok'); toast('✅ Message saved'); back();\n        }).catch(function (e) { if (e.message !== 'locked') { haptic('err'); err.textContent = e.message; } });\n      });\n    } }, 'Save');\n    return h('div', null,\n      h('h1', { text: live ? 'Live alert message' : 'Stream-ended message' }),\n      h('p', { class: 'sub', text: 'Select text and tap a style, or tap a placeholder to insert it.' }),\n      h('div', { class: 'card' }, tools, chips, h('div', { class: 'field' }, area), err),\n      h('div', { class: 'section', text: 'Preview (example values)' }),\n      h('div', { class: 'card' }, h('div', { style: 'height:12px' }), prev),\n      h('div', { style: 'height:16px' }),\n      saveBtn);\n  };\n\n  screens.status = function () {\n    return api('status').then(function (d) {\n      var box = msgView(d.html);\n      box.className = 'status';\n      return h('div', null,\n        h('h1', { text: 'Status' }),\n        h('p', { class: 'sub', text: 'Only your own streamers and chats are shown.' }),\n        h('div', { class: 'card' }, box),\n        h('div', { style: 'height:12px' }),\n        h('button', { class: 'btn', onclick: refresh }, '🔄 Refresh'));\n    });\n  };\n\n  screens.access = function (p) {\n    return api('access').then(function (d) {\n      var codeCard = h('div');\n      function showCode(code) {\n        var link = d.bot ? 'https://t.me/' + d.bot + '?start=' + code : '';\n        codeCard.innerHTML = '';\n        codeCard.appendChild(h('div', { class: 'card' },\n          h('div', { class: 'code', text: code }),\n          link ? h('div', { class: 'codelink', text: link }) : null));\n        codeCard.appendChild(h('div', { style: 'height:10px' }));\n        codeCard.appendChild(h('div', { class: 'btns' },\n          h('button', { class: 'btn', onclick: function () { copy(code); } }, '📋 Copy code'),\n          link ? h('button', { class: 'btn', onclick: function () {\n            openTg('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Here is your access to the Kick live alerts bot'));\n          } }, '📤 Share link') : null));\n      }\n      if (p.newCode) showCode(p.newCode);\n      var newBtn = h('button', { class: 'btn primary', onclick: function () {\n        act(newBtn, function () {\n          return api('newCode').then(function (r) { haptic('ok'); stack[stack.length - 1].params = { newCode: r.code }; render(); });\n        });\n      } }, '🔑 New access code');\n\n      var reqs = d.requests.length ? h('div', { class: 'card' }, d.requests.map(function (r) {\n        var yes = h('button', { class: 'btn primary', style: 'width:auto;min-height:36px;padding:6px 12px' }, 'Give access');\n        var no = h('button', { class: 'btn', style: 'width:auto;min-height:36px;padding:6px 12px;color:var(--hint)' }, 'Ignore');\n        yes.onclick = function () { act(yes, function () { return api('decide', { userId: r.userId, ok: true }).then(function () { haptic('ok'); toast('✅ Gave access to ' + r.name); refresh(); }); }); };\n        no.onclick = function () { act(no, function () { return api('decide', { userId: r.userId, ok: false }).then(function () { toast('Ignored ' + r.name); refresh(); }); }); };\n        return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: r.name }), h('div', { class: 'meta', text: 'Asked ' + ago(r.at) })), no, yes);\n      })) : null;\n\n      var people = d.users.length ? h('div', { class: 'card' }, d.users.map(function (u) {\n        var rm = h('button', { class: 'linkbtn', style: 'color:var(--danger)' }, 'Remove');\n        rm.onclick = function () {\n          confirmBox('Remove ' + u.name + '?' + (u.chats ? ' I will also leave the ' + u.chats + (u.chats === 1 ? ' chat' : ' chats') + ' they added.' : '')).then(function (y) {\n            if (y) act(rm, function () { return api('removeUser', { userId: u.user_id }).then(function () { haptic('ok'); toast('🗑 Removed ' + u.name); refresh(); }); });\n          });\n        };\n        return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', text: u.name }),\n          h('div', { class: 'meta', text: u.chats + (u.chats === 1 ? ' chat' : ' chats') + ' · joined ' + ago(u.added_at) })), rm);\n      })) : h('div', { class: 'card' }, h('div', { class: 'note', text: 'Nobody else has access yet.' }));\n\n      var codes = d.codes.length ? h('div', { class: 'card' }, d.codes.map(function (c) {\n        var del = h('button', { class: 'linkbtn', style: 'color:var(--danger)' }, 'Delete');\n        del.onclick = function () { act(del, function () { return api('deleteCode', { code: c.code }).then(function () { toast('Code deleted'); refresh(); }); }); };\n        var cp = h('button', { class: 'linkbtn', onclick: function () { copy(c.code); } }, 'Copy');\n        return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'title', style: 'font-family:ui-monospace,Menlo,monospace', text: c.code }),\n          h('div', { class: 'meta', text: 'Created ' + ago(c.created_at) })), cp, del);\n      })) : null;\n\n      return h('div', null,\n        h('h1', { text: 'Access' }),\n        h('p', { class: 'sub', text: 'Each code works once. You can also approve requests here.' }),\n        newBtn, h('div', { style: 'height:10px' }), codeCard,\n        reqs ? [h('div', { class: 'section', text: 'Requests' }), reqs] : null,\n        h('div', { class: 'section', text: 'People with access' }), people,\n        codes ? [h('div', { class: 'section', text: 'Unused codes' }), codes] : null);\n    });\n  };\n\n  function ago(ms) {\n    if (!ms) return '';\n    var m = Math.round((Date.now() - ms) / 60000);\n    if (m < 1) return 'just now';\n    if (m < 60) return m + ' min ago';\n    var hh = Math.round(m / 60);\n    if (hh < 24) return hh + ' h ago';\n    var d = Math.round(hh / 24);\n    return d + (d === 1 ? ' day ago' : ' days ago');\n  }\n  function copy(text) {\n    var done = function () { haptic('ok'); toast('📋 Copied'); };\n    if (navigator.clipboard && navigator.clipboard.writeText) {\n      navigator.clipboard.writeText(text).then(done, function () { fallback(); });\n    } else fallback();\n    function fallback() {\n      var t = h('textarea', { style: 'position:fixed;opacity:0' }); t.value = text; document.body.appendChild(t); t.select();\n      try { document.execCommand('copy'); done(); } catch (e) { alertBox(text); }\n      t.remove();\n    }\n  }\n\n  // refresh lists when coming back to the app (e.g. after adding the bot to a group)\n  document.addEventListener('visibilitychange', function () {\n    var cur = stack[stack.length - 1];\n    if (!document.hidden && cur && (cur.name === 'home' || cur.name === 'chat')) render();\n  });\n\n  stack = [{ name: initData ? 'boot' : 'outside' }];\n  render();\n})();\n</script>\n</body>\n</html>\n";
// APP_HTML_END
