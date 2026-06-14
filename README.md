# pi-cmux

Pi extension for [cmux](https://www.cmux.dev) terminal integration — notifications, sidebar status, splits, and workflow commands.

## Install

```bash
pi install github:jtdelia/pi-cmux
```

Or load for development:

```bash
pi -e ~/dev/pi-cmux/extensions/index.ts
```

If Pi is already running:

```
/reload
```

## Requirements

- [cmux](https://cmux.app) (macOS app) installed
- Pi running inside a cmux workspace (the extension is a no-op otherwise)

## Commands

| Command | Description |
|---|---|
| `/cmv [prompt]` | Open a right split with a fresh pi session |
| `/cmh [prompt]` | Open a lower split with a fresh pi session |
| `/cmo <cmd>` | Run a shell command in a right split |
| `/cmoh <cmd>` | Run a shell command in a lower split |
| `/cmt <cmd>` | Run a shell command in a new tab |
| `/cmz <query>` | Zoxide jump + pi in a right split |
| `/cmzh <query>` | Zoxide jump + pi in a lower split |
| `/cmcv [note]` | Continue current task in a right split |
| `/cmch [note]` | Continue current task in a lower split |
| `/cmcv -c <branch> [--from <ref>] [note]` | Continue in a new git worktree |
| `/cmrv [--bugs\|--refactor\|--tests\|--diff] [target]` | Code review in a right split |
| `/cmrh [--bugs\|--refactor\|--tests\|--diff] [target]` | Code review in a lower split |

## Automatic features

| Feature | What happens |
|---|---|
| **Sidebar status** | Shows "Pi running" / tool name / "Pi done" / "Pi error" with colored icons |
| **Progress bar** | Animated progress based on turns and tool calls |
| **Token tracking** | Live token usage in the progress label (↑input +cache ↓output) |
| **Notifications** | Desktop notification when Pi finishes or errors |
| **Flash** | cmux surface flash on completion |
| **Log** | cmux log entries for run start, file changes, errors |

## Agent Tool

The extension registers a `cmux_open_terminal` tool that the LLM can call when you ask it to open something in a split, tab, or pane. Example: "open k9s in a new tab".

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_CMUX_NOTIFY_LEVEL` | `all` | `all`, `medium`, `low`, or `disabled` |
| `PI_CMUX_NOTIFY_THRESHOLD_MS` | `15000` | Duration threshold for "Task Complete" vs "Waiting" |
| `PI_CMUX_SIDEBAR` | `1` | Set `0` to disable sidebar |
| `PI_CMUX_SIDEBAR_PROGRESS` | `1` | Set `0` to disable progress bar |
| `PI_CMUX_SIDEBAR_TOKENS` | `1` | Set `0` to disable token tracking |
| `PI_CMUX_SIDEBAR_COST` | `0` | Set `1` to show model cost |
| `PI_CMUX_SIDEBAR_FLASH` | `all` | `all`, `error`, or `disabled` |
| `PI_CMUX_SIDEBAR_LOG_TOOLS` | `0` | Set `1` to log every tool call |

### Custom split shortcuts

Add to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "pi-cmux": {
    "commands": {
      "ck": {
        "run": "hunk diff --agent-notes --watch",
        "acceptArgs": true,
        "description": "Open Hunk diff in a split"
      },
      "lg": "lazygit"
    }
  }
}
```

Then use `/ck` or `/lg` in pi.

## Credits

Inspired by:
- [opencode-cmux](https://github.com/0xCaso/opencode-cmux) by Matteo Casonato
- [pi-cmux](https://github.com/javiermolinar/pi-cmux) by Javi Molina

## License

MIT
