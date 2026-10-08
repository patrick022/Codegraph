"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect } from "react";

// Making the org active is what resolves the pending session and puts the org
// claim into the token, and only the browser SDK can do that.
export function ActivateOrganization({ organizationId, redirectUrl }: { organizationId: string; redirectUrl: string }) {
  const { setActive } = useClerk();
  useEffect(() => {
    void setActive({ organization: organizationId, redirectUrl });
  }, [setActive, organizationId, redirectUrl]);
  return <p className="p-4 text-xs text-muted">Opening workspace…</p>;
}
