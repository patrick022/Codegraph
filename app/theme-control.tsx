"use client";

import { useState } from "react";

export type Theme = "system" | "light" | "dark";

// The choice lives in a cookie so the server can put data-theme on <html>
// in the first response; anything client-only would flash the wrong palette.
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset.theme;
    document.cookie = "theme=; path=/; max-age=0; samesite=lax";
  } else {
    root.dataset.theme = theme;
    document.cookie = `theme=${theme}; path=/; max-age=31536000; samesite=lax`;
  }
}

export function ThemeControl({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState(initial);

  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded border border-border">
      {(["system", "light", "dark"] as const).map((t) => (
        <button
          key={t}
          role="radio"
          aria-checked={theme === t}
          onClick={() => {
            setTheme(t);
            applyTheme(t);
          }}
          className={`px-1.5 py-0.5 text-[11px] ${theme === t ? "text-accent" : "text-muted hover:text-fg"}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
