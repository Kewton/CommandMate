/**
 * Unit tests for FeedbackSection component
 * Issue #264: User feedback links
 *
 * [SF-IMP-005] i18n mock follows version-section.test.tsx pattern.
 * [SEC-SF-003] Verifies URL immutability from github-links.ts constants.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeedbackSection } from '@/components/worktree/FeedbackSection';
import {
  GITHUB_BUG_REPORT_URL,
  GITHUB_FEATURE_REQUEST_URL,
  GITHUB_QUESTION_URL,
  GITHUB_ISSUES_URL,
} from '@/config/github-links';

describe('FeedbackSection', () => {
  it('should render feedback section with title', () => {
    render(<FeedbackSection />);

    expect(screen.getByText('worktree.feedback.title')).toBeDefined();
  });

  it('should render all four feedback links', () => {
    render(<FeedbackSection />);

    expect(screen.getByText('worktree.feedback.bugReport')).toBeDefined();
    expect(screen.getByText('worktree.feedback.featureRequest')).toBeDefined();
    expect(screen.getByText('worktree.feedback.question')).toBeDefined();
    expect(screen.getByText('worktree.feedback.viewIssues')).toBeDefined();
  });

  it('should link to correct GitHub URLs [SEC-SF-003]', () => {
    render(<FeedbackSection />);

    const links = screen.getAllByRole('link');
    const hrefs = links.map(link => link.getAttribute('href'));

    expect(hrefs).toContain(GITHUB_BUG_REPORT_URL);
    expect(hrefs).toContain(GITHUB_FEATURE_REQUEST_URL);
    expect(hrefs).toContain(GITHUB_QUESTION_URL);
    expect(hrefs).toContain(GITHUB_ISSUES_URL);
  });

  it('should have rel="noopener noreferrer" on all links', () => {
    render(<FeedbackSection />);

    const links = screen.getAllByRole('link');
    links.forEach(link => {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });
  });

  it('should have target="_blank" on all links', () => {
    render(<FeedbackSection />);

    const links = screen.getAllByRole('link');
    links.forEach(link => {
      expect(link.getAttribute('target')).toBe('_blank');
    });
  });

  it('should apply className prop [CONS-005]', () => {
    render(<FeedbackSection className="bg-gray-50 rounded-lg p-4" />);

    const section = screen.getByTestId('feedback-section');
    expect(section.className).toContain('bg-gray-50');
    expect(section.className).toContain('rounded-lg');
    expect(section.className).toContain('p-4');
  });

  it('should render without className prop', () => {
    render(<FeedbackSection />);

    const section = screen.getByTestId('feedback-section');
    expect(section).toBeDefined();
  });
});
