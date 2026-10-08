import { auth, clerkClient } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PENDING_REPO } from "@/lib/start-analysis";
import { ActivateOrganization } from "./activate";

// Clerk's choose-organization task lands here (taskUrls in the root layout).
// Rather than asking the person to name a team, join the one they were
// invited to, or create one for them. This is the only runtime call to Clerk's
// API, and it happens once per account, not on every request.
export default async function OnboardingPage() {
  const { userId } = await auth({ treatPendingAsSignedOut: false });
  if (!userId) redirect("/sign-in");

  const clerk = await clerkClient();
  const { data: memberships } = await clerk.users.getOrganizationMembershipList({
    userId,
    limit: 1,
  });
  let organizationId = memberships[0]?.organization.id;

  if (!organizationId) {
    const user = await clerk.users.getUser(userId);
    const owner =
      user.firstName ??
      user.username ??
      user.primaryEmailAddress?.emailAddress.split("@")[0] ??
      "My";
    const org = await clerk.organizations.createOrganization({
      name: `${owner}'s workspace`,
      createdBy: userId,
    });
    organizationId = org.id;
  }

  // A repository pasted on the landing page before signing up goes on to start.
  const next = (await cookies()).has(PENDING_REPO) ? "/new" : "/";
  return <ActivateOrganization organizationId={organizationId} redirectUrl={next} />;
}
