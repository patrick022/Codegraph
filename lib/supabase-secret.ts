import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";
import { env } from "./env.ts";

// The pipeline's writer, and nothing else's. It bypasses row-level security,
// because a run outlives the request and the Clerk token that came with it
// expires in about a minute. The organization it writes for is taken from the
// session at submission, never from input. Reads for display still go through
// supabase(), the user's token, and the policies.
// No Clerk import here, so the pipeline also runs from a plain script.
export function supabaseSecret() {
  return createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type SecretClient = ReturnType<typeof supabaseSecret>;
