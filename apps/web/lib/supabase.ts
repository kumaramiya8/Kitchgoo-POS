import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://your-project.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy";

/**
 * Standard Supabase client instance configured for authenticated operations,
 * Row Level Security (RLS), and low-egress targeted Realtime channels.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "kitchgoo_auth_token",
  },
  realtime: {
    params: {
      eventsPerSecond: 20,
    },
  },
});
