import { auth } from "@clerk/nextjs/server";

// Read straight off the session token during server render: no call to Clerk.
export default async function WorkspacePage() {
  const { orgId, sessionClaims } = await auth();
  return (
    <div className="p-3 text-xs">
      <span className="text-muted">organization </span>
      <span>{sessionClaims?.org_name ?? orgId}</span>
    </div>
  );
}
