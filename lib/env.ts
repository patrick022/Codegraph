// Imported by next.config.ts so a missing value stops `next dev` / `next build`
// on boot instead of surfacing as a confusing auth or network error later.
// NEXT_PUBLIC_* values must be read with literal property access so Next can
// inline them into client bundles.

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing environment variable ${name}. Set it in .env.local.`);
  }
  return value;
}

export const env = {
  clerkPublishableKey: required(
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  ),
  clerkSecretKey: required("CLERK_SECRET_KEY", process.env.CLERK_SECRET_KEY),
  supabaseUrl: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabasePublishableKey: required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  ),
  // Server only. Never NEXT_PUBLIC_, so Next can't inline it into a bundle.
  supabaseSecretKey: required("SUPABASE_SECRET_KEY", process.env.SUPABASE_SECRET_KEY),
  // Server only. The private JWK imported into Supabase's JWT signing keys,
  // which signs the agent's one-analysis credential.
  agentSigningKey: required("AGENT_SIGNING_KEY", process.env.AGENT_SIGNING_KEY),
  // The agent service (codegraph-agent, `pnpm dev` there). When it's down,
  // only Ask says so; nothing else calls it.
  agentUrl: required("AGENT_URL", process.env.AGENT_URL),
};
