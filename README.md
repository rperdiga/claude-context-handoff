# context-handoff

A Claude Code mod. When the context window passes a threshold (default 70%) it pauses the turn, writes a handoff file under `.claude/handoffs/`, copies a continue prompt to the clipboard, and offers to continue in a fresh session (`/clear` + the prompt).

Commands: `/handoff` (hand off now), `/handoff-continue`, `/handoff-off` (disable the automatic trigger for this session, e.g. unattended runs), `/handoff-on`.

Settings (`userConfig`): `threshold`, `mode` (`ask` | `auto` | `clipboard`), `folder`.

## Install

In a terminal Claude Code session:

```
/plugin install context-handoff --marketplace rperdiga/claude-context-handoff
```

Answer `y` to add the marketplace and pick the user scope. It then loads in every session on that machine, including the desktop app's Code tab.
