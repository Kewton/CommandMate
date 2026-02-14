/**
 * AI Integration Guide Messages
 * Issue #264: Display AI tool integration guide after init completion
 */

export const AI_INTEGRATION_GUIDE = `
\x1b[1m━━━ AI Tool Integration ━━━\x1b[0m
CommandMate commands can be used from Claude Code or Codex:

  Issue management:
    commandmate issue create --bug --title "Title" --body "Description"
    commandmate issue create --feature --title "Title" --body "Description"
    commandmate issue create --question --title "Question" --body "Details"
    commandmate issue search "keyword"
    commandmate issue list

  Documentation (RAG):
    commandmate docs                    # Show all documentation sections
    commandmate docs --section <name>   # Show specific section
    commandmate docs --search <query>   # Search documentation

  Tip: Add to your CLAUDE.md or system prompt:
    "Use \`commandmate --help\` to see available commands."
\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`;
