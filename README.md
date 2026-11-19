# Heartsong

## Go live (about 30 minutes)
1. **Get your keys.**
   - **PayPal:** log in at developer.paypal.com → **Apps & Credentials** → make sure **Sandbox** is selected → **Create App** → copy the **Client ID** and **Secret**.
   - **Claude:** console.anthropic.com → **API keys** → create a key.
2. **Upload the files.** On github.com, create a private repository and drag in every file from this folder.
3. **Launch.** On render.com: **New → Blueprint**, pick your repository, paste the keys, make up a studio password, and click **Deploy**. Your site goes live at a temporary Render address first.
4. **Connect heartsong.shop.** In Render → your service → Settings → **Custom Domains**, add `heartsong.shop` (Render adds `www` and redirects it for you). Render shows the exact DNS records: add them where you bought the domain, delete any `AAAA` records there, then click **Verify**. HTTPS is set up automatically.
5. **Test a payment.** Order a song on heartsong.shop. On the PayPal page, log in with the test buyer account from developer.paypal.com → **Testing Tools → Sandbox Accounts** (the "Personal" one). The order should appear under **New** in your studio marked ✓ Paid via PayPal.
6. **Take real money.** In developer.paypal.com switch to **Live**, create an app, and copy its Client ID and Secret. In Render → Environment, replace both keys and set `PAYPAL_MODE` to `live`.

Your studio: `https://heartsong.shop/studio` (user `studio`, your password).

---

Customers write a song with AI lyrics. Your team produces it in Suno from a studio dashboard, and the customer gets a page to play and share it.

## Run it
Needs Node 18 or newer. No packages to install.

```
ANTHROPIC_API_KEY=sk-ant-...  ADMIN_PASSWORD=pick-a-strong-one  node server.js
```

- Customer app: `http://localhost:3000`
- Studio dashboard: `http://localhost:3000/studio` (user `studio`, password = ADMIN_PASSWORD)
- Song pages: `/song/<id>`, private links that are hard to guess

## Optional settings
| Variable | What it does |
|---|---|
| `BASE_URL` | Your public address, set to `https://heartsong.shop` (used in emailed links, Stripe returns and share previews) |
| `RESEND_API_KEY`, `MAIL_FROM` | Emails the song link automatically on delivery (resend.com). Without it, the studio shows the link to send by hand. |
| `ELEVENLABS_API_KEY` | Adds an "Instant take" button in the studio as a backup engine |
| `DELIVERY_PROMISE` | Text shown to customers, default `within 24 hours` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Turns on PayPal checkout. Without payment keys, orders are free (handy for testing). |
| `PAYPAL_MODE` | `sandbox` (test payments) or `live` (real money) |
| `PAYPAL_WEBHOOK_ID` | Optional backup: collects payment even if a customer closes the tab right after approving (see below) |
| `STRIPE_SECRET_KEY` | Stripe instead of PayPal: used only when no PayPal keys are set |
| `STRIPE_WEBHOOK_SECRET` | Stripe only: confirms payments if the customer closes the tab |
| `PRICE_CENTS`, `CURRENCY` | Price per song, default `5000` (= $50) and `usd` |
| `COUPONS` | Coupon codes as `CODE:percent`, comma-separated. Example: `THANKS:50,VIP:100` (THANKS = 50% off, VIP = free). Codes aren't case-sensitive. |
| `PORT` | Default 3000 |

## Producing an order
1. Open the order in the studio and tap **Copy style** and **Copy lyrics**.
2. In Suno: Create → Custom. Paste both, set the title, generate 2–4 takes.
3. Download the best takes and upload them. Pick one and tap **Approve & deliver**.

## Promo video
The welcome page plays `media/promo.mp4` (muted, looping, with a Tap for sound button) and uses `media/promo-poster.jpg` as the still image before it loads and as the picture shown when your site link is shared. To swap it, replace those two files with the same names. Vertical 9:16 MP4 under ~10 MB works best.

## Keeping songs on-trend
Each genre's styles live in `TRENDS` near the top of `index.html`. Every style has the sound sent to the music engine and the way its lyrics are written, and the 🔥 style is the trending default. Check the charts and TikTok every 2–3 months: edit the descriptions, add new styles, move the 🔥, and update `TRENDS_UPDATED`. Describe sounds, never artist names (Suno rejects them).

## PayPal payments
Customers tap the order button and pay on PayPal's secure page with their PayPal account or a debit/credit card. When they come back, the app collects the payment and moves the order from **Unpaid** to **New** in your studio. Unpaid orders can't be delivered. If they cancel, they return to their saved song. Refunds (for your money-back guarantee) are done in your PayPal account under Activity.

**Optional backup webhook:** in developer.paypal.com → your app → **Webhooks → Add Webhook**, enter `https://heartsong.shop/api/paypal/webhook` and tick **Checkout order approved** and **Payment capture completed**. Copy the **Webhook ID** into Render → Environment as `PAYPAL_WEBHOOK_ID`.

## Stripe payments (alternative)
Not used while PayPal keys are set. To switch to Stripe later, remove the PayPal keys and add these:
1. Create a Stripe account. In **Developers → API keys**, copy the secret key. Start with the **test** key (`sk_test_...`).
2. In **Developers → Webhooks**, add an endpoint: `https://heartsong.shop/api/stripe/webhook`, with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy its signing secret (`whsec_...`).
3. Start the server with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BASE_URL=https://heartsong.shop` (already set in render.yaml).
4. Test with card `4242 4242 4242 4242`, any future date, any CVC. The order should appear under **New** in the studio marked ✓ Paid.
5. When ready, switch both values to your **live** key and a live-mode webhook.

How it works: the customer taps the button and pays on Stripe's secure page (cards, Apple Pay, Google Pay, promo codes). Orders wait under **Unpaid** until Stripe confirms, and unpaid orders can't be delivered. If they cancel, they return to their saved song. Refunds (for the money-back guarantee) are done in the Stripe dashboard. Turn on **Settings → Emails → Successful payments** for automatic receipts, and create promo codes under **Products → Coupons**.

## Before launch
- **Hosting:** any Node host with a persistent disk (Render, Railway, Fly.io, a VPS). Orders and audio are saved in `data/`; back that folder up.
- **Rights:** confirm Suno's current terms allow songs from your plan to be sold to customers.
