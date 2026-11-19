/**
 * The turno mark (the three sessions over one gateway of docs/assets/logo-light.svg and
 * logo-dark.svg), inline so its colors follow the theme. The header shows the mark alone: the
 * tool switch beside it carries the names.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="4 12 56 44" role="img" aria-label="turno" className={className}>
      <circle cx="18" cy="20" r="6" fill="var(--turno-1)" />
      <circle cx="32" cy="20" r="6" fill="var(--turno-2)" />
      <circle cx="46" cy="20" r="6" fill="var(--turno-3)" />
      <rect x="8" y="36" width="48" height="16" rx="8" fill="var(--turno-4)" />
    </svg>
  );
}
