/**
 * Tests for Toast component
 *
 * Tests toast notifications with success/error display, auto-dismiss, and manual close
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Toast, ToastContainer, useToast } from '@/components/common/Toast';
import type { ToastType } from '@/types/markdown-editor';

// Helper component to test useToast hook
function TestComponent() {
  const { showToast, toasts, removeToast } = useToast();

  return (
    <div>
      <button
        data-testid="show-success"
        onClick={() => showToast('Success message', 'success')}
      >
        Show Success
      </button>
      <button
        data-testid="show-error"
        onClick={() => showToast('Error message', 'error')}
      >
        Show Error
      </button>
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </div>
  );
}

describe('Toast Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Toast rendering', () => {
    it('should render success toast with green styling', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-1"
          message="Success message"
          type="success"
          onClose={mockOnClose}
        />
      );

      const toast = screen.getByTestId('toast-test-1');
      expect(toast).toBeInTheDocument();
      expect(toast).toHaveTextContent('Success message');
      expect(toast).toHaveClass('bg-green-50');
    });

    it('should render error toast with red styling', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-2"
          message="Error message"
          type="error"
          onClose={mockOnClose}
        />
      );

      const toast = screen.getByTestId('toast-test-2');
      expect(toast).toBeInTheDocument();
      expect(toast).toHaveTextContent('Error message');
      expect(toast).toHaveClass('bg-red-50');
    });

    it('should render info toast with blue styling', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-3"
          message="Info message"
          type="info"
          onClose={mockOnClose}
        />
      );

      const toast = screen.getByTestId('toast-test-3');
      expect(toast).toBeInTheDocument();
      expect(toast).toHaveTextContent('Info message');
      expect(toast).toHaveClass('bg-blue-50');
    });

    it('should display success icon for success toast', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-icon-success"
          message="Success"
          type="success"
          onClose={mockOnClose}
        />
      );

      expect(screen.getByTestId('toast-icon-success')).toBeInTheDocument();
    });

    it('should display error icon for error toast', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-icon-error"
          message="Error"
          type="error"
          onClose={mockOnClose}
        />
      );

      expect(screen.getByTestId('toast-icon-error')).toBeInTheDocument();
    });

    it('should display info icon for info toast', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-icon-info"
          message="Info"
          type="info"
          onClose={mockOnClose}
        />
      );

      expect(screen.getByTestId('toast-icon-info')).toBeInTheDocument();
    });
  });

  describe('Close button', () => {
    it('should render close button', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-close"
          message="Test message"
          type="success"
          onClose={mockOnClose}
        />
      );

      expect(screen.getByTestId('toast-close-button')).toBeInTheDocument();
    });

    it('should call onClose when close button is clicked', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-close-click"
          message="Test message"
          type="success"
          onClose={mockOnClose}
        />
      );

      fireEvent.click(screen.getByTestId('toast-close-button'));
      expect(mockOnClose).toHaveBeenCalledWith('test-close-click');
    });

    it('should have accessible aria-label on close button', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-aria"
          message="Test message"
          type="success"
          onClose={mockOnClose}
        />
      );

      const closeButton = screen.getByTestId('toast-close-button');
      expect(closeButton).toHaveAttribute('aria-label', 'Close notification');
    });
  });

  describe('Auto-dismiss', () => {
    it('should auto-dismiss after 3 seconds by default', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-auto-dismiss"
          message="Auto dismiss test"
          type="success"
          onClose={mockOnClose}
        />
      );

      expect(mockOnClose).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(mockOnClose).toHaveBeenCalledWith('test-auto-dismiss');
    });

    it('should auto-dismiss after custom duration', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-custom-duration"
          message="Custom duration test"
          type="success"
          onClose={mockOnClose}
          duration={5000}
        />
      );

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(mockOnClose).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(mockOnClose).toHaveBeenCalledWith('test-custom-duration');
    });

    it('should not auto-dismiss when duration is 0', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-no-auto-dismiss"
          message="No auto dismiss"
          type="success"
          onClose={mockOnClose}
          duration={0}
        />
      );

      act(() => {
        vi.advanceTimersByTime(10000);
      });

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('should clear timeout on unmount', () => {
      const mockOnClose = vi.fn();
      const { unmount } = render(
        <Toast
          id="test-unmount"
          message="Unmount test"
          type="success"
          onClose={mockOnClose}
        />
      );

      unmount();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('ToastContainer', () => {
    it('should render multiple toasts', () => {
      const mockOnClose = vi.fn();
      const toasts = [
        { id: 'toast-1', message: 'First toast', type: 'success' as ToastType },
        { id: 'toast-2', message: 'Second toast', type: 'error' as ToastType },
        { id: 'toast-3', message: 'Third toast', type: 'info' as ToastType },
      ];

      render(<ToastContainer toasts={toasts} onClose={mockOnClose} />);

      expect(screen.getByTestId('toast-toast-1')).toBeInTheDocument();
      expect(screen.getByTestId('toast-toast-2')).toBeInTheDocument();
      expect(screen.getByTestId('toast-toast-3')).toBeInTheDocument();
    });

    it('should render empty container when no toasts', () => {
      const mockOnClose = vi.fn();
      render(<ToastContainer toasts={[]} onClose={mockOnClose} />);

      const container = screen.getByTestId('toast-container');
      expect(container).toBeInTheDocument();
      expect(container.children).toHaveLength(0);
    });

    it('should position container at bottom-right', () => {
      const mockOnClose = vi.fn();
      render(<ToastContainer toasts={[]} onClose={mockOnClose} />);

      const container = screen.getByTestId('toast-container');
      expect(container).toHaveClass('fixed');
      expect(container).toHaveClass('bottom-4');
      expect(container).toHaveClass('right-4');
    });

    it('should call onClose with correct id when toast is closed', () => {
      const mockOnClose = vi.fn();
      const toasts = [
        { id: 'toast-close-1', message: 'Test toast', type: 'success' as ToastType },
      ];

      render(<ToastContainer toasts={toasts} onClose={mockOnClose} />);

      fireEvent.click(screen.getByTestId('toast-close-button'));
      expect(mockOnClose).toHaveBeenCalledWith('toast-close-1');
    });
  });

  describe('useToast hook', () => {
    it('should add toast when showToast is called', () => {
      render(<TestComponent />);

      fireEvent.click(screen.getByTestId('show-success'));

      expect(screen.getByText('Success message')).toBeInTheDocument();
    });

    it('should add multiple toasts', () => {
      render(<TestComponent />);

      fireEvent.click(screen.getByTestId('show-success'));
      fireEvent.click(screen.getByTestId('show-error'));

      expect(screen.getByText('Success message')).toBeInTheDocument();
      expect(screen.getByText('Error message')).toBeInTheDocument();
    });

    it('should remove toast when removeToast is called', () => {
      render(<TestComponent />);

      fireEvent.click(screen.getByTestId('show-success'));
      expect(screen.getByText('Success message')).toBeInTheDocument();

      // Click close button
      fireEvent.click(screen.getByTestId('toast-close-button'));

      expect(screen.queryByText('Success message')).not.toBeInTheDocument();
    });

    it('should auto-dismiss toast after 3 seconds', () => {
      render(<TestComponent />);

      fireEvent.click(screen.getByTestId('show-success'));
      expect(screen.getByText('Success message')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(screen.queryByText('Success message')).not.toBeInTheDocument();
    });

    it('should generate unique ids for each toast', () => {
      render(<TestComponent />);

      fireEvent.click(screen.getByTestId('show-success'));
      fireEvent.click(screen.getByTestId('show-success'));

      const toasts = screen.getAllByText('Success message');
      expect(toasts).toHaveLength(2);
    });
  });

  describe('Accessibility', () => {
    it('should have role="alert" for toast', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-role"
          message="Alert message"
          type="success"
          onClose={mockOnClose}
        />
      );

      const toast = screen.getByTestId('toast-test-role');
      expect(toast).toHaveAttribute('role', 'alert');
    });

    it('should have aria-live="polite" for toast container', () => {
      const mockOnClose = vi.fn();
      render(<ToastContainer toasts={[]} onClose={mockOnClose} />);

      const container = screen.getByTestId('toast-container');
      expect(container).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('Animation classes', () => {
    it('should have animation classes for entrance', () => {
      const mockOnClose = vi.fn();
      render(
        <Toast
          id="test-animation"
          message="Animation test"
          type="success"
          onClose={mockOnClose}
        />
      );

      const toast = screen.getByTestId('toast-test-animation');
      expect(toast).toHaveClass('animate-slide-in');
    });
  });
});
