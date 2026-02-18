/**
 * URL Path Encoder
 *
 * Encodes file/directory paths for use in API URLs.
 * Splits path on '/' and encodes each segment individually,
 * preserving '/' separators so catch-all routes can correctly
 * parse path segments.
 *
 * Responsibility: URL encoding only.
 * Path traversal defense is handled server-side by isPathSafe().
 *
 * @param path - The file/directory path to encode
 * @returns URL-encoded path with '/' separators preserved
 */
export function encodePathForUrl(path: string): string {
  if (!path) return '';
  return path.split('/').map(encodeURIComponent).join('/');
}
