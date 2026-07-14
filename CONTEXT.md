# Domain Context

## Terms

### Timestamp refinement

An explicit per-file action that replaces Gemini's estimated playback timing with Scribe timing while preserving the latest transcript text.

- Default: every new transcript uses Gemini timing only.
- Trigger: the owner chooses `Refine timestamps` from that file's dashboard menu.
- Excludes: global settings, AI speed mode, summary, and transcript wording.
