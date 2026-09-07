/**
 * Repository (folder) icon shared by the sidebar's group headers and the
 * header repository tab strip (Issue #2374 follow-up).
 *
 * The tab strip used to mark a repository with an 8px colour chip, which sat a
 * few pixels away from the aggregated `StatusDot` and read as a second status
 * dot. The sidebar has always used a folder glyph filled with the repository
 * colour, so the two surfaces now share one definition rather than two shapes
 * for the same thing.
 *
 * `color` fills the glyph; without it the icon is a stroked outline in
 * `currentColor` (the sidebar header uses that form).
 */
export function GroupIcon({
  className = 'w-3.5 h-3.5',
  color,
}: {
  className?: string;
  color?: string;
}) {
  return (
    <svg
      className={`${className} flex-shrink-0`}
      viewBox="0 0 24 24"
      fill={color ?? 'none'}
      stroke={color ? 'none' : 'currentColor'}
      strokeWidth={color ? 0 : 2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  );
}
