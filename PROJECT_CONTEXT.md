# Start here: EdenMish project context

This repository is the shared website and backend codebase. The WhatsApp
folder is another clone of this same repository, not a separate service.

[Full project map](docs/PROJECT_MAP.md) · [Backend architecture](docs/ARCHITECTURE.md) · [CI/CD](docs/CI_CD.md)

## What this product is

EdenMish is one delivery platform with multiple entry points and driver clients.
Customers book through the website or WhatsApp; the shared backend validates,
prices and manages the delivery; driver apps execute assigned pickup/delivery
tasks. A matching brand or sibling folder does not imply shared Git state.

## Repository roles

| Folder under `~/dev` | Repository | Responsibility |
| --- | --- | --- |
| `edenmish.com` | [`talagmon/edenmish.com`](https://github.com/talagmon/edenmish.com) | Website (`storefront/`), Shopify theme (`theme/`), and authoritative Cloudflare Worker + D1 backend (`worker/`). |
| `edenmish-whatsapp` | **Same** [`talagmon/edenmish.com`](https://github.com/talagmon/edenmish.com) | Separate local clone for WhatsApp development. Current WhatsApp work belongs on `feat/whatsapp-booking`; its changes do not automatically sync to the other clone. |
| `eden-driver-ios` | [`talagmon/eden-driver-ios`](https://github.com/talagmon/eden-driver-ios) | Native SwiftUI iPhone app, shared Swift core and Apple Watch companion. |
| `eden-driver` | [`talagmon/eden-driver`](https://github.com/talagmon/eden-driver) | Flutter driver app for iOS/Android and versioned mobile contract. |
| `edenmish-v2` | [`talagmon/edenmish-v2`](https://github.com/talagmon/edenmish-v2) | Separate alternate frontend; verify its current role before using it as the website source. |

`~/dev` resolves to `~/Development` on Tal's Mac. Most other `edenmish-*` folders
are worktrees of `edenmish.com`, not independent products. The full project map
explains how to identify worktrees and lists source evidence. The WhatsApp clone is distinct from
those worktrees: it has its own `.git` directory.

## Shared system boundaries

- Worker + D1 owns orders, prices, payment reconciliation, tracking, dispatch and
  authoritative delivery status. Website and WhatsApp use the canonical order
  pipeline; do not build a second order or pricing backend for chat.
- Both driver apps consume the versioned, authenticated `/api/driver/v1` API in
  the backend repository. They send execution events and consume route revisions;
  they do not directly access D1 or take ownership of commercial order state.
- The native Watch companion connects to its iPhone app through WatchConnectivity.
- Shopify hosts the checkout/payment boundary; PayPlus remains inside Shopify.
  A client, chat, or browser redirect cannot establish verified payment.
- Native iOS and Flutter have separate release workflows. Source code or a README
  is not proof of the currently installed app, completed cutover, or live release.

## First visit checklist for an agent

1. Read this file and this repository's `AGENTS.md` before implementation. Read the
   full project map before changes spanning repositories or API consumers.
2. Run `pwd`, `git rev-parse --show-toplevel`, `git branch --show-current`,
   `git status --short`, and inspect the Git origin locally. Confirm which checkout
   owns the requested work; a folder name is not a branch or deployment status.
3. Preserve all existing changes. Never reset a checkout, overwrite another clone,
   merge, switch a dirty branch, or relocate work merely to make folder names agree.
4. For cross-component changes, inspect both sides of the contract and the relevant
   tests. Follow each affected repository's own instructions. Keep the scope tied
   to the user's task rather than changing every related project.
5. Distinguish implementation, local tests, staged deployment, active test session,
   and production release. Verify the current evidence before claiming any of them.
   Do not stage, commit, push, deploy, release, spend, or send external messages
   based only on this context document; use the task's explicit authorization.

For a fresh clone without sibling folders, use the GitHub repository links above.
Read the map from the backend branch containing these docs; local paths are
examples, not prerequisites.

This is project orientation, not a frozen task status. Branches, local changes,
feature flags, grants and release states can change; recheck them each visit.
