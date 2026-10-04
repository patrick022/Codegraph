export {};

declare global {
  // Added via Clerk dashboard → Sessions → Customize session token:
  //   { "org_name": "{{org.name}}" }
  // The token carries the org id by default but not its name.
  interface CustomJwtSessionClaims {
    org_name?: string;
  }
}
