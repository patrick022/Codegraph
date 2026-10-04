import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

// The only place a Supabase client is built. Clerk owns the session; Supabase
// just receives the Clerk session token on every request (third-party auth),
// so policies can read the org claim off auth.jwt(). No Supabase session is
// stored or refreshed, so there's nothing competing for cookies or the proxy.
export function supabase() {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    accessToken: async () => (await auth()).getToken(),
  });
}
