# Quox

The conversational front door to your self-hosted AI agent control plane. The `quoxcli` package gives you the `quox` command: a conversational terminal and a command line for QuoxCORE.

It is a client. It does not include the server.

## Install

```sh
npm install -g quoxcli
```

Needs Node.js 20 or later. This installs two commands: `quox`, and `quoxon` (an alias that opens the conversation).

## Prerequisite: a running QuoxCORE

You need a QuoxCORE instance to talk to. Install one on a machine you control: see https://github.com/quoxai/quoxcore, or run:

```sh
curl -fsSL https://get.quox.ai | sh
```

A built-in `quox server install` is coming. It does not exist yet.

## Sign in

```sh
quox login
```

You will be asked for the address of your QuoxCORE and your credentials. Use `-p <name>` to keep several profiles (for example a dev box and a production box):

```sh
quox login -p work
quox -p work whoami
quox -p work
```

If you do not pass `-p`, Quox picks your human profile automatically. It never falls back to an ambient service key from your environment unless you pass `--service-key`.

## Talk

```sh
quox
```

Bare `quox` opens the conversation. `quoxon` is an alias for the same thing. The older menu is still there as `quox tui`.

Type what you want. Quox routes it to the right agent and shows what it is doing, including any tool that is held for your approval.

| Key | What it does |
|-----|--------------|
| Enter | Send. While Quox is working, steer the running turn. |
| Tab | Queue the message to send after the current turn. |
| Esc | Stop the turn. Quox waits for the server to confirm it stopped. |
| Ctrl+C | Press twice to quit. |
| Ctrl+J | New line in the draft. |
| Ctrl+G | Edit the draft in your editor. |
| `/help` | List every key and command. |

`quox --demo` runs a simulated session with no server, so you can look around first. Nothing real runs.

### Approvals

When a tool is held for your approval, act on it with an empty draft, or press Tab. Approvals are never a single key while you are typing, so a stray keystroke cannot approve anything. `/approvals` lists what is waiting.

### Project rules: QUOX.md

Put a `QUOX.md` in your project and Quox follows it. It is read from the current directory up to the git root, plus `~/.quox/QUOX.md` for rules that apply everywhere. Rules are capped at 5500 characters in total.

| Command | What it does |
|---------|--------------|
| `/rules` | Show which rules are loaded |
| `/rules off` | Turn rules off for this session |

### Skills

`/skills` lists the governed skills available to you. `/skill <name>` runs one.

### Running work

Workflows and loops that are running appear in a roster under the status line. `/roster` shows it in full, and `/observers` shows what is watching.

## Headless

```sh
quox --print "summarise what happened on the fleet today"
echo "check the approvals queue" | quox --print
quox --print "list my agents" --output json
```

`--output json` writes one event per line. Other flags: `--conversation <id>`, `--turn-id <id>`, `--timeout <seconds>`.

| Exit code | Meaning |
|-----------|---------|
| 0 | Completed |
| 1 | Error |
| 2 | Held for approval |
| 3 | Interrupted |
| 4 | Not signed in, or identity problem |
| 5 | Ended without confirmation |

## Everyday commands

Run `quox --help` for the full list, and `quox <command> --help` for each one.

| Command | What it does |
|---------|--------------|
| `quox login` / `logout` / `whoami` | Sign in, sign out, show who you are |
| `quox status` | Platform health overview |
| `quox doctor` | Run diagnostics on the CLI and the platform |
| `quox chat "<message>"` | Chat with CommanderQ or any agent |
| `quox agent` | Manage agents |
| `quox workflow` | Manage workflows |
| `quox fleet` | Fleet monitoring and management |
| `quox memory` | Manage memories |
| `quox approvals` | Tool approvals held for a human decision |
| `quox inbox` | Inbox and approval requests |
| `quox mail` | InboxQ: connected mail accounts and triaged messages |
| `quox calendar` | Calendar-Q: agenda and coverage |
| `quox governance` | Policies, the WARD chain and evidence |
| `quox config` | CLI configuration and profiles |

Global options include `--json`, `-p/--profile`, `--org`, `--dry-run`, `-y/--yes` and `--debug`.

## Troubleshooting

**Self-signed certificate (`fetch failed`).** If your QuoxCORE uses its own certificate authority, point Node at the certificate. Do not turn TLS checking off.

```sh
export NODE_EXTRA_CA_CERTS=/path/to/your-ca.pem
```

**"Not signed in" or exit code 4.** Run `quox login` again, with the same `-p` profile you used before. Check with `quox whoami`.

**Slow or no response.** Run `quox status` and `quox doctor` to see whether the server is reachable and healthy. Add `--debug` to see the HTTP calls. In headless mode, set `--timeout`.

## Licence

Quox Community Source Licence 1.0. This is source-available software, not open source. You may self-host and inspect it freely; redistribution and repackaging are restricted. Read the full text in the `LICENSE` file or at https://github.com/quoxai/quoxcore.

Website: https://quox.ai  
CLI home: https://cli.quox.ai
