// Heartsong server: customer app + order queue + studio dashboard + song pages.
//   Lyrics:   Claude (Anthropic Messages API)
//   Audio:    produced by your team in Suno and uploaded in the studio dashboard
//             (optional instant takes from the ElevenLabs Music API)
//   Delivery: email through Resend (optional; without it, copy the link by hand)
//   Payments: PayPal (PayPal account or card) if PayPal keys are set; otherwise Stripe if its key is set;
//             with neither, orders are free (test mode).
// Requires Node 18+. No npm packages needed.
//
//   ANTHROPIC_API_KEY=sk-ant-...  ADMIN_PASSWORD=choose-one  node server.js
//   Customer app:     http://localhost:3000
//   Studio dashboard: http://localhost:3000/studio   (user: studio, password: ADMIN_PASSWORD)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
// On Render the public address is detected automatically; set BASE_URL only for a custom domain.
const BASE_URL = (process.env.BASE_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://localhost:${PORT}`)).replace(/\/$/, "");
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY; // optional
const RESEND_KEY = process.env.RESEND_API_KEY;     // optional
const MAIL_FROM = process.env.MAIL_FROM || "Heartsong <songs@heartsong.shop>";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DELIVERY_PROMISE = process.env.DELIVERY_PROMISE || "within 24 hours";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MUSIC_MODEL = process.env.MUSIC_MODEL || "music_v2_5";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;          // sk_test_... or sk_live_...
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // whsec_...
const PRICE_CENTS = parseInt(process.env.PRICE_CENTS || "5000", 10);
const CURRENCY = (process.env.CURRENCY || "usd").toLowerCase();
const PRICE_LABEL = new Intl.NumberFormat("en-US", { style: "currency", currency: CURRENCY, minimumFractionDigits: PRICE_CENTS % 100 ? 2 : 0 }).format(PRICE_CENTS / 100);
const PAYPAL_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID; // optional
const PAYPAL_LIVE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase() === "live";
const PAYPAL_API = process.env.PAYPAL_API_BASE || (PAYPAL_LIVE ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const PROVIDER = PAYPAL_ID && PAYPAL_SECRET ? "paypal" : STRIPE_KEY ? "stripe" : null;
if (!PROVIDER) console.warn("[payments] No PayPal or Stripe keys: orders are FREE (test mode).");
else console.log(`[payments] ${PROVIDER === "paypal" ? `PayPal (${PAYPAL_LIVE ? "LIVE" : "sandbox test mode"})` : "Stripe"}`);

const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const AUDIO = path.join(DATA, "audio");
const COVERS = path.join(DATA, "covers");
const DB = path.join(DATA, "orders.json");
fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(COVERS, { recursive: true });

const page = (f) => fs.readFileSync(path.join(__dirname, f));
let orders = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : {};
function persist() {
  fs.writeFileSync(DB + ".tmp", JSON.stringify(orders, null, 1));
  fs.renameSync(DB + ".tmp", DB);
}
const newId = () => crypto.randomBytes(9).toString("base64url");

/* ---------- helpers ---------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req, limit = 200_000) => JSON.parse((await readBody(req, limit)).toString() || "{}");
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Accepts a JPEG data URL from the app (already cropped to a square and resized there). Returns a Buffer or null.
function decodeCover(dataUrl) {
  const m = String(dataUrl || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 1000 || buf.length > 3_000_000 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const m = (req.headers.authorization || "").match(/^Basic (.+)$/);
  if (!m) return false;
  const pass = Buffer.from(m[1], "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const str = (v, n) => String(v ?? "").slice(0, n);
const publicSong = (o) => ({
  id: o.id, status: o.status, title: o.song.title, name: o.details.name, from: o.details.from,
  occasion: o.details.occasion, genre: o.details.genre, lyrics: o.song.lyrics, why: o.song.why, clip: o.song.clip || "",
  dedication: o.dedication || "", paid: Boolean(o.paid), cover: o.cover ? `/cover/${o.cover}` : null, audio: o.status === "delivered" && o.chosen ? `/audio/${o.chosen}` : null,
  promise: DELIVERY_PROMISE,
});

/* ---------- engines ---------- */
async function writeLyrics(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 3000, messages: [{ role: "user", content: str(prompt, 20000) }] }),
  });
  if (!r.ok) throw new Error(`Claude error ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
async function elevenTake(o) {
  let prompt = `${o.song.style}\n\nSong title: "${o.song.title}". Sing these exact lyrics, following the section tags:\n\n${o.song.lyrics}`;
  const r = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: prompt.slice(0, 4100), music_length_ms: 150000, model_id: MUSIC_MODEL }),
  });
  if (!r.ok) throw new Error(`ElevenLabs error ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
async function emailDelivery(o) {
  const link = `${BASE_URL}/song/${o.id}`;
  if (!RESEND_KEY) { console.log(`[delivery] No RESEND_API_KEY: send this link to ${o.contact.email}: ${link}`); return { sent: false, link }; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:auto;padding:36px;background:#0a0a0a;color:#f8f5ee;border-radius:4px;border:1px solid #8a7340">
    <p style="color:#d9b45a;letter-spacing:.15em;font-size:12px;text-transform:uppercase">Your song is ready</p>
    ${o.cover ? `<img src="${BASE_URL}/cover/${o.cover}" width="408" alt="" style="display:block;width:100%;max-width:408px;border:1px solid #8a7340;border-radius:4px;margin:14px 0 18px">` : ""}
    <h1 style="font-size:30px;margin:8px 0">${esc(o.song.title)}</h1>
    <p style="color:#bdb5a6">An original song for ${esc(o.details.name)}. Press play together, or send the link to them.</p>
    <a href="${link}" style="display:inline-block;margin-top:18px;background:#d9b45a;color:#0a0a0a;padding:15px 30px;border-radius:999px;text-decoration:none;font-family:Arial;font-weight:bold;letter-spacing:2px;text-transform:uppercase;font-size:13px">▶ Listen to ${esc(o.details.name)}'s song</a></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [o.contact.email], subject: `🎶 ${o.details.name}'s song is ready: "${o.song.title}"`, html }),
  });
  if (!r.ok) throw new Error(`Email error ${r.status}: ${await r.text()}`);
  return { sent: true, link };
}

/* ---------- Stripe (REST API, no SDK needed) ---------- */
async function stripe(method, endpoint, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const r = await fetch(`${process.env.STRIPE_API_BASE || "https://api.stripe.com"}/v1/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe: ${j.error?.message || r.status}`);
  return j;
}
async function createCheckout(o) {
  const params = {
    mode: "payment",
    customer_email: o.contact.email,
    client_reference_id: o.id,
    "metadata[order_id]": o.id,
    "payment_intent_data[metadata][order_id]": o.id,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": CURRENCY,
    "line_items[0][price_data][unit_amount]": String(PRICE_CENTS),
    "line_items[0][price_data][product_data][name]": `Custom song for ${o.details.name}`.slice(0, 120),
    "line_items[0][price_data][product_data][description]": `"${o.song.title}": an original ${o.details.style || o.details.genre || ""} song, studio-recorded and delivered ${DELIVERY_PROMISE}.`.slice(0, 300),
    allow_promotion_codes: "true",
    success_url: `${BASE_URL}/song/${o.id}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${BASE_URL}/?canceled=${o.id}`,
  };
  if (o.cover && BASE_URL.startsWith("https://")) params["line_items[0][price_data][product_data][images][0]"] = `${BASE_URL}/cover/${o.cover}`;
  return stripe("POST", "checkout/sessions", params);
}
// pay = { amount (cents), currency, ref, provider }
function markPaid(o, pay) {
  if (!o || o.paid) return false;
  o.paid = { at: new Date().toISOString(), ...pay };
  if (o.status === "awaiting_payment") o.status = "new";
  persist();
  console.log(`[paid] ${o.id} ${(pay.amount / 100).toFixed(2)} ${pay.currency} via ${pay.provider}`);
  return true;
}
const fromStripe = (session) => ({ amount: session.amount_total, currency: session.currency, ref: session.id, provider: "stripe" });

/* ---------- PayPal (Orders v2 REST API, no SDK needed) ---------- */
let ppToken = { value: null, until: 0 };
async function paypalToken() {
  if (ppToken.value && Date.now() < ppToken.until) return ppToken.value;
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${PAYPAL_ID}:${PAYPAL_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`PayPal login failed: ${j.error_description || r.status}. Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_MODE.`);
  ppToken = { value: j.access_token, until: Date.now() + (j.expires_in - 120) * 1000 };
  return ppToken.value;
}
async function paypal(method, endpoint, body, extraHeaders = {}) {
  const r = await fetch(`${PAYPAL_API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${await paypalToken()}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`PayPal: ${j.details?.[0]?.description || j.message || r.status}`), { paypal: j, status: r.status });
  return j;
}
const priceValue = () => (PRICE_CENTS / 100).toFixed(2);
async function createPaypalOrder(o) {
  const j = await paypal("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: o.id, custom_id: o.id,
      description: `Custom song for ${o.details.name}: "${o.song.title}"`.slice(0, 127),
      amount: { currency_code: CURRENCY.toUpperCase(), value: priceValue() },
    }],
    payment_source: { paypal: { experience_context: {
      brand_name: "Heartsong", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING",
      return_url: `${BASE_URL}/song/${o.id}?paid=paypal`, cancel_url: `${BASE_URL}/?canceled=${o.id}`,
    } } },
  }, { "PayPal-Request-Id": `create-${o.id}` });
  const link = (j.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!link) throw new Error("PayPal didn't return a checkout link.");
  return { id: j.id, url: link.href };
}
// Collect the money for an approved PayPal order. Safe to call more than once.
async function capturePaypal(o) {
  if (!o || o.paid || !o.paypal) return;
  let j;
  try {
    j = await paypal("POST", `/v2/checkout/orders/${o.paypal}/capture`, null, { "PayPal-Request-Id": `capture-${o.id}` });
  } catch (e) {
    const issue = e.paypal?.details?.[0]?.issue;
    if (issue === "ORDER_ALREADY_CAPTURED") j = await paypal("GET", `/v2/checkout/orders/${o.paypal}`);
    else if (issue === "ORDER_NOT_APPROVED") return; // customer hasn't finished paying yet
    else throw e;
  }
  const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
  const unit = j.purchase_units?.[0];
  if (j.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") return;
  if (unit?.custom_id && unit.custom_id !== o.id) return; // must be this order's payment
  markPaid(o, { amount: Math.round(parseFloat(cap.amount.value) * 100), currency: cap.amount.currency_code.toLowerCase(), ref: cap.id, provider: "paypal" });
}
async function verifyPaypalWebhook(req, event) {
  const h = (k) => req.headers[k];
  const j = await paypal("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"),
    webhook_id: PAYPAL_WEBHOOK_ID, webhook_event: event,
  });
  return j.verification_status === "SUCCESS";
}
function verifyStripeSignature(raw, header) {
  const parts = String(header || "").split(",").map((x) => x.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${t}.${raw.toString("utf8")}`).digest("hex");
  return sigs.some((v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
}

/* ---------- audio/video with Range support (needed for iPhone playback) ---------- */
function serveAudio(req, res, file) { return serveMedia(req, res, path.join(AUDIO, path.basename(file)), "audio/mpeg"); }
function serveMedia(req, res, fp, type) {
  if (!fs.existsSync(fp)) return send(res, 404, "Not found", "text/plain");
  const size = fs.statSync(fp).size;
  const m = (req.headers.range || "").match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const start = m[1] ? parseInt(m[1]) : size - parseInt(m[2]);
    const end = m[1] && m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return fs.createReadStream(fp, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
  fs.createReadStream(fp).pipe(res);
}

/* ---------- routes ---------- */
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname, M = req.method;
  try {
    // Pages
    if (M === "GET" && (p === "/" || p === "/index.html")) {
      const preview = `<meta property="og:title" content="Heartsong: a song only they could have"><meta property="og:description" content="An original song written from your real memories. Studio-recorded and delivered ${escHtml(DELIVERY_PROMISE)}."><meta property="og:image" content="${BASE_URL}/media/promo-poster.jpg"><meta property="og:url" content="${BASE_URL}/"><meta name="twitter:card" content="summary_large_image">`;
      return send(res, 200, page("index.html").toString().replace("</head>", preview + "\n</head>"), "text/html; charset=utf-8");
    }
    if (M === "GET" && /^\/song\/[\w-]+$/.test(p)) {
      // Fill in the link-preview tags (iMessage, WhatsApp, Instagram) with this song's title and cover.
      const o = orders[p.split("/").pop()];
      let html = page("song.html").toString();
      if (o) {
        const title = escHtml(`🎶 A song for ${o.details.name}: "${o.song.title}"`);
        const img = o.cover ? `${BASE_URL}/cover/${o.cover}` : "";
        html = html
          .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${title}">`)
          .replace("</head>", `${img ? `<meta property="og:image" content="${img}"><meta name="twitter:card" content="summary_large_image">` : ""}<meta property="og:url" content="${BASE_URL}/song/${o.id}">\n</head>`);
      }
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (M === "GET" && /^\/cover\/[\w-]+\.jpg$/.test(p)) {
      const fp = path.join(COVERS, path.basename(p));
      if (!fs.existsSync(fp)) return send(res, 404, "Not found", "text/plain");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      return fs.createReadStream(fp).pipe(res);
    }
    if (M === "GET" && p === "/studio") {
      if (!isAdmin(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Heartsong Studio"' }); return res.end(ADMIN_PASSWORD ? "Login required" : "Set ADMIN_PASSWORD to use the studio"); }
      return send(res, 200, page("studio.html"), "text/html; charset=utf-8");
    }
    if (M === "GET" && p.startsWith("/audio/")) return serveAudio(req, res, p.slice(7));
    // Your own site media (promo video, poster). Drop new files into the media folder.
    if (M === "GET" && /^\/media\/[\w.-]+\.(mp4|jpg|png|webp)$/.test(p)) {
      const ext = p.split(".").pop();
      const type = { mp4: "video/mp4", jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext];
      res.setHeader("Cache-Control", "public, max-age=86400");
      // Looks in the media folder first, then next to server.js (so a flat upload also works).
      const name = path.basename(p), inFolder = path.join(__dirname, "media", name);
      return serveMedia(req, res, fs.existsSync(inFolder) ? inFolder : path.join(__dirname, name), type);
    }

    // Customer API
    if (M === "GET" && p === "/api/health") return send(res, 200, { ok: Boolean(ANTHROPIC_KEY), orders: true, promise: DELIVERY_PROMISE, price: PRICE_LABEL, payments: Boolean(PROVIDER), provider: PROVIDER });
    if (M === "POST" && p === "/api/lyrics") {
      const { prompt } = await readJson(req);
      return send(res, 200, { text: await writeLyrics(prompt) });
    }
    if (M === "POST" && p === "/api/orders") {
      const b = await readJson(req, 4_500_000);
      const email = str(b.contact?.email, 200).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: "Please enter a valid email." });
      if (!b.song?.lyrics || !b.song?.title) return send(res, 400, { error: "Missing song." });
      const id = newId();
      const d = b.details || {};
      orders[id] = {
        id, status: PROVIDER ? "awaiting_payment" : "new", created: new Date().toISOString(), takes: [], chosen: null,
        contact: { email, phone: str(b.contact?.phone, 40) },
        details: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, str(v, 3000)])),
        song: { title: str(b.song.title, 120), style: str(b.song.style, 1000), lyrics: str(b.song.lyrics, 6000), why: str(b.song.why, 400), clip: str(b.song.clip, 600) },
        dedication: str(d.message, 600),
      };
      const cover = decodeCover(b.cover);
      if (cover) { fs.writeFileSync(path.join(COVERS, `${id}.jpg`), cover); orders[id].cover = `${id}.jpg`; }
      persist();
      console.log(`[order] ${id} for ${orders[id].details.name} (${email})`);
      if (PROVIDER === "paypal") {
        const pp = await createPaypalOrder(orders[id]);
        orders[id].paypal = pp.id; persist();
        return send(res, 200, { id, link: `/song/${id}`, promise: DELIVERY_PROMISE, checkoutUrl: pp.url });
      }
      if (PROVIDER === "stripe") {
        const session = await createCheckout(orders[id]);
        orders[id].checkout = session.id; persist();
        return send(res, 200, { id, link: `/song/${id}`, promise: DELIVERY_PROMISE, checkoutUrl: session.url });
      }
      return send(res, 200, { id, link: `/song/${id}`, promise: DELIVERY_PROMISE });
    }
    // Customer returns from checkout: collect / double-check the payment directly with PayPal or Stripe.
    if (M === "POST" && /^\/api\/orders\/[\w-]+\/confirm$/.test(p)) {
      const o = orders[p.split("/")[3]];
      if (!o) return send(res, 404, { error: "Order not found" });
      if (o.paid || !PROVIDER) return send(res, 200, { status: o.status });
      if (PROVIDER === "paypal") { await capturePaypal(o); return send(res, 200, { status: o.status }); }
      const sid = str(url.searchParams.get("session_id"), 200);
      if (!/^cs_[\w]+$/.test(sid)) return send(res, 400, { error: "Bad session" });
      const session = await stripe("GET", `checkout/sessions/${sid}`);
      if (session.metadata?.order_id === o.id && session.payment_status === "paid") markPaid(o, fromStripe(session));
      return send(res, 200, { status: o.status });
    }
    // Stripe webhook: the reliable confirmation (customer closed the tab, slow bank, etc.)
    if (M === "POST" && p === "/api/stripe/webhook") {
      if (!STRIPE_WEBHOOK_SECRET) return send(res, 400, { error: "Webhook secret not set" });
      const raw = await readBody(req, 1_000_000);
      if (!verifyStripeSignature(raw, req.headers["stripe-signature"])) return send(res, 400, { error: "Bad signature" });
      const evt = JSON.parse(raw.toString("utf8"));
      const session = evt.data?.object;
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(evt.type) && session?.payment_status === "paid")
        markPaid(orders[session.metadata?.order_id], fromStripe(session));
      return send(res, 200, { received: true });
    }
    // PayPal webhook (optional backup): collects payment even if the customer closes the tab after approving.
    if (M === "POST" && p === "/api/paypal/webhook") {
      if (PROVIDER !== "paypal" || !PAYPAL_WEBHOOK_ID) return send(res, 400, { error: "PayPal webhook not configured" });
      const evt = JSON.parse((await readBody(req, 1_000_000)).toString("utf8"));
      if (!(await verifyPaypalWebhook(req, evt))) return send(res, 400, { error: "Bad signature" });
      const r = evt.resource || {};
      if (evt.event_type === "CHECKOUT.ORDER.APPROVED") {
        const o = Object.values(orders).find((x) => x.paypal === r.id);
        if (o) await capturePaypal(o);
      } else if (evt.event_type === "PAYMENT.CAPTURE.COMPLETED") {
        const o = orders[r.custom_id] || Object.values(orders).find((x) => x.paypal === r.supplementary_data?.related_ids?.order_id);
        if (o && r.status === "COMPLETED") markPaid(o, { amount: Math.round(parseFloat(r.amount.value) * 100), currency: r.amount.currency_code.toLowerCase(), ref: r.id, provider: "paypal" });
      }
      return send(res, 200, { received: true });
    }
    if (M === "GET" && /^\/api\/song\/[\w-]+$/.test(p)) {
      const o = orders[p.split("/").pop()];
      return o ? send(res, 200, publicSong(o)) : send(res, 404, { error: "Song not found" });
    }

    // Studio API (admin only)
    if (p.startsWith("/api/studio/")) {
      if (!isAdmin(req)) return send(res, 401, { error: "Login required" });
      if (M === "GET" && p === "/api/studio/orders")
        return send(res, 200, { orders: Object.values(orders).sort((a, b) => b.created.localeCompare(a.created)), instant: Boolean(ELEVEN_KEY), email: Boolean(RESEND_KEY), payments: Boolean(PROVIDER) });
      const m = p.match(/^\/api\/studio\/orders\/([\w-]+)\/(\w+)(?:\/([\w.-]+))?$/);
      const o = m && orders[m[1]];
      if (!o) return send(res, 404, { error: "Order not found" });
      const act = m[2];
      if (M === "POST" && act === "status") { o.status = str((await readJson(req)).status, 20); persist(); return send(res, 200, o); }
      if (M === "POST" && act === "lyrics") { const b = await readJson(req); o.song.lyrics = str(b.lyrics, 6000); o.song.title = str(b.title || o.song.title, 120); persist(); return send(res, 200, o); }
      if (M === "POST" && act === "upload") {
        const buf = await readBody(req, 40_000_000);
        if (buf.length < 1000) return send(res, 400, { error: "That file looks empty." });
        const file = `${o.id}-${o.takes.length + 1}-${crypto.randomBytes(3).toString("hex")}.mp3`;
        fs.writeFileSync(path.join(AUDIO, file), buf);
        o.takes.push({ file, label: str(url.searchParams.get("label") || "Upload", 60), at: new Date().toISOString() });
        if (!o.chosen) o.chosen = file;
        if (o.status === "new") o.status = "in_studio";
        persist(); return send(res, 200, o);
      }
      if (M === "POST" && act === "instant") {
        if (!ELEVEN_KEY) return send(res, 400, { error: "Set ELEVENLABS_API_KEY to use instant takes." });
        const buf = await elevenTake(o);
        const file = `${o.id}-${o.takes.length + 1}-${crypto.randomBytes(3).toString("hex")}.mp3`;
        fs.writeFileSync(path.join(AUDIO, file), buf);
        o.takes.push({ file, label: "ElevenLabs take", at: new Date().toISOString() });
        if (!o.chosen) o.chosen = file;
        if (o.status === "new") o.status = "in_studio";
        persist(); return send(res, 200, o);
      }
      if (M === "POST" && act === "choose") { const f = m[3]; if (!o.takes.some((t) => t.file === f)) return send(res, 400, { error: "No such take" }); o.chosen = f; persist(); return send(res, 200, o); }
      if (M === "POST" && act === "deliver") {
        if (!o.chosen) return send(res, 400, { error: "Upload and choose a take first." });
        if (PROVIDER && !o.paid) return send(res, 400, { error: "This order hasn't been paid yet." });
        o.status = "delivered"; o.delivered = new Date().toISOString(); persist();
        const r = await emailDelivery(o);
        o.emailed = r.sent; persist();
        return send(res, 200, { ...o, deliveryLink: `${BASE_URL}/song/${o.id}` });
      }
    }
    send(res, 404, "Not found", "text/plain");
  } catch (e) {
    console.error(e);
    send(res, e.code === 413 ? 413 : 500, { error: e.message || "Server error" });
  }
}).listen(PORT, () => console.log(`Heartsong on ${BASE_URL}  ·  studio: ${BASE_URL}/studio`));
