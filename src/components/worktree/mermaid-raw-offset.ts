/**
 * How an offset into the string a ReactMarkdown was given maps to the message
 * as written, for the mermaid source to name its fence's raw range
 * (Issue #3525).
 *
 * Its own module rather than an export of `MermaidCodeBlock`: tests mock that
 * component's module with a factory holding only the component, and a second
 * export read from it elsewhere would be missing from the mock.
 *
 * @module components/worktree/mermaid-raw-offset
 */

'use client';

import { createContext } from 'react';
import { IDENTITY_RAW_OFFSET, type RawOffsetMapper } from '@/lib/terminal-highlight';

/**
 * The default — identity — is right for every surface that hands react-markdown
 * the message itself (History, the file preview); chat, which draws parts of a
 * message, provides its own per part, or `null` where a part cannot be mapped.
 */
export const MermaidRawOffsetContext = createContext<RawOffsetMapper | null>(IDENTITY_RAW_OFFSET);
