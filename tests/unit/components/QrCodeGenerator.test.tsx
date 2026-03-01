/**
 * Unit tests for QrCodeGenerator component
 * Issue #383: QR code login for mobile access via ngrok
 *
 * Tests QR code generation UI with security features
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QrCodeGenerator } from '@/components/auth/QrCodeGenerator';

// Mock react-qr-code
vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value}>
      QR Code
    </div>
  ),
}));

describe('QrCodeGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render section title', () => {
    render(<QrCodeGenerator />);

    expect(screen.getByText('auth.login.qr.sectionTitle')).toBeInTheDocument();
  });

  it('should render security notice', () => {
    render(<QrCodeGenerator />);

    expect(screen.getByText('auth.login.qr.securityNotice')).toBeInTheDocument();
  });

  it('should not show QR code by default even with URL and token input', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });

    // QR code should NOT be visible by default (S001: shoulder surfing protection)
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
  });

  it('should show QR code when "Show QR Code" button is clicked', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });

    const showButton = screen.getByText('auth.login.qr.showQrButton');
    fireEvent.click(showButton);

    expect(screen.getByTestId('qr-code')).toBeInTheDocument();
    expect(screen.getByTestId('qr-code')).toHaveAttribute(
      'data-value',
      'https://example.ngrok-free.app/login#token=mytoken'
    );
  });

  it('should hide QR code when "Hide QR Code" button is clicked', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });

    // Show QR code
    fireEvent.click(screen.getByText('auth.login.qr.showQrButton'));
    expect(screen.getByTestId('qr-code')).toBeInTheDocument();

    // Hide QR code
    fireEvent.click(screen.getByText('auth.login.qr.hideQrButton'));
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
  });

  it('should show security warning when QR code is visible', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });

    // Warning should not be visible before showing QR
    expect(screen.queryByText('auth.login.qr.qrSecurityWarning')).not.toBeInTheDocument();

    // Show QR code
    fireEvent.click(screen.getByText('auth.login.qr.showQrButton'));

    expect(screen.getByText('auth.login.qr.qrSecurityWarning')).toBeInTheDocument();
  });

  it('should show HTTPS warning when HTTP URL is entered', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    fireEvent.change(urlInput, { target: { value: 'http://example.ngrok-free.app' } });

    expect(screen.getByText('auth.login.qr.httpsWarning')).toBeInTheDocument();
  });

  it('should not show HTTPS warning when HTTPS URL is entered', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });

    expect(screen.queryByText('auth.login.qr.httpsWarning')).not.toBeInTheDocument();
  });

  it('should not show show/hide button when URL or token is empty', () => {
    render(<QrCodeGenerator />);

    // Neither input has value
    expect(screen.queryByText('auth.login.qr.showQrButton')).not.toBeInTheDocument();
    expect(screen.queryByText('auth.login.qr.hideQrButton')).not.toBeInTheDocument();

    // Only URL is filled
    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });

    expect(screen.queryByText('auth.login.qr.showQrButton')).not.toBeInTheDocument();
  });

  it('should render URL and token input fields', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    expect(urlInput).toBeInTheDocument();
    expect(urlInput).toHaveAttribute('type', 'url');
    expect(tokenInput).toBeInTheDocument();
    expect(tokenInput).toHaveAttribute('type', 'password');
  });

  it('should reset QR visibility when inputs change (S001 bypass prevention)', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    // Enter values and show QR
    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });
    fireEvent.click(screen.getByText('auth.login.qr.showQrButton'));
    expect(screen.getByTestId('qr-code')).toBeInTheDocument();

    // Change token - QR should be hidden again
    fireEvent.change(tokenInput, { target: { value: 'newtoken' } });
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
  });

  it('should strip trailing slash from URL', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app/' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });
    fireEvent.click(screen.getByText('auth.login.qr.showQrButton'));

    const qrCode = screen.getByTestId('qr-code');
    expect(qrCode).toHaveAttribute(
      'data-value',
      'https://example.ngrok-free.app/login#token=mytoken'
    );
  });

  it('should encode token in QR code URL', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app' } });
    fireEvent.change(tokenInput, { target: { value: 'my secret token' } });

    fireEvent.click(screen.getByText('auth.login.qr.showQrButton'));

    const qrCode = screen.getByTestId('qr-code');
    expect(qrCode).toHaveAttribute(
      'data-value',
      'https://example.ngrok-free.app/login#token=my%20secret%20token'
    );
  });

  it('should not generate a QR code for an invalid URL', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'not-a-url' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });

    expect(screen.queryByText('auth.login.qr.showQrButton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('qr-code')).not.toBeInTheDocument();
  });

  it('should avoid appending /login twice when the login URL is already provided', () => {
    render(<QrCodeGenerator />);

    const urlInput = screen.getByLabelText('auth.login.qr.urlLabel');
    const tokenInput = screen.getByLabelText('auth.login.qr.tokenLabel');

    fireEvent.change(urlInput, { target: { value: 'https://example.ngrok-free.app/login' } });
    fireEvent.change(tokenInput, { target: { value: 'mytoken' } });
    fireEvent.click(screen.getByText('auth.login.qr.showQrButton'));

    expect(screen.getByTestId('qr-code')).toHaveAttribute(
      'data-value',
      'https://example.ngrok-free.app/login#token=mytoken'
    );
  });
});
