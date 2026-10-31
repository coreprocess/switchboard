# Project Guideline

This project follows the [Git Momentum](https://www.gitmomentum.com) workflow. For workflow rules, see the [specification](https://www.gitmomentum.com/spec.html). This document defines the project-specific policies.

---

## Names

| Item | Value |
|------|-------|
| Trunk branch | `main` |
| Deployment branches | none — Switchboard is released as a container image; projects deploy a pinned image version from their own infrastructure code |
| Update branch pattern | `update/<YYYYMMDD>-<short-description>` or `update/<YYYYMMDD>-<ticket-id>-<short-description>` |
| Hotfix branch pattern | not used — without deployment branches, fixes go through update branches and ship as a patch release |

The ticket-id segment is optional; the date is always required.

---

## Conventions

### Commit messages

When committing with an AI agent, use the [commit skill](.agents/skills/commit/SKILL.md), which encodes the rules below.

Squash-merge and direct-push commits to `main` MUST follow:

```
[<type>] <subject>

<optional body>
```

**Types:**

| Type | When to use |
|------|-------------|
| `feature` | New feature or user-visible enhancement (a tool, a behaviour, a configuration option). |
| `fix` | Bug fix. |
| `refactor` | Internal restructuring with no behavior change. |
| `build` | Build system, dependencies, tooling, Docker image. |
| `ci` | CI configuration. |
| `docs` | Documentation. |
| `chore` | Anything else. |

**Subject rules:**
- Imperative mood ("Add", not "Added").
- ≤ 72 characters on the first line.
- Describes what changed, not which file.

**Body:** optional, blank line above. Explains *why* and any non-obvious context.

**Example:**

```
[feature] Archive inactive conversations after a configurable time

Idle sessions never end on their own, so Teams content stayed in Claude
longer than in Switchboard; SESSION_ARCHIVE_AFTER_DAYS bounds it.
```

### Version tags

When tagging with an AI agent, use the [version skill](.agents/skills/version/SKILL.md), which encodes the rules below and the major / minor / patch decision logic.

Pattern: `v<major>.<minor>.<patch>` (matched by `v[0-9]*`).

Tags are created manually by the [maintainers](MAINTAINERS.md) on release-worthy commits. Tags are the only source of truth for versions; there is no version file to bump. The version of any commit is derived with:

```
git describe --tags --candidates=100 --match='v[0-9]*' --abbrev=4
```

Pushing a tag triggers the release pipeline, which builds the image `ghcr.io/coreprocess/switchboard:<major>.<minor>.<patch>` (and `:<major>.<minor>`) and embeds the version as `SWITCHBOARD_VERSION`. Consuming projects pin the image by version or digest.

The configuration (environment variables), the custom tools agents get (names, inputs, results), the header lines agents see (`[teams]`, `[switchboard:…]`), the commands and the HTTP endpoints are the public contract. Breaking any of them is a major change.

---

## Permissions and shortcuts

| Item | Policy |
|------|--------|
| Direct push to `main` | Allowed for the [maintainers](MAINTAINERS.md). The pushed commit MUST follow the commit message convention. |
| Tags | Created and pushed by the [maintainers](MAINTAINERS.md) only. |

---

## Review

| Item | Policy |
|------|--------|
| Update PRs | One approval from a [maintainer](MAINTAINERS.md) is sufficient. |

---

## Repository layout

Single TypeScript package (Node.js 22, pnpm). Source in `src/`, tests in `test/unit` (no Docker) and `test/integration` (Docker: mock Claude and Bot Framework endpoints, Azurite), the Teams app package in `teams-app/`, Kubernetes examples in `examples/kubernetes/`.

Coding standards for AI agents live in [`AGENTS.md`](./AGENTS.md); reusable agent workflows are skills under [`.agents/skills/`](./.agents/skills/).

---

## Automation

### Build pipeline

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on every pull request and every push to `main`: lint, type check, unit tests and build, then the integration tests (end to end against mock Claude and Bot Framework endpoints, the store against Azurite) and an image build.

### Release pipeline

[`.github/workflows/release.yml`](./.github/workflows/release.yml) runs on every pushed version tag and publishes the multi-architecture image to GitHub Container Registry, with SBOM and build provenance.
