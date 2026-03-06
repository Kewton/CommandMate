/**
 * Tests for AgentSettingsPane component
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentSettingsPane } from '@/components/worktree/AgentSettingsPane';
import { CLI_TOOL_IDS, getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AgentSettingsPane', () => {
  const defaultProps = {
    worktreeId: 'test-worktree-id',
    selectedAgents: ['claude', 'codex'] as CLIToolType[],
    onSelectedAgentsChange: vi.fn(),
    vibeLocalModel: null as string | null,
    onVibeLocalModelChange: vi.fn(),
    vibeLocalContextWindow: null as number | null,
    onVibeLocalContextWindowChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render all CLI tool checkboxes', () => {
      render(<AgentSettingsPane {...defaultProps} />);

      for (const toolId of CLI_TOOL_IDS) {
        const displayName = getCliToolDisplayName(toolId);
        const checkbox = screen.getByRole('checkbox', { name: displayName });
        expect(checkbox).toBeDefined();
      }
    });

    it('should check selected agents', () => {
      render(<AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />);

      const claudeCheckbox = screen.getByTestId('agent-checkbox-claude') as HTMLInputElement;
      const codexCheckbox = screen.getByTestId('agent-checkbox-codex') as HTMLInputElement;
      const geminiCheckbox = screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement;

      expect(claudeCheckbox.checked).toBe(true);
      expect(codexCheckbox.checked).toBe(true);
      expect(geminiCheckbox.checked).toBe(false);
    });

    it('should sync checked state when selectedAgents prop changes', () => {
      const { rerender } = render(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      rerender(
        <AgentSettingsPane {...defaultProps} selectedAgents={['gemini', 'vibe-local']} />
      );

      const claudeCheckbox = screen.getByTestId('agent-checkbox-claude') as HTMLInputElement;
      const codexCheckbox = screen.getByTestId('agent-checkbox-codex') as HTMLInputElement;
      const geminiCheckbox = screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement;
      const vibeLocalCheckbox = screen.getByTestId('agent-checkbox-vibe-local') as HTMLInputElement;

      expect(claudeCheckbox.checked).toBe(false);
      expect(codexCheckbox.checked).toBe(false);
      expect(geminiCheckbox.checked).toBe(true);
      expect(vibeLocalCheckbox.checked).toBe(true);
    });

    it('should disable unchecked items when 2 are already selected', () => {
      render(<AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />);

      const geminiCheckbox = screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement;
      const vibeLocalCheckbox = screen.getByTestId('agent-checkbox-vibe-local') as HTMLInputElement;

      expect(geminiCheckbox.disabled).toBe(true);
      expect(vibeLocalCheckbox.disabled).toBe(true);
    });

    it('should not disable checked items when 2 are selected', () => {
      render(<AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />);

      const claudeCheckbox = screen.getByTestId('agent-checkbox-claude') as HTMLInputElement;
      const codexCheckbox = screen.getByTestId('agent-checkbox-codex') as HTMLInputElement;

      expect(claudeCheckbox.disabled).toBe(false);
      expect(codexCheckbox.disabled).toBe(false);
    });

    it('should display CLI tool display names', () => {
      render(<AgentSettingsPane {...defaultProps} />);

      expect(screen.getByText('Claude')).toBeDefined();
      expect(screen.getByText('Codex')).toBeDefined();
      expect(screen.getByText('Gemini')).toBeDefined();
      expect(screen.getByText('Vibe Local')).toBeDefined();
    });

    it('should display section title via i18n', () => {
      render(<AgentSettingsPane {...defaultProps} />);

      expect(screen.getByText('schedule.agentSettings')).toBeDefined();
    });

    it('should display selection guidance via i18n', () => {
      render(<AgentSettingsPane {...defaultProps} />);

      expect(screen.getByText('schedule.selectAgents')).toBeDefined();
    });
  });

  describe('Interaction', () => {
    it('should uncheck a selected agent and not call API (only 1 selected)', () => {
      render(<AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />);

      const claudeCheckbox = screen.getByTestId('agent-checkbox-claude');
      fireEvent.click(claudeCheckbox);

      // Should NOT call API because only 1 agent remains selected
      expect(mockFetch).not.toHaveBeenCalled();
      expect(defaultProps.onSelectedAgentsChange).not.toHaveBeenCalled();
    });

    it('should call API when selecting a new agent to make exactly 2', async () => {
      // Start with only gemini selected (internally after unchecking one from [claude, codex])
      // To test the full flow: uncheck claude from [claude, codex], then check gemini
      const { rerender } = render(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      // Uncheck claude first
      const claudeCheckbox = screen.getByTestId('agent-checkbox-claude');
      fireEvent.click(claudeCheckbox);

      // Now check gemini - this should trigger API call since we'll have 2 selected
      const geminiCheckbox = screen.getByTestId('agent-checkbox-gemini');
      fireEvent.click(geminiCheckbox);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `/api/worktrees/${defaultProps.worktreeId}`,
          expect.objectContaining({
            method: 'PATCH',
            body: expect.any(String),
          })
        );
      });
    });

    it('should not overwrite local checkbox state when selectedAgents prop changes during editing', async () => {
      const { rerender } = render(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      // Uncheck claude -> enters isEditing=true state (only 1 agent selected, no API call)
      const claudeCheckbox = screen.getByTestId('agent-checkbox-claude');
      fireEvent.click(claudeCheckbox);

      // Verify claude is unchecked locally
      expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(true);

      // Simulate polling: parent re-renders with server value (same selectedAgents prop)
      // This should NOT overwrite checkedIds because isEditing=true
      rerender(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      // claude should still be unchecked (editing state preserved)
      expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(true);
    });

    it('should sync checked state with prop after successful API save', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      const { rerender } = render(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      // Uncheck claude -> isEditing=true
      fireEvent.click(screen.getByTestId('agent-checkbox-claude'));

      // Check gemini -> triggers API (2 selected), API success -> isEditing=false
      fireEvent.click(screen.getByTestId('agent-checkbox-gemini'));

      await waitFor(() => {
        expect(defaultProps.onSelectedAgentsChange).toHaveBeenCalledWith(['codex', 'gemini']);
      });

      // After API success + isEditing=false, a new prop change should be synced
      rerender(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'vibe-local']} />
      );

      // Should now sync with the new prop value since isEditing=false
      expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-vibe-local') as HTMLInputElement).checked).toBe(true);
    });

    it('should revert checked state on API failure', async () => {
      const { rerender } = render(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      // Uncheck claude -> isEditing=true
      fireEvent.click(screen.getByTestId('agent-checkbox-claude'));

      // Setup: API will return !ok
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'server error' }) });

      // Check gemini -> triggers API (2 selected), API fails
      fireEvent.click(screen.getByTestId('agent-checkbox-gemini'));

      // Wait for API call to complete and checkedIds to revert
      await waitFor(() => {
        // Reverted to original selectedAgents prop value
        expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement).checked).toBe(false);
      });

      // Verify isEditing is reset to false: a new prop change should now be synced
      rerender(
        <AgentSettingsPane {...defaultProps} selectedAgents={['gemini', 'vibe-local']} />
      );

      expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId('agent-checkbox-vibe-local') as HTMLInputElement).checked).toBe(true);
    });

    it('should revert checked state on network error', async () => {
      const { rerender } = render(
        <AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />
      );

      // Uncheck claude -> isEditing=true
      fireEvent.click(screen.getByTestId('agent-checkbox-claude'));

      // Setup: fetch will throw network error
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Check gemini -> triggers API (2 selected), fetch throws
      fireEvent.click(screen.getByTestId('agent-checkbox-gemini'));

      // Wait for error handling to complete and checkedIds to revert
      await waitFor(() => {
        // Reverted to original selectedAgents prop value
        expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement).checked).toBe(false);
      });

      // Verify isEditing is reset to false: a new prop change should now be synced
      rerender(
        <AgentSettingsPane {...defaultProps} selectedAgents={['gemini', 'vibe-local']} />
      );

      expect((screen.getByTestId('agent-checkbox-claude') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-codex') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByTestId('agent-checkbox-gemini') as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId('agent-checkbox-vibe-local') as HTMLInputElement).checked).toBe(true);
    });

    it('should not use dangerouslySetInnerHTML', () => {
      const { container } = render(<AgentSettingsPane {...defaultProps} />);
      // Check that no element has dangerouslySetInnerHTML by looking for __html attribute
      const allElements = container.querySelectorAll('*');
      allElements.forEach((el) => {
        // React sets innerHTML when dangerouslySetInnerHTML is used
        // We check that display names are rendered as text content, not HTML
        expect(el.getAttribute('dangerouslysetinnerhtml')).toBeNull();
      });
    });
  });

  describe('Context window input', () => {
    const vibeLocalProps = {
      ...defaultProps,
      selectedAgents: ['claude', 'vibe-local'] as CLIToolType[],
      vibeLocalContextWindow: null as number | null,
      onVibeLocalContextWindowChange: vi.fn(),
    };

    beforeEach(() => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ models: [] }) })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    });

    it('should render context window input when vibe-local is selected', async () => {
      render(<AgentSettingsPane {...vibeLocalProps} />);
      await waitFor(() => {
        expect(screen.getByTestId('vibe-local-context-window-input')).toBeDefined();
      });
    });

    it('should allow free typing without triggering API calls', async () => {
      render(<AgentSettingsPane {...vibeLocalProps} />);
      await waitFor(() => {
        expect(screen.getByTestId('vibe-local-context-window-input')).toBeDefined();
      });

      const input = screen.getByTestId('vibe-local-context-window-input') as HTMLInputElement;
      // Clear previous fetch calls from Ollama models
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      // Type partial values - should NOT call API
      fireEvent.change(input, { target: { value: '8' } });
      expect(input.value).toBe('8');
      expect(mockFetch).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: '81' } });
      expect(input.value).toBe('81');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should call API on blur with valid value', async () => {
      render(<AgentSettingsPane {...vibeLocalProps} />);
      await waitFor(() => {
        expect(screen.getByTestId('vibe-local-context-window-input')).toBeDefined();
      });

      const input = screen.getByTestId('vibe-local-context-window-input') as HTMLInputElement;
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      fireEvent.change(input, { target: { value: '8192' } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `/api/worktrees/${vibeLocalProps.worktreeId}`,
          expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ vibeLocalContextWindow: 8192 }),
          })
        );
      });
    });

    it('should send null when input is cleared and blurred', async () => {
      render(<AgentSettingsPane {...vibeLocalProps} vibeLocalContextWindow={8192} />);
      await waitFor(() => {
        expect(screen.getByTestId('vibe-local-context-window-input')).toBeDefined();
      });

      const input = screen.getByTestId('vibe-local-context-window-input') as HTMLInputElement;
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `/api/worktrees/${vibeLocalProps.worktreeId}`,
          expect.objectContaining({
            body: JSON.stringify({ vibeLocalContextWindow: null }),
          })
        );
      });
    });

    it('should not call API on blur if value has not changed', async () => {
      render(<AgentSettingsPane {...vibeLocalProps} vibeLocalContextWindow={null} />);
      await waitFor(() => {
        expect(screen.getByTestId('vibe-local-context-window-input')).toBeDefined();
      });

      const input = screen.getByTestId('vibe-local-context-window-input');
      mockFetch.mockClear();

      // Blur without changing value
      fireEvent.blur(input);

      // Wait a tick and verify no API call
      await new Promise(r => setTimeout(r, 50));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should revert input on API failure', async () => {
      render(<AgentSettingsPane {...vibeLocalProps} vibeLocalContextWindow={4096} />);
      await waitFor(() => {
        expect(screen.getByTestId('vibe-local-context-window-input')).toBeDefined();
      });

      const input = screen.getByTestId('vibe-local-context-window-input') as HTMLInputElement;
      mockFetch.mockClear();
      mockFetch.mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: 'invalid' }) });

      fireEvent.change(input, { target: { value: '50' } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(input.value).toBe('4096');
      });
    });
  });

  describe('Loading state', () => {
    it('should show loading indicator during API call', async () => {
      // Make fetch hang to test loading state
      let resolveFetch: (value: unknown) => void;
      mockFetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

      render(<AgentSettingsPane {...defaultProps} selectedAgents={['claude', 'codex']} />);

      // Uncheck claude
      fireEvent.click(screen.getByTestId('agent-checkbox-claude'));
      // Check gemini to trigger API
      fireEvent.click(screen.getByTestId('agent-checkbox-gemini'));

      // Loading indicator should be visible
      await waitFor(() => {
        expect(screen.getByTestId('agent-settings-loading')).toBeDefined();
      });

      // Resolve the fetch
      resolveFetch!({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });
  });
});
