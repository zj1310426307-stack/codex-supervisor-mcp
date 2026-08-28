# Verification

Verification is independent of Codex and accepts only profile IDs from trusted local configuration. MCP callers cannot submit programs, arguments, images, engine options, environment names, or container identities.

## OCI-only execution

Verification configuration version 2 has no host-process compatibility path. Every recipe runs in Docker or Podman with all of these controls supplied by the Supervisor:

- an OCI image pinned by an exact SHA-256 digest with image pulls disabled;
- no network, a read-only root filesystem, and the task worktree mounted read-only;
- all Linux capabilities dropped and no-new-privileges enabled;
- a numeric non-root uid:gid;
- explicit PID, memory, CPU, and tmpfs limits;
- an isolated IPC namespace and a bounded tmpfs for temporary data.

The configured engine, daemon, and exact local image are probed before a run is created. If Docker/Podman or the digest image is unavailable, the operation fails with RUNTIME_UNAVAILABLE. It never executes the recipe on the Supervisor host as a fallback.

Both example configurations contain a syntactically valid all-zero template
digest, not a real image identity or passing evidence. Operators must build or
otherwise obtain a reviewed local image, run
`scripts/verifier/inspect-image.sh image@sha256:<digest>`, and place only the
proven exact reference in an untracked private configuration. Recipes must be
read-only-worktree compatible: scripts that write `dist`, coverage, caches,
lockfiles, or generated sources into the repository are unsupported unless they
are reconfigured to write only under the bounded container tmpfs. Pulling or
installing packages into the repository during a run is also unsupported.

## Ownership and termination proof

The worker creates a uniquely labeled container, reads back its full container ID, labels, and `Config.Image`, and requires the image to equal the configured digest reference exactly. It records the exact ID plus its hash and attaches through the trusted engine CLI. On every outcome—including a normal zero exit—the worker inspects the exact container and proves that it is stopped with no remaining container PID before removing it.

If the engine attach process exits while the container remains alive, the worker kills only that exact label-verified container. Such intervention makes the recipe non-passing even when termination is subsequently proven. Missing, mismatched, or unknown ownership/termination evidence makes the run lost; it can never count toward acceptance.

After a Supervisor crash, reconciliation uses only the ledger-selected run and the currently trusted runtime configuration. The current engine/store fingerprint must equal the durable engine namespace. Image rotation in configuration does not invalidate an old run: its recorded digest is checked against both labels and `Config.Image`. A running exact container produces `PROVEN_STILL_RUNNING` and is never killed by reconciliation. A stopped exact container is removed only by its full ID after worker death, lease expiry, exact label/image inspection, and exclusive run-wide ownership are proven. Exact absence is positive only after worker death, lease expiry, and a full run-label enumeration returning zero.

A run persisted before its worker/container ownership event legitimately has no container ID. It may produce `PROVEN_TERMINATED` only when no worker PID or partial container identity was recorded, the lease is expired, the same engine namespace is available, and no container has its durable task/run/worker/image/engine/namespace labels. If any such container exists, reconciliation returns `UNKNOWN` and does not remove it. All other uncertain, hash-only, PID-only, legacy `backend="docker"`, or incomplete observations remain quarantined.

## Snapshot and acceptance binding

Snapshots include tracked, staged, unstaged, ordinary untracked, Git-ignored files, and symbolic-link target identities. Capture has explicit changed-file, per-file, total-byte, and Git-output limits. Unsupported file types, limit overflow, or a file changing during capture fails closed.

A result is usable only when:

- the run belongs to the task;
- all required recipes passed inside the OCI boundary;
- every recipe has exact positive termination proof without forced post-exit intervention;
- the passing run uses the current `backend="oci"`/explicit-engine evidence shape rather than an ambiguous legacy backend;
- the before and after worktree snapshots match;
- no unresolved quarantine exists;
- the live acceptance snapshot still matches the verified snapshot.

A passing run creates unsatisfied evidence candidates only. Acceptance must provide the expected snapshot ID and exactly one non-empty confirmation for every contract criterion.
