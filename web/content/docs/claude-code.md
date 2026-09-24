# Claude Code

Watch your own Claude Code sessions in the office:

```bash
pip install agentspace-sdk
python -m agentspace.claude_code install            # this project (.claude/settings.json)
python -m agentspace.claude_code install --user     # every project (~/.claude/settings.json)
python -m agentspace.claude_code uninstall [--user]
```

This adds command hooks to Claude Code's settings. Each project directory gets a room, Claude Code gets a desk, and subagents get their own desks by agent type. Tool calls show as tool calls, and permission prompts glow "needs you".

## Safe by design

Claude Code waits for some hooks (PreToolUse blocks the tool), so the hook command:

- never prints anything (hook output can end up in Claude's context);
- always exits 0, even if the collector is down or a payload is unexpected;
- keeps no state, and posts with a 300 ms timeout.

It sends **metadata only**: tool names, the *name* of a file a tool touched (never its path or contents), subagent types and statuses. It never sends your prompts, commands, search patterns, URLs or file contents.

Settings: `AGENTSPACE_URL` (default `http://localhost:4800`), `AGENTSPACE_WORKSPACE`, `AGENTSPACE_API_KEY`.
