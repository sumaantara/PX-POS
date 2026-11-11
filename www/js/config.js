// Public Supabase settings (the anon key is safe to ship; access is enforced by Row Level Security)
window.PX_CONFIG = {
  supabaseUrl: "__SUPABASE_URL__",
  supabaseAnonKey: "__SUPABASE_ANON_KEY__",
  usernameDomain: "px-pos.app", // username "kasir1" signs in as kasir1@px-pos.app
  timeZone: "Asia/Makassar",
  version: "1.0.0",
};
