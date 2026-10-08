import { auth } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import { analyseRepository, PENDING_REPO } from "@/lib/start-analysis";
import { parseRepositoryUrl } from "@/pipeline/archive";

/**
 * Where the landing page's field submits. Starting an analysis from a GET is
 * safe to repeat: a repository the organization already has goes to its
 * existing analysis, nothing re-runs.
 */
export async function GET(req: NextRequest) {
  const pending = req.cookies.get(PENDING_REPO)?.value;
  const repo = parseRepositoryUrl(req.nextUrl.searchParams.get("url") ?? pending ?? "");
  // The landing field checks the shape before submitting, so this is only a
  // hand-typed URL; the dashboard's form is where an error gets explained.
  if (!repo) return NextResponse.redirect(new URL("/", req.url));

  const { orgId } = await auth();
  if (!orgId) {
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", new URL("/new", req.url).href);
    const res = NextResponse.redirect(signIn);
    res.cookies.set(PENDING_REPO, `${repo.owner}/${repo.name}`, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60,
    });
    return res;
  }

  const res = NextResponse.redirect(new URL(`/analyses/${await analyseRepository(orgId, repo)}`, req.url));
  if (pending) res.cookies.delete(PENDING_REPO);
  return res;
}
