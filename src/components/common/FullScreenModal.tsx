/**
 * FullScreenModal Component
 * Issue #825: Schedules UX Phase 2
 *
 * A mobile-oriented layout shell that renders a full-screen modal (slide up from
 * the bottom, close button at the top-right) with an optional sticky footer that
 * stays pinned above the on-screen keyboard.
 *
 * Layout: header (flex-shrink-0) / scrollable content (flex-1) / sticky footer
 * (flex-shrink-0). The container height tracks `window.visualViewport` so the
 * footer remains visible when the mobile keyboard shrinks the visible area, and
 * focused inputs are scrolled into view so they are never hidden by the keyboard.
 */

'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';

export interface FullScreenModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Sticky footer pinned to the bottom of the viewport, above the mobile keyboard. */
  footer?: React.ReactNode;
  showCloseButton?: boolean;
}

export function FullScreenModal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  showCloseButton = true,
}: FullScreenModalProps) {
  // Track the visual viewport so the sticky footer stays above the mobile keyboard.
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  // Close on Escape key.
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Prevent body scroll while the modal is open.
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

  // Follow the visual viewport so the keyboard never overlaps the sticky footer.
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewportHeight(vv.height);
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, [isOpen]);

  // Reveal a focused input above the keyboard (some mobile browsers do not do this).
  const handleFocusCapture = (e: React.FocusEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el && typeof el.scrollIntoView === 'function') {
      window.requestAnimationFrame(() => {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      data-testid="full-screen-modal"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 flex flex-col bg-surface animate-slide-up"
      style={{
        zIndex: Z_INDEX.MODAL,
        height: viewportHeight ? `${viewportHeight}px` : '100dvh',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <h3 className="text-base font-semibold text-foreground truncate pr-2">
          {title}
        </h3>
        {showCloseButton && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="full-screen-modal-close"
            className="flex-shrink-0 -mr-1 p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        )}
      </div>

      {/* Scrollable content */}
      <div
        data-testid="full-screen-modal-body"
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4"
        onFocusCapture={handleFocusCapture}
      >
        {children}
      </div>

      {/* Sticky footer */}
      {footer && (
        <div
          data-testid="full-screen-modal-footer"
          className="flex-shrink-0 border-t border-border bg-surface px-4 py-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {footer}
        </div>
      )}
    </div>,
    document.body,
  );
}

export default FullScreenModal;
