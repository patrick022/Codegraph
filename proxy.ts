import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The preview reads only checked-in data, so it needs no account.
const isAuthPage = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/preview"]);
// Where a signed-in user without an organization is sent to get one. Their
// session is "pending" until then, which the default checks treat as signed out.
const isOnboarding = createRouteMatcher(["/onboarding"]);

// Redirecting here means a signed-out visitor never receives a protected page's HTML.
export default clerkMiddleware(async (auth, req) => {
  if (isAuthPage(req)) return;
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
