# EdenMish

EdenMish connects customer website and WhatsApp booking to one delivery backend,
with separate Flutter and native iPhone/Watch driver applications.

**New here? Start with [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md), then
[AGENTS.md](AGENTS.md).** Claude has a matching [entry point](CLAUDE.md).
The [project map](docs/PROJECT_MAP.md) identifies each related repository,
checkout and API boundary.

- `storefront/`: customer web experience.
- `worker/`: authoritative Cloudflare Worker + D1 order and delivery backend.
- `theme/`: Shopify theme integration; Shopify hosts checkout with PayPlus.
- WhatsApp booking lives in this same repository, currently developed in the
  separate local `edenmish-whatsapp` clone on `feat/whatsapp-booking`.
- `eden-driver-ios` and `eden-driver` are separate repositories that consume the
  backend's authenticated Driver API.

See [backend architecture](docs/ARCHITECTURE.md), [Worker reference](worker/README.md)
and [CI/CD](docs/CI_CD.md) for component details. Verify your current branch and
working tree before using instructions or making changes.
