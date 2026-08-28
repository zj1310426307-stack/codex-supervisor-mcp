# WSL2 runtime baseline

Phase 04 treats WSL2 as the recommended native runtime for the Supervisor,
Codex CLI, Git, and source worktrees. Docker or Podman is required only for the
independent verifier. The Supervisor must not be described as fully usable in
its service-only Docker image unless Codex, Git, authentication, the source
workspace, and state/worktree storage are supplied deliberately by an operator.

## Read-only preflight

Run this from the WSL2 project checkout:

```bash
npm run preflight:wsl2
```

The preflight reads, but does not repair, the following state:

- Linux/WSL identity and distribution environment;
- Node.js, npm, and Git versions;
- Codex command resolution and version;
- `codex app-server --help` availability;
- current Codex login status;
- Docker client and daemon availability;
- source workspace Git identity;
- workspace, state-directory, and worktree-directory access.

A missing or inaccessible prerequisite produces the exact status
`BLOCKED_BY_ENVIRONMENT` and a per-check reason. The script does not install or
sign in Codex, install a WSL distribution, edit PATH or shell profiles, change
the registry or WindowsApps permissions, create state/worktree directories,
install Docker, start/configure its daemon, or modify repository files.

## Recommended layout

Keep the repository and worktrees in the WSL Linux filesystem (for example,
under `/home/<operator>/src`) rather than under a mounted Windows drive. Use one
dedicated state directory and one dedicated worktree root, both owned by the
unprivileged Supervisor account. Keep Codex credentials in the normal operator
authentication store; never copy them into this repository or a verifier image.

Example operator-owned environment:

```bash
export CODEX_WORKSPACE_ROOTS=/home/operator/src
export SUPERVISOR_STATE_FILE=/home/operator/.local/state/codex-supervisor/state.json
export SUPERVISOR_WORKTREE_ROOT=/home/operator/.local/state/codex-supervisor/worktrees
export MCP_CONTROL_ENABLED=false
```

`MCP_CONTROL_ENABLED=false` is the required first-run posture. A later
full-control session is a separate operator decision after local validation and
must not alter the human-only ownership of commit, push, merge, release, or
deployment.

## Live progression

After the preflight passes, the operator may run the read-only Codex diagnosis,
the version-specific protocol compatibility probe, and then the explicitly
acknowledged live handshake. The development E2E additionally requires a real,
reviewed local verifier image pinned by its exact digest. Missing Docker or a
digest image blocks verification; it never triggers host-process fallback.

Official references:

- `https://learn.chatgpt.com/docs/windows/wsl`
- `https://learn.chatgpt.com/docs/codex/cli`
- `https://learn.chatgpt.com/docs/app-server`

## Validated local baseline

The 2026-08-28 read-only preflight passed with no blockers on Ubuntu WSL2:

- Linux x64; Ubuntu distribution;
- Node v24.20.0, npm 11.19.0, Git 2.53.0;
- Codex at `/home/user3104/.local/bin/codex`, version 0.150.1, signed in through ChatGPT;
- `codex app-server --help` available;
- Docker client and daemon 29.7.2 available;
- workspace, state parent, and worktree parent readable and writable.

This observation is machine-specific evidence, not permission for the preflight
script to install, repair, or reconfigure any prerequisite.
