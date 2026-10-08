import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isAuthPage = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);
// The agent's lookups carry their own one-analysis credential instead of a
// session, and check it themselves.
const isAgentLookup = createRouteMatcher(["/api/agent/(.*)"]);
// Where a signed-in user without an organization is sent to get one. Their
// session is "pending" until then, which the default checks treat as signed out.
const isOnboarding = createRouteMatcher(["/onboarding"]);
// The landing page, and where its field submits. That handler sends a
// signed-out visitor to sign in itself, holding on to the repository.
const isPublic = createRouteMatcher(["/welcome", "/new"]);

// Redirecting here means a signed-out visitor never receives a protected page's HTML.
export default clerkMiddleware(async (auth, req) => {
  if (isAuthPage(req) || isAgentLookup(req) || isPublic(req)) return;
  // The root is the dashboard once signed in and the landing page before.
  // A pending session (no organization yet) is signed in, and falls through to
  // the check below, which sends it on to onboarding.
  if (req.nextUrl.pathname === "/") {
    const { userId } = await auth({ treatPendingAsSignedOut: false });
    if (!userId) return NextResponse.rewrite(new URL("/welcome", req.url));
  }
  if (isOnboarding(req)) {
    const { userId, redirectToSignIn } = await auth({ treatPendingAsSignedOut: false });
    if (!userId) return redirectToSignIn();
    return;
  }
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
