// Drawings of the canvas, not captures of it. Every colour is a canvas token,
// so they follow the theme with the product. Nothing is labelled: a name on a
// box would be a claim about somebody's code. The motion is CSS in
// globals.css, and reduced motion leaves each figure as a still.

const ROW = 24;

/** A text line too small to read: where a name would sit. */
function Bar({ x, y, w, tone = "fg" }: { x: number; y: number; w: number; tone?: "fg" | "muted" }) {
  const fill = tone === "fg" ? "var(--fg)" : "var(--muted)";
  return <rect x={x} y={y} width={w} height={tone === "muted" ? 4 : 5} rx={2} fill={fill} opacity={tone === "fg" ? 0.55 : 0.6} />;
}

/** A folded directory: a box with a name and a count under it. */
function Folded({ x, y, w = 130, label, dim, lit }: { x: number; y: number; w?: number; label: number; dim?: boolean; lit?: boolean }) {
  return (
    <g opacity={dim ? 0.3 : 1}>
      <rect x={x + 0.5} y={y + 0.5} width={w} height={44} rx={4} fill="var(--surface)" stroke={lit ? "var(--accent)" : "var(--border)"} />
      <Bar x={x + 10} y={y + 14} w={label} />
      <Bar x={x + 10} y={y + 26} w={label * 0.45} tone="muted" />
    </g>
  );
}

type Point = [number, number];

/** An edge between two points, curved the way the canvas draws them. `loop` names the CSS animation that draws it. */
function Edge({ from, to, color, dim, loop, delay = 0 }: { from: Point; to: Point; color: string; dim?: boolean; loop?: "variant" | "cycle"; delay?: number }) {
  const mid = (from[0] + to[0]) / 2;
  const d = `M${from[0]} ${from[1]} C${mid} ${from[1]} ${mid} ${to[1]} ${to[0]} ${to[1]}`;
  return (
    <path
      d={d}
      pathLength={1}
      fill="none"
      stroke={color}
      strokeWidth={1.25}
      opacity={dim ? 0.45 : 1}
      className={loop && `cg-${loop}-edge`}
      style={loop && { animationDelay: `${delay}s` }}
    />
  );
}

const IN = "var(--incoming)";
const OUT = "var(--outgoing)";
const GREY = "var(--edge)";
const KINDS = ["var(--kind-1)", "var(--kind-2)", "var(--kind-3)", "var(--kind-4)"];

const svgClass = "block h-auto w-full";

// The hero's selections, taking turns. Each is a row of the open panel, the
// left boxes that import it and the right boxes it imports.
const HERO_PERIOD = 12;
const LEFT = [62, 152, 216, 284];
const RIGHT = [42, 132, 222, 312];
const SELECTIONS = [
  { row: 3, from: [0, 2], to: [0, 1, 3] },
  { row: 6, from: [1], to: [2, 3] },
  { row: 1, from: [3, 0], to: [1] },
];

/** The map with one folder opened; the selected file changes, and with it what lights green and amber. */
export function MapFigure() {
  const panel = { x: 215, y: 64, w: 150 };
  const rowsTop = panel.y + 40;
  const rows = [70, 52, 84, 60, 76, 46, 66, 58, 80];
  const rowY = (i: number) => rowsTop + i * ROW + ROW / 2;
  const leftEnd = (i: number): Point => [150, LEFT[i] ?? 0];
  const rightEnd = (i: number): Point => [410, RIGHT[i] ?? 0];
  const row = (i: number, side: "in" | "out"): Point => [side === "in" ? panel.x : panel.x + panel.w, rowY(i)];
  return (
    <svg viewBox="0 0 560 340" className={svgClass} aria-hidden>
      {/* Every edge any selection lights, grey as the canvas shows the unselected ones. */}
      {SELECTIONS.flatMap((s, k) => [
        ...s.from.map((l) => <Edge key={`g${k}i${l}`} from={leftEnd(l)} to={row(s.row, "in")} color={GREY} dim />),
        ...s.to.map((r) => <Edge key={`g${k}o${r}`} from={row(s.row, "out")} to={rightEnd(r)} color={GREY} dim />),
      ])}

      <Folded x={20} y={40} label={78} />
      <Folded x={20} y={130} label={56} />
      <Folded x={20} y={194} label={92} />
      <Folded x={20} y={262} label={64} />
      <Folded x={410} y={20} label={70} />
      <Folded x={410} y={110} label={88} />
      <Folded x={410} y={200} label={60} />
      <Folded x={410} y={290} label={74} />

      <rect x={panel.x + 0.5} y={panel.y + 0.5} width={panel.w} height={40 + rows.length * ROW + 4} rx={4} fill="var(--surface)" stroke="var(--accent)" />
      <Bar x={panel.x + 10} y={panel.y + 14} w={86} />
      <Bar x={panel.x + 10} y={panel.y + 26} w={40} tone="muted" />
      <line x1={panel.x} x2={panel.x + panel.w} y1={rowsTop - 0.5} y2={rowsTop - 0.5} stroke="var(--border)" />
      {rows.map((w, i) => (
        <g key={i} opacity={0.55}>
          <rect x={panel.x + 10} y={rowY(i) - 3} width={6} height={6} rx={1} fill={KINDS[i % KINDS.length]} />
          <Bar x={panel.x + 24} y={rowY(i) - 2.5} w={w} />
        </g>
      ))}

      {SELECTIONS.map((s, k) => {
        // Negative delays put each selection at its turn in the same cycle.
        const delay = -((HERO_PERIOD - (k * HERO_PERIOD) / SELECTIONS.length) % HERO_PERIOD);
        const w = rows[s.row] ?? 0;
        return (
          <g key={k} className={`cg-variant${k === 0 ? "" : " cg-variant-rest"}`} style={{ animationDelay: `${delay}s` }}>
            {s.from.map((l, j) => (
              <Edge key={`i${l}`} from={leftEnd(l)} to={row(s.row, "in")} color={IN} loop="variant" delay={delay + j * 0.12} />
            ))}
            {s.to.map((r, j) => (
              <Edge key={`o${r}`} from={row(s.row, "out")} to={rightEnd(r)} color={OUT} loop="variant" delay={delay + 0.3 + j * 0.12} />
            ))}
            <rect x={panel.x + 1} y={rowsTop + s.row * ROW} width={panel.w - 1} height={ROW} fill="var(--accent)" opacity={0.12} />
            <rect x={panel.x + 10} y={rowY(s.row) - 3} width={6} height={6} rx={1} fill={KINDS[s.row % KINDS.length]} />
            <Bar x={panel.x + 24} y={rowY(s.row) - 2.5} w={w} />
          </g>
        );
      })}
    </svg>
  );
}

/** A selected file and everything that reaches it within two imports; further out stays dim. */
export function ReachFigure() {
  const center: Point = [470, 150];
  const first: Point[] = [[300, 70], [300, 150], [300, 230]];
  const second: Point[] = [[130, 30], [130, 100], [130, 170], [130, 250]];
  const beyond: Point[] = [[0, 60], [0, 200]];
  // Which first-level file each second-level one imports.
  const into = [0, 0, 1, 2];
  const box = (p: Point, lit: boolean, dim: boolean, key: string, kind: number) => (
    <g key={key} opacity={dim ? 0.3 : 1}>
      <rect x={p[0] + 0.5} y={p[1] - 15.5} width={70} height={30} rx={4} fill="var(--surface)" stroke={lit ? "var(--accent)" : "var(--border)"} />
      <rect x={p[0] + 8} y={p[1] - 3} width={6} height={6} rx={1} fill={KINDS[kind % KINDS.length]} />
      <Bar x={p[0] + 20} y={p[1] - 2.5} w={36} />
    </g>
  );
  const right = (p: Point): Point => [p[0] + 70, p[1]];
  return (
    <svg viewBox="0 0 541 280" className={svgClass} aria-hidden>
      <Edge from={right(beyond[0]!)} to={second[0]!} color={GREY} dim />
      <Edge from={right(beyond[1]!)} to={second[2]!} color={GREY} dim />
      {/* The walk spreads outward: one level, then the next. */}
      {first.map((p, i) => (
        <Edge key={`f${i}`} from={right(p)} to={center} color={IN} loop="cycle" delay={i * 0.12} />
      ))}
      {second.map((p, i) => (
        <Edge key={`s${i}`} from={right(p)} to={first[into[i] ?? 0]!} color={IN} loop="cycle" delay={0.7 + i * 0.12} />
      ))}
      {beyond.map((p, i) => box(p, false, true, `b${i}`, i + 2))}
      {second.map((p, i) => box(p, false, false, `s${i}`, i))}
      {first.map((p, i) => box(p, false, false, `f${i}`, i + 1))}
      {box(center, true, false, "c", 0)}
    </svg>
  );
}

// The four steps of "How it works", drawn at one size so they sit in a row.
const stepClass = "block h-auto w-full max-w-[260px]";

/** A small file card: an outline with a few lines in it. */
function Card({ x, y, w = 80, h = 30, lit }: { x: number; y: number; w?: number; h?: number; lit?: boolean }) {
  return (
    <g>
      <rect x={x + 0.5} y={y + 0.5} width={w} height={h} rx={4} fill="var(--surface)" stroke={lit ? "var(--accent)" : "var(--border)"} />
      <Bar x={x + 14} y={y + h / 2 - 2.5} w={w * 0.5} />
    </g>
  );
}

/** Fetch: one archive, opened into its files. */
export function FetchFigure() {
  return (
    <svg viewBox="0 0 260 140" className={stepClass} aria-hidden>
      <rect x={20.5} y={30.5} width={84} height={78} rx={4} fill="var(--surface)" stroke="var(--muted)" />
      <line x1={20} x2={105} y1={50.5} y2={50.5} stroke="var(--muted)" />
      <line x1={118} x2={146} y1={70.5} y2={70.5} stroke="var(--muted)" />
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={160.5 + i * 14} y={22.5 + i * 18} width={58} height={70} rx={3} fill="var(--surface)" stroke="var(--border)" />
          <Bar x={170 + i * 14} y={34 + i * 18} w={30} />
        </g>
      ))}
    </svg>
  );
}

/** Parse: every line of a file read, the imports picked out. */
export function ParseStepFigure() {
  const lines = [120, 92, 134, 0, 84, 146, 108];
  return (
    <svg viewBox="0 0 260 140" className={stepClass} aria-hidden>
      <rect x={30.5} y={10.5} width={200} height={120} rx={4} fill="var(--surface)" stroke="var(--border)" />
      {lines.map((w, i) =>
        w === 0 ? null : (
          <g key={i}>
            {i < 3 && <rect x={44} y={22 + i * 15} width={3} height={8} rx={1} fill={OUT} />}
            <Bar x={56} y={23.5 + i * 15} w={w} tone={i < 3 ? "fg" : "muted"} />
          </g>
        ),
      )}
    </svg>
  );
}

/** Resolve: two imports reach real files; the third doesn't, and stops. */
export function ResolveFigure() {
  const from: Point = [104, 70];
  return (
    <svg viewBox="0 0 260 140" className={stepClass} aria-hidden>
      <Edge from={from} to={[170, 28]} color={OUT} loop="cycle" />
      <Edge from={from} to={[170, 70]} color={OUT} loop="cycle" delay={0.2} />
      <path d="M104 70 C140 70 140 116 176 116" fill="none" stroke="var(--muted)" strokeWidth={1.25} strokeDasharray="3 4" />
      <path d="M181 111 l8 8 M189 111 l-8 8" stroke="var(--muted)" strokeWidth={1.25} />
      <Card x={24} y={55} lit />
      <Card x={170} y={13} />
      <Card x={170} y={55} />
    </svg>
  );
}

/** Draw: the edge list laid out as a map. */
export function DrawFigure() {
  const mid: Point = [96, 70];
  return (
    <svg viewBox="0 0 260 140" className={stepClass} aria-hidden>
      <Edge from={[72, 32]} to={mid} color={GREY} loop="cycle" />
      <Edge from={[72, 108]} to={mid} color={GREY} loop="cycle" delay={0.15} />
      <Edge from={[164, 70]} to={[188, 32]} color={GREY} loop="cycle" delay={0.4} />
      <Edge from={[164, 70]} to={[188, 108]} color={GREY} loop="cycle" delay={0.55} />
      <Card x={2} y={17} w={70} />
      <Card x={2} y={93} w={70} />
      <Card x={96} y={55} w={68} />
      <Card x={188} y={17} w={70} />
      <Card x={188} y={93} w={70} />
    </svg>
  );
}

// The background grid: a strip down each side of the page, where a few cells
// at a time fill with a neon colour and fade. The content column between
// them stays still.
const CELL = 32;
const GRID_COLUMNS = 6;
const GRID_ROWS = 40;
const CELL_COLOURS = [1, 2, 3, 4, 5].map((n) => `var(--neon-${n})`);

// Fixed seed, computed once, so the server and every visit draw the same cells.
const CELLS = (() => {
  let seed = 11;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: 56 }, (_, i) => ({
    side: i % 2 ? ("right" as const) : ("left" as const),
    // Weighted toward the outermost columns, so the strip thins inward.
    column: Math.floor(next() ** 2 * GRID_COLUMNS),
    row: Math.floor(next() * GRID_ROWS),
    colour: CELL_COLOURS[Math.floor(next() * CELL_COLOURS.length)],
    duration: 7 + next() * 9,
    delay: -next() * 16,
  }));
})();

/** The grid strips behind the page, with their cells lighting in turn. */
export function GridEdges() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {(["left", "right"] as const).map((side) => (
        <div key={side} className={`cg-grid cg-grid-${side} absolute inset-y-0 ${side === "left" ? "left-0" : "right-0"} w-24 sm:w-48`}>
          {CELLS.filter((c) => c.side === side).map((c, i) => (
            <span
              key={i}
              // Only the outer three columns fit at phone width.
              className={`cg-cell absolute ${c.column >= 3 ? "max-sm:hidden" : ""}`}
              style={{
                // Grid lines sit on each tile's left and top pixel, so the right
                // strip's lines are at its edge minus whole cells.
                [side]: c.column * CELL + (side === "left" ? 1 : 0),
                top: c.row * CELL + 1,
                width: CELL - 1,
                height: CELL - 1,
                color: c.colour,
                animationDuration: `${c.duration}s`,
                animationDelay: `${c.delay}s`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
