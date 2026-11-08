/**
 * Kestrel's Night Eye mark: a crescent moon wrapped around an open raptor eye ("awake while you sleep").
 * Same geometry as PromptMark in lib/og.tsx (favicon, apple icon, OG images). Decorative: the KESTREL wordmark
 * next to it carries the accessible name.
 */
export function LogoMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={className}>
      <path d="M40 6 A27 27 0 1 0 58 40 A22 22 0 0 1 40 6 Z" fill="var(--color-phosphor, #91D982)" />
      <circle cx="29" cy="35" r="10.5" fill="var(--color-canvas, #07090D)" />
      <circle cx="29" cy="35" r="7.5" fill="none" stroke="var(--color-phosphor, #91D982)" strokeWidth="2.4" />
      <circle cx="29" cy="35" r="3.2" fill="var(--color-phosphor, #91D982)" />
    </svg>
  );
}
