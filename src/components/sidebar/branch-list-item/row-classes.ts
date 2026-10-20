/**
 * Class names for the parts of a sidebar branch row that depend on its state
 * (Issue #3604: moved out of BranchListItem so the component reads as layout).
 */

/** Right padding of the row button: room for "…" while the row actions show. */
export function branchRowButtonPaddingClass(showActions: boolean, isSelected: boolean): string {
  return showActions ? (isSelected ? 'pr-9' : 'pr-9 [@media(hover:none)]:pr-3') : 'pr-3';
}

/** Visibility and colour of the row's next-action line. */
export function branchNextActionClass(
  isSelected: boolean,
  isWaiting: boolean,
  awaitingInstruction: boolean
): string {
  return `pl-6 text-left text-xs font-medium truncate ${
    isSelected ? 'block' : 'hidden [@media(hover:none)]:block'
  } ${
    isWaiting
      ? 'text-warning-foreground'
      : awaitingInstruction
        ? 'text-success-foreground'
        : 'text-sidebar-muted'
  }`;
}
