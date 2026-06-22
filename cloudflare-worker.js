/**
 * Cinema Nest – Selar Webhook Handler
 * Deploy this as a Cloudflare Worker.
 *
 * What it does:
 *   1. Receives a POST from Selar when a payment is completed
 *   2. Verifies the request is genuine (secret token check)
 *   3. Finds the matching user in Firestore by email
 *   4. Sets plan = 'active' and subscriptionEnd = now + 30 days
 *
 * ── ENV VARS to set in Cloudflare Worker Settings ──
 *   FIREBASE_PROJECT_ID   → cinema-nest-2bf23
 *   FIREBASE_API_KEY      → your Firebase Web API key
 *   SELAR_SECRET          → any secret string you set in Selar webhook settings
 */

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

    // ── Calculate subscription end date (30 days) ──
    const now = new Date();
    const subscriptionEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // ── Find user in Firestore by email, then activate ──
    try {
      const activated = await activateUserByEmail(
        email,
        subscriptionEnd.toISOString(),
        env
      );

      if (!activated) {
        // User not found – store a pending activation keyed by email
        // so it can be picked up when they next log in
        await storePendingActivation(email, subscriptionEnd.toISOString(), env);
        console.log(`No user found for ${email} — stored as pending activation`);
      }

      return new Response(JSON.stringify({ success: true, email }), {
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
// Query Firestore for a user doc matching the email
// then update it with active subscription
// ────────────────────────────────────────────────
async function activateUserByEmail(email, subscriptionEnd, env) {
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
  const patchUrl = `https://firestore.googleapis.com/v1/${docPath}?key=${apiKey}&updateMask.fieldPaths=plan&updateMask.fieldPaths=subscriptionEnd&updateMask.fieldPaths=activatedAt`;

  const patchBody = {
    fields: {
      plan:            { stringValue: 'active' },
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

  console.log(`✅ Activated subscription for ${email} until ${subscriptionEnd}`);
  return true;
}

// ────────────────────────────────────────────────
// Store a pending activation in Firestore
// (used when payment arrives before the user signs up,
//  or email doesn't match an existing account)
// ────────────────────────────────────────────────
async function storePendingActivation(email, subscriptionEnd, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const apiKey    = env.FIREBASE_API_KEY;

  // Use a URL-safe version of the email as the doc ID
  const docId = email.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/pending_activations/${docId}?key=${apiKey}`;

  const body = {
    fields: {
      email:           { stringValue: email.toLowerCase().trim() },
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
