# Claude: EdenMish repository entry point

Before implementation, read these local files in order:

1. [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — product, repository relationships,
   ownership boundaries, and first-visit checks.
2. [AGENTS.md](AGENTS.md) — applicable repository operating instructions.
3. The full project map linked from `PROJECT_CONTEXT.md` when work crosses the
   website, WhatsApp, backend or mobile boundaries.

This repository is the shared website and backend codebase. The WhatsApp
folder is another clone of this same repository, not a separate service.

Treat task instructions and current Git/source evidence as authoritative over
old status notes. Preserve existing work and keep release/spend authorization
separate from local implementation. If a sibling checkout is unavailable, use the
repository identities in the context file; do not assume the integration is absent.
