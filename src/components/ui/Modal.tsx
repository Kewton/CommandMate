/**
 * Modal Component
 * A reusable modal dialog component
 */

'use client';

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/z-index';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showCloseButton?: boolean;
  /**
   * Disable close handlers (ESC key, backdrop click)
   * Used when child component (e.g., maximized MarkdownEditor) handles its own close
   * Issue #104
   */
  disableClose?: boolean;
}

/**
 * Modal component for displaying overlay dialogs
 *
 * @example
 * ```tsx
 * <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="File Viewer">
 *   <p>Modal content</p>
 * </Modal>
 * ```
 */
export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'lg',
  showCloseButton = true,
  disableClose = false,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on escape key (Issue #104: skip if disableClose is true)
  useEffect(() => {
    if (disableClose) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, disableClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }

    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-[calc(100vw-2rem)] sm:max-w-md',
    md: 'max-w-[calc(100vw-2rem)] sm:max-w-2xl',
    lg: 'max-w-[calc(100vw-2rem)] sm:max-w-4xl',
    xl: 'max-w-[calc(100vw-2rem)] sm:max-w-6xl',
    full: 'max-w-[calc(100vw-2rem)] sm:max-w-[95vw]',
  };

  // Use portal to render at document.body level, escaping any parent stacking context
  return createPortal(
    <div className="fixed inset-0 overflow-y-auto" style={{ zIndex: Z_INDEX.MODAL }}>
      {/* Backdrop - Issue #104: skip onClick if disableClose is true */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity"
        onClick={disableClose ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative flex min-h-full items-center justify-center p-2 sm:p-4">
        <div
          ref={modalRef}
          className={`relative w-full ${sizeClasses[size]} max-h-[calc(100vh-1rem)] sm:max-h-[calc(100vh-2rem)] flex flex-col bg-white rounded-lg shadow-xl transform transition-all`}
        >
          {/* Header */}
          {(title || showCloseButton) && (
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-200 flex-shrink-0">
              <h3 className="text-base sm:text-lg font-semibold text-gray-900 truncate pr-2">{title}</h3>
              {showCloseButton && (
                <button
                  onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
                >
                  <svg
                    className="w-5 h-5 sm:w-6 sm:h-6"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Content */}
          <div className="px-4 sm:px-6 py-3 sm:py-4 overflow-y-auto flex-1 min-h-0">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
