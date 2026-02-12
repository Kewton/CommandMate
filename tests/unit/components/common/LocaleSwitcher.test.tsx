/**
 * Tests for LocaleSwitcher component
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocaleSwitcher } from '@/components/common/LocaleSwitcher';

// Mock useLocaleSwitch hook
const mockSwitchLocale = vi.fn();
vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({
    currentLocale: 'en',
    switchLocale: mockSwitchLocale,
  }),
}));

describe('LocaleSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render select element with aria-label "Language"', () => {
    render(<LocaleSwitcher />);
    const select = screen.getByLabelText('Language');
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe('SELECT');
  });

  it('should display all supported locale options', () => {
    render(<LocaleSwitcher />);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('English');
    expect(options[1]).toHaveTextContent('日本語');
  });

  it('should have correct values for locale options', () => {
    render(<LocaleSwitcher />);
    const options = screen.getAllByRole('option') as HTMLOptionElement[];
    expect(options[0].value).toBe('en');
    expect(options[1].value).toBe('ja');
  });

  it('should call switchLocale with selected value on change', () => {
    render(<LocaleSwitcher />);
    const select = screen.getByLabelText('Language');
    fireEvent.change(select, { target: { value: 'ja' } });
    expect(mockSwitchLocale).toHaveBeenCalledWith('ja');
  });

  it('should reflect currentLocale as selected value', () => {
    render(<LocaleSwitcher />);
    const select = screen.getByLabelText('Language') as HTMLSelectElement;
    expect(select.value).toBe('en');
  });
});
