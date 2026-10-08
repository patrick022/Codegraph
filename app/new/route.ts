import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { PENDING_REPO } from "@/lib/pending-repo";
import { parseRepositoryUrl } from "@/pipeline/archive";

/**
 * Where the landing page's field submits. It writes nothing: it holds the
 * repository and sends the visitor on to wherever they can confirm it.
 */
export async function GET(req: NextRequest) {
  const repo = parseRepositoryUrl(req.nextUrl.searchParams.get("url") ?? "");
  // The landing field checks the shape before submitting, so this is only a
  // hand-typed URL; the dashboard's form is where an error gets explained.
  if (!repo) return NextResponse.redirect(new URL("/", req.url));

  const { userId, orgId } = await auth({ treatPendingAsSignedOut: false });
  let next = new URL(orgId ? "/" : "/onboarding", req.url);
  if (!userId) {
    next = new URL("/sign-in", req.url);
    next.searchParams.set("redirect_url", new URL("/", req.url).href);
  }
  const res = NextResponse.redirect(next);
  res.cookies.set(PENDING_REPO, `${repo.owner}/${repo.name}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60,
  });
  return res;
}
