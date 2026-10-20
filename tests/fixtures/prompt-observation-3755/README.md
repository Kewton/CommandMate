# prompt-observation-3755 — frames for the prompt observation (Issue #3755)

Read by `tests/unit/lib/prompt-observation/*.test.ts`. The directory name does
not start with a tool id on purpose: the dialog-gate suites
(`tests/unit/polling/auto-yes-dialog-gate.test.ts`,
`dialog-presence-gate-2457.test.ts`) walk every `<tool>-*` directory as live
corpus, and these frames are not all live captures.

| file | what it is | provenance |
|---|---|---|
| `antigravity-trust.txt` | agy's folder trust screen (`Accessing workspace:` … `Do you trust the contents of this project?` … `> Yes, I trust this folder` / `No, exit` / `↑/↓ Navigate · enter Confirm`) | The pane Issue #3746 recorded (`commandmate capture … --pane`, 2026-10-17), as quoted in its body. ANSI is not in the quote, so there is none here; the home directory's user name is replaced with `agy-user`. Every other row is verbatim. |
| `antigravity-working.txt` | agy generating, no screen open (the "no confirmation" control) | **Constructed** from the rows of `antigravity-live-2364/dialog-bash-oneline.txt` and agy's thinking footer (`ANTIGRAVITY_THINKING_PATTERN`). Not a live capture; it stands for "a frame with no `↑/↓ Navigate` footer", which is all the suites need of it. |

The other agy screens the suites read are the live captures of
`tests/fixtures/antigravity-live-2364/` (permission dialogs, the `/model`
picker, the slash popup, the idle composer, and a second trust screen).
