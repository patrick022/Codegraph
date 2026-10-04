import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { cookies } from "next/headers";
import { ThemeControl, type Theme } from "../theme-control";

// The frame every signed-in page renders inside. Inviting people happens in
// the switcher's "Manage" panel, Clerk's own UI.
export default async function WorkspaceLayout({ children }: LayoutProps<"/">) {
  const cookie = (await cookies()).get("theme")?.value;
  const theme: Theme = cookie === "light" || cookie === "dark" ? cookie : "system";
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
        <span className="font-mono text-xs font-medium">codegraph</span>
        <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" />
        <div className="ml-auto flex items-center gap-3">
          <ThemeControl initial={theme} />
          <UserButton />
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
