/**
 * useImageAttachment Hook
 * Issue #474: Manages image attachment state, validation, and upload
 * [S1-S2] SRP: Extracted from MessageInput for single responsibility
 */

'use client';

import { useState, useRef, useCallback } from 'react';
import { ATTACHABLE_IMAGE_ACCEPT, ATTACHABLE_IMAGE_EXTENSIONS, IMAGE_MAX_SIZE_BYTES } from '@/config/image-extensions';
import { normalizeExtension } from '@/config/image-extensions';

/**
 * Attached image state
 */
export interface AttachedImage {
  /** Original file object */
  file: File;
  /** Server-side relative path (e.g., .commandmate/attachments/1234-image.png) */
  path: string;
}

/**
 * Return type for useImageAttachment hook
 */
export interface UseImageAttachmentReturn {
  /** Currently attached image, or null */
  attachedImage: AttachedImage | null;
  /** Ref for the hidden file input element */
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  /** Whether an upload is in progress */
  isUploading: boolean;
  /** Error message from validation or upload, or null */
  error: string | null;
  /** Accept attribute value for file input */
  acceptAttribute: string;
  /** Open the file selection dialog */
  openFileDialog: () => void;
  /** Handle file selection from the input element */
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  /** Remove the current attachment */
  removeAttachment: () => void;
  /** Reset attachment state after successful send */
  resetAfterSend: () => void;
}

/**
 * Validate file extension and size before upload
 */
function validateFile(file: File): string | null {
  // Check extension
  const dotIndex = file.name.lastIndexOf('.');
  if (dotIndex === -1) {
    return 'Unsupported file format';
  }
  const ext = normalizeExtension(file.name.substring(dotIndex));
  if (!ATTACHABLE_IMAGE_EXTENSIONS.includes(ext)) {
    return `Unsupported file format: ${ext}`;
  }

  // Check size
  if (file.size > IMAGE_MAX_SIZE_BYTES) {
    const maxMB = IMAGE_MAX_SIZE_BYTES / 1024 / 1024;
    return `File size exceeds ${maxMB}MB limit`;
  }

  return null;
}

/**
 * Custom hook for image attachment functionality
 * Issue #474: Manages the full lifecycle of image attachment
 *
 * @param worktreeId - Current worktree ID
 * @param uploadFn - Function to upload a file (typically worktreeApi.uploadImageFile)
 * @returns Image attachment state and handlers
 */
export function useImageAttachment(
  worktreeId: string,
  uploadFn: (worktreeId: string, file: File) => Promise<{ path: string }>
): UseImageAttachmentReturn {
  const [attachedImage, setAttachedImage] = useState<AttachedImage | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);

    // Client-side validation
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    try {
      const result = await uploadFn(worktreeId, file);
      setAttachedImage({ file, path: result.path });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [worktreeId, uploadFn]);

  const removeAttachment = useCallback(() => {
    setAttachedImage(null);
    setError(null);
  }, []);

  const resetAfterSend = useCallback(() => {
    setAttachedImage(null);
  }, []);

  return {
    attachedImage,
    fileInputRef,
    isUploading,
    error,
    acceptAttribute: ATTACHABLE_IMAGE_ACCEPT,
    openFileDialog,
    handleFileSelect,
    removeAttachment,
    resetAfterSend,
  };
}
