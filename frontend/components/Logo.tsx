/** Cardboard Package mark: a "C" whose lid lifts open. */
export function Mark({ light = false, className = "size-8" }: { light?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M8 17 20 7h38L46 17z" fill="#E35B2C" />
      <path d="M8 21h48v9H17v18h39v9H8z" fill={light ? "#F2EFE9" : "#0E1013"} />
    </svg>
  );
}

export default function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Mark light={light} className="size-8" />
      <span className={`font-display text-[19px] font-semibold tracking-[-0.03em] ${light ? "text-bone" : "text-ink"}`}>
        Cardboard Package
      </span>
    </span>
  );
}
