/**
 * GET  /api/settings/default-surface-mode — the output surface new sessions open in
 * PUT  /api/settings/default-surface-mode — save that choice
 *
 * Issue #2201. Issue #2193 gave every split and every phone tab a persisted
 * "last state", which is a memory of what the user did, not a statement of what
 * they want to start from. A user who works in the transcript all day still had
 * to flip every newly opened split out of `terminal` by hand. This route is the
 * statement: server-wide, stored in `app_settings`, and consulted by the
 * browser only for a surface that has nothing persisted yet.
 *
 * Modeled on `../default-agents/route.ts` (Issue #2065) — same store, same
 * `configured: false` meaning "still on the compiled-in constant", same rule
 * that no row is written at install time.
 *
 * ## Why there is no reset action
 *
 * {@link SurfaceMode} has exactly two values and one of them IS the constant,
 * so "reset" and "choose terminal" are the same click. `default-agents` needs a
 * reset because its constant is a list that can change under an install; a
 * two-value enum whose default is one of the two cannot drift that way.
 */

// Reads the database on every request; a prerendered answer would be a snapshot
// of whatever the setting was at build time.
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getDefaultSurfaceMode,
  setDefaultSurfaceMode,
} from '@/lib/db/app-settings-db';
import {
  DEFAULT_SURFACE_MODE,
  VALID_SURFACE_MODES,
  isSurfaceMode,
  type SurfaceMode,
} from '@/types/ui-state';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/settings/default-surface-mode');

interface DefaultSurfaceModeBody {
  success: true;
  /** The mode in force: the stored setting, else the compiled-in constant. */
  defaultSurfaceMode: SurfaceMode;
  /** false means "nothing stored" — the install is still on the constant. */
  configured: boolean;
  /** What an install with no setting uses. Lets the UI avoid hardcoding it. */
  constantDefault: SurfaceMode;
  /** Every selectable mode, so the UI never hardcodes the vocabulary. */
  available: SurfaceMode[];
}

function buildBody(): DefaultSurfaceModeBody {
  const db = getDbInstance();
  const stored = getDefaultSurfaceMode(db);

  return {
    success: true,
    defaultSurfaceMode: stored ?? DEFAULT_SURFACE_MODE,
    configured: stored !== null,
    constantDefault: DEFAULT_SURFACE_MODE,
    // Derived from the guard's own Set rather than re-listed here, so a third
    // mode (Epic #2192 keeps `'xterm'` reserved) cannot be shipped in the type
    // and forgotten in the API's vocabulary.
    available: [...VALID_SURFACE_MODES] as SurfaceMode[],
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(buildBody(), { status: 200 });
  } catch (error) {
    logger.error('get-default-surface-mode-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('mode' in body)) {
      return NextResponse.json(
        { success: false, error: 'Invalid request body: "mode" is required' },
        { status: 400 }
      );
    }

    const mode = (body as { mode: unknown }).mode;

    // The SAME guard the browser applies to `?view=` and to localStorage. A
    // value that reaches the DB unvalidated comes back out on every device, and
    // a mode no component switches on would leave every fresh split blank.
    if (!isSurfaceMode(mode)) {
      return NextResponse.json(
        { success: false, error: 'Invalid "mode": expected "terminal" or "chat"' },
        { status: 400 }
      );
    }

    setDefaultSurfaceMode(getDbInstance(), mode);
    logger.info('default-surface-mode-updated', { mode });

    // Surfaces that already have a persisted mode are untouched on purpose:
    // this names the value a surface STARTS at, and `readSurfaceMode()` reads
    // localStorage first. Rewriting what the user switched to by hand would
    // make the #2193 toggle unable to stick.
    return NextResponse.json(buildBody(), { status: 200 });
  } catch (error) {
    logger.error('put-default-surface-mode-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
