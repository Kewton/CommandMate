/**
 * Tests for the codex OSS-enum provider parser (Issue #1489).
 *
 * The fixture mirrors the real codex-rs/tui/src/slash_command.rs shape: a strum
 * enum with `serialize_all = "kebab-case"`, per-variant to_string/serialize
 * overrides, a combined description arm, a multi-line block arm, an internal
 * "DO NOT USE" arm, and a second `match self` block returning non-strings that
 * must not be mistaken for descriptions.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  parseCodexSlashCommandEnum,
  versionFromTag,
  codexEnumRawUrl,
} from '@/lib/slash-command-reconcile/providers/codex';

const FIXTURE = `
use strum_macros::EnumString;

#[derive(Debug, Clone, EnumString, EnumIter)]
#[strum(serialize_all = "kebab-case")]
pub enum SlashCommand {
    // DO NOT ALPHA-SORT! Enum order is presentation order.
    Model,
    DebugConfig,
    #[strum(to_string = "approve")]
    AutoReview,
    #[strum(to_string = "pets", serialize = "pet")]
    Pets,
    #[strum(serialize = "subagents")]
    MultiAgents,
    Quit,
    Exit,
    Ide,
    #[strum(serialize = "debug-m-drop")]
    MemoryDrop,
}

impl SlashCommand {
    pub fn description(self) -> &'static str {
        match self {
            SlashCommand::Model => "choose what model and reasoning effort to use",
            SlashCommand::DebugConfig => "show config layers",
            SlashCommand::AutoReview => "approve one retry of a recent auto-review denial",
            SlashCommand::Pets => "choose or hide the terminal pet",
            SlashCommand::Agent | SlashCommand::MultiAgents => "switch the active agent thread",
            SlashCommand::Quit | SlashCommand::Exit => "exit Codex",
            SlashCommand::Ide => {
                "include current selection, open files, and other context from your IDE"
            }
            SlashCommand::MemoryDrop => "DO NOT USE",
        }
    }

    pub fn available_during_task(self) -> bool {
        match self {
            SlashCommand::Model | SlashCommand::Ide => false,
            SlashCommand::Quit => true,
        }
    }
}
`;

describe('parseCodexSlashCommandEnum', () => {
  const commands = parseCodexSlashCommandEnum(FIXTURE);
  const byName = (name: string) => commands.find((c) => c.name === name);

  it('derives kebab-case names for plain variants', () => {
    expect(byName('model')).toBeDefined();
    expect(byName('debug-config')).toBeDefined();
    expect(byName('ide')).toBeDefined();
  });

  it('applies strum to_string / serialize overrides', () => {
    expect(byName('approve')).toBeDefined(); // AutoReview, to_string
    expect(byName('pets')).toBeDefined(); // to_string wins over serialize alias "pet"
    expect(byName('pet')).toBeUndefined();
    expect(byName('subagents')).toBeDefined(); // MultiAgents, serialize
  });

  it('drops variants marked "DO NOT USE"', () => {
    expect(byName('debug-m-drop')).toBeUndefined();
    expect(commands.map((c) => c.name)).toEqual([
      'model',
      'debug-config',
      'approve',
      'pets',
      'subagents',
      'quit',
      'exit',
      'ide',
    ]);
  });

  it('maps descriptions, including combined and multi-line block arms', () => {
    expect(byName('model')?.description).toBe('choose what model and reasoning effort to use');
    expect(byName('subagents')?.description).toBe('switch the active agent thread');
    expect(byName('quit')?.description).toBe('exit Codex');
    expect(byName('exit')?.description).toBe('exit Codex');
    expect(byName('ide')?.description).toBe(
      'include current selection, open files, and other context from your IDE'
    );
  });

  it('does not treat a non-string match arm as a description', () => {
    // `available_during_task` returns bool; model must keep its real description.
    expect(byName('model')?.description).not.toBe('false');
  });

  it('returns an empty array when the enum is absent (never throws)', () => {
    expect(parseCodexSlashCommandEnum('no enum here')).toEqual([]);
    expect(parseCodexSlashCommandEnum('')).toEqual([]);
  });
});

describe('codex helpers', () => {
  it('extracts a semver from a release tag', () => {
    expect(versionFromTag('rust-v0.145.0')).toBe('0.145.0');
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('nightly')).toBeUndefined();
  });

  it('builds the pinned raw URL for a ref', () => {
    expect(codexEnumRawUrl('rust-v0.145.0')).toBe(
      'https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/tui/src/slash_command.rs'
    );
  });
});
