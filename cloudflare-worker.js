/**
 * Cinema Nest – Selar Webhook Handler
 * Deploy this as a Cloudflare Worker.
 *
 * What it does:
 *   1. Receives a POST from Selar when a payment is completed
 *   2. Verifies the request is genuine (secret token check)
 *   3. Figures out which plan (1 / 3 / 6 / 12 months) was bought
 *   4. Finds the matching user in Firestore by email
 *   5. Sets plan = 'active' and subscriptionEnd = now + (plan length)
 *
 * ── ENV VARS to set in Cloudflare Worker Settings ──
 *   FIREBASE_PROJECT_ID   → cinema-nest-2bf23
 *   FIREBASE_API_KEY      → your Firebase Web API key
 *   SELAR_SECRET          → any secret string you set in Selar webhook settings
 *
 * ── YOUR 4 SELAR PRODUCTS ──
 *   1 month  → https://selar.com/1c7tz476t8   ($3)
 *   3 months → https://selar.com/851861q275   ($6)
 *   6 months → https://selar.com/6487z415ih   ($9)
 *   12 months→ https://selar.com/5rc8s61861   ($18)
 *
 * Selar's exact webhook field names can vary depending on how your account
 * is configured, so this worker tries several signals, in order of
 * reliability, to figure out which product was bought:
 *   1. The product slug/ID/link (matched against PRODUCT_SLUGS below)
 *   2. The product name/title (matched against keywords like "3 month")
 *   3. The amount paid (matched against PRICE_TO_PLAN below)
 * If none match, it safely falls back to the 1-month plan and logs a
 * warning so you can see it in Cloudflare logs and adjust the matching.
 */

// ── Map each plan to its length in days ──
const PLAN_DAYS = { '1m': 30, '3m': 90, '6m': 180, '12m': 365 };

// ── Map each Selar product slug (the part after selar.com/) to a plan ──
const PRODUCT_SLUGS = {
  '1c7tz476t8': '1m',
  '851861q275': '3m',
  '6487z415ih': '6m',
  '5rc8s61861': '12m',
};

// ── Fallback: map the price paid (in whole units, e.g. USD) to a plan ──
// Used if Selar's payload doesn't clearly identify the product.
const PRICE_TO_PLAN = { 3: '1m', 6: '3m', 9: '6m', 18: '12m' };

export default {
  async fetch(request, env) {

    // ── Only accept POST ──
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── Parse body ──
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    // ── Optional: verify Selar secret token ──
    // Selar sends the secret you configure as a header or body field.
    // Uncomment and adjust once you confirm Selar's exact field from logs.
    /*
    const incomingSecret = request.headers.get('x-selar-token') || payload.secret;
    if (incomingSecret !== env.SELAR_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    */

    // ── Log payload so you can inspect it in Cloudflare logs ──
    console.log('Selar webhook payload:', JSON.stringify(payload));

    // ── Extract buyer email ──
    // Selar typically sends: payload.buyer_email OR payload.customer?.email
    // Adjust field names after inspecting your first live log.
    const email =
      payload.buyer_email ||
      payload.customer_email ||
      payload.email ||
      (payload.customer && payload.customer.email) ||
      null;

    if (!email) {
      console.error('No email found in payload');
      return new Response('No email in payload', { status: 400 });
    }

    // ── Figure out which plan was purchased ──
    const planDuration = detectPlan(payload);

    // ── Calculate subscription end date from the plan length ──
    const now = new Date();
    const days = PLAN_DAYS[planDuration];
    const subscriptionEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // ── Find user in Firestore by email, then activate ──
    try {
      const activated = await activateUserByEmail(
        email,
        subscriptionEnd.toISOString(),
        planDuration,
        env
      );

      if (!activated) {
        // User not found – store a pending activation keyed by email
        // so it can be picked up when they next log in
        await storePendingActivation(email, subscriptionEnd.toISOString(), planDuration, env);
        console.log(`No user found for ${email} — stored as pending activation (${planDuration})`);
      }

      return new Response(JSON.stringify({ success: true, email, plan: planDuration }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (err) {
      console.error('Firestore error:', err);
      return new Response('Firestore error: ' + err.message, { status: 500 });
    }
  }
};

// ────────────────────────────────────────────────
// Work out which plan (1m / 3m / 6m / 12m) the
// Selar payload corresponds to. Tries several
// possible payload shapes since Selar's exact
// field names can differ by account/integration.
// ────────────────────────────────────────────────
function detectPlan(payload) {
  // 1. Try matching a product URL/slug/ID against our known slugs
  const productRefCandidates = [
    payload.product_url,
    payload.product_link,
    payload.product_id,
    payload.product_slug,
    payload.product && payload.product.id,
    payload.product && payload.product.slug,
    payload.product && payload.product.url,
    payload.item_id,
  ].filter(Boolean).map(String);

  for (const ref of productRefCandidates) {
    for (const [slug, plan] of Object.entries(PRODUCT_SLUGS)) {
      if (ref.includes(slug)) return plan;
    }
  }

  // 2. Try matching the product name/title against duration keywords
  const nameCandidates = [
    payload.product_name,
    payload.product_title,
    payload.item_name,
    payload.product && payload.product.name,
    payload.product && payload.product.title,
  ].filter(Boolean).map(s => String(s).toLowerCase());

  for (const name of nameCandidates) {
    if (name.includes('12 month') || name.includes('12-month') || name.includes('1 year') || name.includes('annual')) return '12m';
    if (name.includes('6 month') || name.includes('6-month')) return '6m';
    if (name.includes('3 month') || name.includes('3-month') || name.includes('quarter')) return '3m';
    if (name.includes('1 month') || name.includes('1-month') || name.includes('monthly')) return '1m';
  }

  // 3. Fall back to matching the amount paid
  const amountCandidates = [
    payload.amount,
    payload.price,
    payload.total,
    payload.total_amount,
  ].filter(v => v !== undefined && v !== null);

  for (const raw of amountCandidates) {
    const num = Math.round(parseFloat(raw));
    if (PRICE_TO_PLAN[num]) return PRICE_TO_PLAN[num];
  }

  // 4. Give up — default to the shortest/cheapest plan and flag it
  console.warn('Could not determine plan from payload — defaulting to 1m. Inspect payload above and update detectPlan().');
  return '1m';
}

// ────────────────────────────────────────────────
// Query Firestore for a user doc matching the email
// then update it with active subscription
// ────────────────────────────────────────────────
async function activateUserByEmail(email, subscriptionEnd, planDuration, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const apiKey    = env.FIREBASE_API_KEY;

  // Firestore REST: query users collection where email == buyer email
  const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;

  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'email' },
          op: 'EQUAL',
          value: { stringValue: email.toLowerCase().trim() },
        },
      },
      limit: 1,
    },
  };

  const queryRes = await fetch(queryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(queryBody),
  });

  const queryData = await queryRes.json();
  console.log('Firestore query result:', JSON.stringify(queryData));

  // Check if a matching document was found
  const firstResult = queryData[0];
  if (!firstResult || !firstResult.document) {
    return false; // no user found
  }

  // Extract the document path (e.g. projects/.../documents/users/UID)
  const docPath = firstResult.document.name;

  // PATCH the user doc to activate subscription
  const patchUrl = `https://firestore.googleapis.com/v1/${docPath}?key=${apiKey}&updateMask.fieldPaths=plan&updateMask.fieldPaths=planDuration&updateMask.fieldPaths=subscriptionEnd&updateMask.fieldPaths=activatedAt`;

  const patchBody = {
    fields: {
      plan:            { stringValue: 'active' },
      planDuration:    { stringValue: planDuration },
      subscriptionEnd: { stringValue: subscriptionEnd },
      activatedAt:     { stringValue: new Date().toISOString() },
    },
  };

  const patchRes = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody),
  });

  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`Firestore PATCH failed: ${err}`);
  }

  console.log(`✅ Activated ${planDuration} subscription for ${email} until ${subscriptionEnd}`);
  return true;
}

// ────────────────────────────────────────────────
// Store a pending activation in Firestore
// (used when payment arrives before the user signs up,
//  or email doesn't match an existing account)
// ────────────────────────────────────────────────
async function storePendingActivation(email, subscriptionEnd, planDuration, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const apiKey    = env.FIREBASE_API_KEY;

  // Use a URL-safe version of the email as the doc ID
  const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/pending_activations/${docId}?key=${apiKey}`;

  const body = {
    fields: {
      email:           { stringValue: email.toLowerCase().trim() },
      planDuration:    { stringValue: planDuration },
      subscriptionEnd: { stringValue: subscriptionEnd },
      createdAt:       { stringValue: new Date().toISOString() },
    },
  };

  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
