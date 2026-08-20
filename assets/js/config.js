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

FZ.client = function () {
  if (!window.supabase || !window.supabase.createClient) return null;
  if (!FZ._sb) FZ._sb = window.supabase.createClient(FZ.SUPA_URL, FZ.SUPA_KEY);
  return FZ._sb;
};
