/**
 * The rules for a role's name and body.
 *
 * @module lib/agent-roles/validation
 */
import { hasLoneSurrogate } from './unicode';
import { MAX_ROLE_BODY_BYTES, MAX_ROLE_NAME_LENGTH, type RoleAssignmentInput } from '@/types/agent-roles';

/**
 * Why a body cannot be stored, or null when it can.
 *
 * Blank is refused because Claude runs as if nothing were configured when handed
 * an empty file (§6.1), which would look applied. A NUL or a lone surrogate could
 * not come back out byte for byte. Never trims: the body reaches the model as written.
 */
export function roleBodyProblem(body: unknown): string | null {
  if (typeof body !== 'string') return 'body must be a string';
  if (body.trim() === '') return 'body must not be empty or only whitespace';
  if (Buffer.byteLength(body, 'utf8') > MAX_ROLE_BODY_BYTES) {
    return `body exceeds ${MAX_ROLE_BODY_BYTES} bytes`;
  }
  if (body.includes('\0')) return 'body must not contain NUL';
  if (hasLoneSurrogate(body)) return 'body must be valid Unicode';
  return null;
}

/** The name as stored (trimmed), or the reason it cannot be. */
export function normalizeRoleName(name: unknown): { ok: true; name: string } | { ok: false; problem: string } {
  if (typeof name !== 'string') return { ok: false, problem: 'name must be a string' };
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, problem: 'name must not be empty' };
  if (trimmed.length > MAX_ROLE_NAME_LENGTH) {
    return { ok: false, problem: `name exceeds ${MAX_ROLE_NAME_LENGTH} characters` };
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, problem: 'name must not contain control characters' };
  if (hasLoneSurrogate(trimmed)) return { ok: false, problem: 'name must be valid Unicode' };
  return { ok: true, name: trimmed };
}

/** Parse the `role` of a request, or null when it is not one of the three states. */
export function parseRoleAssignmentInput(value: unknown): RoleAssignmentInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const { state, roleId } = value as { state?: unknown; roleId?: unknown };
  if (state === 'inherit' || state === 'none') return { state };
  if (state === 'role' && typeof roleId === 'string' && roleId !== '') return { state, roleId };
  return null;
}
