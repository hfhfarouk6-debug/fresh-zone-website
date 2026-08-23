/* Fresh Zone - shared config. Plain script, no modules, so it also works
   when the files are opened directly from disk (file://). */
window.FZ = window.FZ || {};

FZ.SUPA_URL = 'https://gnlvytjcryizrkckpgtx.supabase.co';
/* Publishable (anon) key - safe to ship in client source. The real access
   control is the RLS policy on `products`, `market_settings` and the
   `product-images` bucket. Verify those are locked to the admin role. */
FZ.SUPA_KEY = 'sb_publishable_6Dgu7fTMdr1mqrUsHiiEQQ_GXZOXi91';

/* Single source of truth for contact details. Previously the six WhatsApp
   links, the schema.org telephone and the poster strip disagreed. */
FZ.PHONE_PRIMARY = '01027572394';
FZ.PHONE_PRIMARY_INTL = '201027572394';
FZ.PHONE_SECONDARY = '01281517707';

FZ.waLink = function (text) {
  return 'https://wa.me/' + FZ.PHONE_PRIMARY_INTL + '?text=' + encodeURIComponent(text || '');
};

/* The dashboard client. Persists the login, refreshes it, and attaches it to
   every request - which is what the dashboard needs and what the public pages
   must never have. */
FZ.client = function () {
  if (!window.supabase || !window.supabase.createClient) return null;
  if (!FZ._sb) FZ._sb = window.supabase.createClient(FZ.SUPA_URL, FZ.SUPA_KEY);
  return FZ._sb;
};

/* The read-only client, for the site itself.

   supabase-js stores the signed-in token per ORIGIN and attaches it to every
   request from that origin - so the public price list was sending the
   dashboard's login too. Once that token expired, PostgREST answered 401
   instead of falling back to the anonymous role, and the products disappeared
   from the site. Only in the operator's own browser, which is exactly why it
   looked like the site had broken while every customer saw it fine. A wrong
   device clock brings the expiry on much sooner, because the client decides
   when to refresh by comparing against local time.

   A client that holds no session at all cannot have that failure mode: it is
   always the anonymous role, and `products` is world-readable by RLS. */
FZ.publicClient = function () {
  if (!window.supabase || !window.supabase.createClient) return null;
  if (!FZ._sbPublic) {
    FZ._sbPublic = window.supabase.createClient(FZ.SUPA_URL, FZ.SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
  }
  return FZ._sbPublic;
};
