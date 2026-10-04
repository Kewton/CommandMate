import { NextResponse } from 'next/server';
import {
  describeSessionTargetConflict,
  INSTANCE_TOOL_CONFLICT,
  type SessionTargetConflict,
} from '@/lib/session/resolve-session-target';

/**
 * The 400 a side-effecting route answers when the instance's declaration and
 * the request disagree (see `resolveSessionTargetStrict`): the sentence, the
 * machine-readable code, and the conflict's own fields spread into the body.
 */
export function sessionTargetConflictResponse(conflict: SessionTargetConflict): NextResponse {
  return NextResponse.json(
    {
      error: describeSessionTargetConflict(conflict),
      code: INSTANCE_TOOL_CONFLICT,
      ...conflict,
    },
    { status: 400 }
  );
}
