import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { env } from "./env.ts";

// The agent's credential is a Supabase access token for exactly one analysis.
// It's signed with a key imported into the project's JWT signing keys, so
// Supabase verifies it like any session and the policies decide what it reads:
// the organization's rows, narrowed by a restrictive policy to the one
// analysis it names. No key that bypasses row-level security is involved.
//
// Nothing here asks whether the caller owns the analysis. Whoever mints one
// must have proved that first; whoever holds one may read that analysis until
// it expires.

// Long enough for one answer's lookups, short enough that a leaked token from
// a log is spent by the time anyone reads it.
const LIFETIME_SECONDS = 5 * 60;

export type AgentGrant = { analysisId: string; organizationId: string };

let keys: { kid: string; privateKey: KeyObject; publicKey: KeyObject } | null = null;

function signingKey() {
  if (keys) return keys;
  const jwk: unknown = JSON.parse(env.agentSigningKey);
  if (typeof jwk !== "object" || jwk === null) throw new Error("AGENT_SIGNING_KEY isn't a JSON Web Key");
  const kid: unknown = Reflect.get(jwk, "kid");
  if (typeof kid !== "string" || kid === "") throw new Error("AGENT_SIGNING_KEY has no kid, so Supabase can't match it to the imported key");
  // ES256 only: it's what the key was generated as, and accepting anything
  // else here would let a token choose its own algorithm.
  if (Reflect.get(jwk, "kty") !== "EC" || Reflect.get(jwk, "crv") !== "P-256") throw new Error("AGENT_SIGNING_KEY must be an EC P-256 key");
  const [x, y, d] = ["x", "y", "d"].map((k) => Reflect.get(jwk, k));
  if (typeof x !== "string" || typeof y !== "string" || typeof d !== "string") throw new Error("AGENT_SIGNING_KEY is missing x, y or d");
  const key: JsonWebKey = { kty: "EC", crv: "P-256", x, y, d };
  const privateKey = createPrivateKey({ key, format: "jwk" });
  keys = { kid, privateKey, publicKey: createPublicKey(privateKey) };
  return keys;
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function mintAgentCredential(grant: AgentGrant, now = Date.now()): string {
  const { kid, privateKey } = signingKey();
  const iat = Math.floor(now / 1000);
  const head = encode({ alg: "ES256", typ: "JWT", kid });
  const body = encode({
    role: "authenticated",
    aud: "authenticated",
    // The claim the existing policies read the organization from.
    org_id: grant.organizationId,
    // The claim the restrictive policies narrow every table to.
    analysis_id: grant.analysisId,
    iat,
    exp: iat + LIFETIME_SECONDS,
  });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${signature.toString("base64url")}`;
}

/**
 * The grant a credential carries, or null if it isn't one this app signed or
 * it has expired. Supabase checks the signature again on every read; checking
 * here too turns a bad token into a 401 instead of an empty analysis.
 */
export function readAgentCredential(token: string, now = Date.now()): AgentGrant | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;
  const { kid, publicKey } = signingKey();
  const header = parseJson(head);
  if (!header || Reflect.get(header, "alg") !== "ES256" || Reflect.get(header, "kid") !== kid) return null;
  const valid = verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  if (!valid) return null;
  const claims = parseJson(body);
  if (!claims) return null;
  const exp: unknown = Reflect.get(claims, "exp");
  const analysisId: unknown = Reflect.get(claims, "analysis_id");
  const organizationId: unknown = Reflect.get(claims, "org_id");
  if (typeof exp !== "number" || exp * 1000 <= now) return null;
  if (typeof analysisId !== "string" || typeof organizationId !== "string") return null;
  return { analysisId, organizationId };
}

function parseJson(part: string): object | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}
