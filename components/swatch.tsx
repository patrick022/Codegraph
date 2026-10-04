// One hue per common extension, a handful and no more. Anything else is grey
// rather than a colour nobody can tell apart.
const CATEGORY_COLOUR: Record<string, string> = {
  ts: "var(--kind-1)",
  tsx: "var(--kind-2)",
  js: "var(--kind-3)",
  jsx: "var(--kind-4)",
};

/** Render a decorative extension colour swatch, using grey for unknown categories. */
export function CategorySwatch({ category }: { category: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-[2px]"
      style={{ background: CATEGORY_COLOUR[category] ?? "var(--muted)" }}
    />
  );
}
