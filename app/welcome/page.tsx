import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  DrawFigure,
  FetchFigure,
  GridEdges,
  MapFigure,
  ParseStepFigure,
  ReachFigure,
  ResolveFigure,
} from "@/components/landing/figures";
import { ThemeControl, type Theme } from "../theme-control";

export const metadata: Metadata = {
  title: "Codegraph: see the shape of a codebase you didn't write",
};

// Signed-out visitors reach this at the root; the proxy rewrites it here.
// Every sentence on it has to be true of the product one click away.

const COLUMN = "mx-auto w-full max-w-[1140px] px-6";
// Section padding is the same everywhere; the hairline above each one is the only divider.
const SECTION = "border-t border-border py-24 sm:py-32";
const H2 = "text-[clamp(1.75rem,3.4vw,2.75rem)] font-semibold leading-[1.1] tracking-[-0.03em]";
const BODY = "text-[15px] leading-[1.6] text-muted";

// Kept short and plain. Each one is checked against the adapter it describes.
const STEPS: { name: string; figure: ReactNode; text: ReactNode }[] = [
  {
    name: "Fetch",
    figure: <FetchFigure />,
    text: "The repository is downloaded as one archive, at the commit that was latest when you asked. That commit is recorded with the map.",
  },
  {
    name: "Parse",
    figure: <ParseStepFigure />,
    text: (
      <>
        Every TypeScript and JavaScript file is parsed. Imports, re-exports, dynamic imports and{" "}
        <code className="font-mono text-[13px]">require()</code> calls are all read.
      </>
    ),
  },
  {
    name: "Resolve",
    figure: <ResolveFigure />,
    text: "Each import is resolved to a file in the repository, through tsconfig paths and index files. One that can't be is reported with the reason.",
  },
  {
    name: "Draw",
    figure: <DrawFigure />,
    text: "The map, the neighbours and the blast radius are arithmetic over that list of edges, worked out in your browser.",
  },
];

const FRAMEWORKS: { name: string; reads: string }[] = [
  { name: "Next.js", reads: "Pages, API endpoints, layouts and middleware, and the route table." },
  { name: "NestJS", reads: "Controllers, modules, services, guards and the rest, and routes read from their decorators." },
  { name: "Express", reads: "Routers, controllers, services, models and middleware, by the folders they live in." },
  { name: "React", reads: "Components and hooks." },
  { name: "Anything else", reads: "Still parsed and mapped in full. Config files and tests are recognised by name." },
];

const REFUSALS: { claim: string; detail: string }[] = [
  {
    claim: "Guess a connection",
    detail:
      "A line exists because an import resolved to a real file. An import that doesn't resolve is listed with its reason and left off the map.",
  },
  {
    claim: "Grade your code",
    detail: "No scores, no ratings, no issues found. It explains a codebase; it doesn't review one.",
  },
  {
    claim: "Approximate a route",
    detail:
      "If a route's method and full path can't both be read from the code, it isn't shown. Express assembles its routes at runtime, so for Express it says so and shows none.",
  },
  {
    claim: "Let the AI walk the graph",
    detail:
      "When you ask a question, the assistant chooses a file and a direction. The same arithmetic that draws the map does the walking.",
  },
  {
    claim: "Read private repositories",
    detail: "That would mean asking for a GitHub token and keeping it. Public repositories only.",
  },
  {
    claim: "Read other languages",
    detail: "TypeScript and JavaScript only. Getting one language right is the whole point.",
  },
];

export default async function WelcomePage() {
  const cookie = (await cookies()).get("theme")?.value;
  const theme: Theme = cookie === "light" || cookie === "dark" ? cookie : "system";

  return (
    // Isolated so the grid sits behind the content but above the page background.
    <div className="isolate min-h-full">
      <GridEdges />
      <header className="sticky top-0 z-10 border-b border-border bg-bg">
        <div className={`${COLUMN} flex h-12 items-center gap-4`}>
          <span className="font-mono text-xs font-medium">codegraph</span>
          <div className="ml-auto flex items-center gap-3">
            <ThemeControl initial={theme} />
            <Link
              href="/sign-in"
              className="rounded border border-border px-2 py-0.5 text-xs text-fg hover:border-accent hover:text-accent"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className={`${COLUMN} grid min-h-[calc(100svh-3rem)] items-center gap-14 py-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-20`}>
          <div>
            <h1 className="max-w-[14ch] text-[clamp(2.25rem,5.2vw,4.25rem)] font-semibold leading-[1.05] tracking-[-0.04em]">
              See the shape of a codebase you didn&apos;t write.
            </h1>
            <p className={`${BODY} mt-6 max-w-[46ch]`}>
              Paste a public GitHub repository. Codegraph parses every TypeScript and JavaScript file, resolves each
              import to the file it names, and draws the result: folders as boxes, imports as lines between them.
            </p>
            <RepositoryField />
          </div>
          <MapFigure />
        </section>

        <section className={SECTION}>
          <div className={`${COLUMN} grid items-center gap-14 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-20`}>
            <div className="order-last lg:order-first">
              <ReachFigure />
            </div>
            <div>
              <h2 className={`${H2} max-w-[18ch]`}>Open a folder, select a file, follow the lines.</h2>
              <Prose>
                <p>
                  Folders fold into boxes so a large repository stays readable; open one to see its files. Select a
                  file and what imports it lights green, what it imports lights amber.
                </p>
                <p>
                  Blast radius walks two levels out from a file, so you can see what a change would reach before you
                  make it.
                </p>
                <p>
                  Ask for an explanation and get a paragraph written from that file and its real neighbours. Or ask
                  the repository a question and watch each lookup happen before the answer arrives.
                </p>
              </Prose>
            </div>
          </div>
        </section>

        <section className={SECTION}>
          <div className={COLUMN}>
            <h2 className={H2}>How it works</h2>
            <p className={`${BODY} mt-6 max-w-[64ch]`}>
              The parser decides what&apos;s connected. The AI explains what the parser found and labels files no
              convention could place, but it never adds a line to the map.
            </p>
            <ol className="mt-16 grid gap-x-12 gap-y-16 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.name}>
                  <div className="flex h-36 items-center">{step.figure}</div>
                  <h3 className="mt-8 flex items-baseline gap-2 text-[15px] font-medium">
                    <span className="font-mono text-xs text-muted">{i + 1}</span>
                    {step.name}
                  </h3>
                  <p className={`${BODY} mt-3 max-w-[46ch]`}>{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={SECTION}>
          <div className={`${COLUMN} grid gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20`}>
            <div>
              <h2 className={`${H2} max-w-[14ch]`}>It knows what frameworks put where.</h2>
              <p className={`${BODY} mt-6 max-w-[46ch]`}>
                Framework knowledge sorts files into roles, so you can pick out the pages, endpoints and services at a
                glance. A repository with several projects in it gets each one read by its own framework.
              </p>
            </div>
            <dl className="border-b border-border">
              {FRAMEWORKS.map((f) => (
                <div key={f.name} className="grid gap-x-10 gap-y-1 border-t border-border py-5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <dt className="text-[15px] font-medium">{f.name}</dt>
                  <dd className={`${BODY} max-w-[46ch]`}>{f.reads}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className={SECTION}>
          <div className={COLUMN}>
            <h2 className={H2}>What it won&apos;t do</h2>
            <p className={`${BODY} mt-6 max-w-[64ch]`}>
              A dependency graph that&apos;s ninety percent right is worse than none, because there&apos;s no telling
              which ten percent is wrong. So where the code doesn&apos;t say, the map doesn&apos;t either.
            </p>
            <dl className="mt-16 grid gap-x-20 gap-y-12 md:grid-cols-2">
              {REFUSALS.map((r) => (
                <div key={r.claim}>
                  <dt className="text-[15px] font-medium">{r.claim}</dt>
                  <dd className={`${BODY} mt-2 max-w-[46ch]`}>{r.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className={`${COLUMN} flex flex-wrap items-center gap-x-4 gap-y-1 py-8 text-xs text-muted`}>
          <span className="font-mono text-fg">codegraph</span>
          <span>Maps public TypeScript and JavaScript repositories from their imports.</span>
        </div>
      </footer>
    </div>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return <div className={`${BODY} mt-6 max-w-[46ch] space-y-4`}>{children}</div>;
}

/**
 * A plain GET form: the visitor isn't signed in, so there's no session to run
 * an action under. The handler holds the repository through sign-in, and the
 * dashboard's form opens with it filled in.
 */
function RepositoryField() {
  return (
    <form action="/new" className="mt-10 max-w-[30rem]">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="url"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="github.com/owner/repo"
          aria-label="Public GitHub repository URL"
          // The owner and name rules parseRepositoryUrl applies, so a mistake is
          // caught before sign-in rather than after.
          pattern="\s*(https?://)?(www\.)?github\.com/[A-Za-z0-9][A-Za-z0-9\-]{0,38}/[A-Za-z0-9._\-]{1,100}([\/?#].*)?\s*"
          title="A GitHub repository URL, like github.com/owner/repo"
          className="h-9 min-w-0 flex-1 rounded border border-border bg-surface px-3 font-mono text-[13px] outline-none placeholder:text-muted focus:border-accent"
        />
        <button type="submit" className="h-9 shrink-0 rounded bg-accent px-4 text-[13px] text-white">
          Map this repository
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">You&apos;ll sign in, then confirm the repository.</p>
    </form>
  );
}
