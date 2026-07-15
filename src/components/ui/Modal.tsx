/**
 * Modal Component
 * A reusable modal dialog component
 */

'use client';

import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { cva } from 'class-variance-authority';
import { Z_INDEX } from '@/config/z-index';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';
import { useExitAnimation } from '@/hooks/useExitAnimation';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { cn } from '@/lib/utils/cn';

const modalSizeVariants = cva('', {
  variants: {
    size: {
      sm: 'max-w-[calc(100vw-2rem)] sm:max-w-md',
      md: 'max-w-[calc(100vw-2rem)] sm:max-w-2xl',
      lg: 'max-w-[calc(100vw-2rem)] sm:max-w-4xl',
      xl: 'max-w-[calc(100vw-2rem)] sm:max-w-6xl',
      full: 'max-w-[calc(100vw-2rem)] sm:max-w-[95vw]',
    },
  },
  defaultVariants: {
    size: 'lg',
  },
});

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
  const titleId = useId();

  // [Issue #1127] Trap keyboard focus inside the dialog while it is open (Tab
  // cycling, initial focus, focus restore on close). Engaged on `isOpen` — not
  // `shouldRender` — so focus returns to the opener the moment closing begins,
  // even while the exit animation keeps the panel mounted.
  const modalRef = useFocusTrap<HTMLDivElement>({ active: isOpen });

  // [Issue #1114] Keep the modal mounted for the exit window so the
  // data-[state=closed] fade/zoom-out animation can play before unmount.
  const { shouldRender, isExiting } = useExitAnimation(
    isOpen,
    EXIT_ANIMATION_DURATION_MS
  );
  const dataState = isExiting ? 'closed' : 'open';

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

  if (!shouldRender) return null;

  // Use portal to render at document.body level, escaping any parent stacking context
  return createPortal(
    <div className="fixed inset-0 overflow-y-auto" style={{ zIndex: Z_INDEX.MODAL }}>
      {/* Backdrop - Issue #104: skip onClick if disableClose is true */}
      {/* [Issue #1050/#1114] data-state drives the fade enter/exit animations. */}
      <div
        data-state={dataState}
        className="fixed inset-0 bg-black bg-opacity-50 transition-opacity data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-200 data-[state=closed]:fill-mode-forwards"
        onClick={disableClose || isExiting ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative flex min-h-full items-center justify-center p-2 sm:p-4">
        <div
          ref={modalRef}
          data-state={dataState}
          data-testid="modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={cn(
            'relative w-full',
            modalSizeVariants({ size }),
            'max-h-[calc(100vh-1rem)] sm:max-h-[calc(100vh-2rem)] flex flex-col bg-surface rounded-lg shadow-xl transform transition-all',
            // [Issue #1050] fade + scale enter on mount. Runs once per open
            // (the panel unmounts after the exit window), so parent re-renders
            // do not re-fire the animation.
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-200',
            // [Issue #1114] fade + scale exit while data-state="closed"
            // (useExitAnimation keeps the panel mounted for the 200ms window).
            // fill-mode-forwards holds the invisible end state until unmount.
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-200 data-[state=closed]:fill-mode-forwards'
          )}
        >
          {/* Header */}
          {(title || showCloseButton) && (
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-border flex-shrink-0">
              <h3 id={titleId} className="text-base sm:text-lg font-semibold text-foreground truncate pr-2">{title}</h3>
              {showCloseButton && (
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 touch-manipulation"
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
