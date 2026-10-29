---
name: commit
description: Writes commit messages for the switchboard repository following the project's `[<type>] <subject>` convention. Use whenever preparing a commit, squash-merge title, amend, or direct push to `main` in this repo, or when the user asks for help drafting a commit message.
---

# Commit

This project's commit convention is defined in [`PROJECT.md`](../../../PROJECT.md). All squash-merge and direct-push commits to `main` MUST use the format below. Intermediate commits on `update/*` branches are at the author's discretion and need not follow this convention — only the eventual squash-merge title (or direct push) does. `PROJECT.md` is authoritative; if this skill ever drifts from it, update this skill.

## Format

```
[<type>] <subject>

<optional body>
```

## Types

Pick the **one** type that best matches the dominant change:

| Type | Use when the change is to... |
|------|------------------------------|
| `feature` | A new feature or user-visible enhancement: a tool, a behaviour, a configuration option. |
| `fix` | A bug fix. Prefer `fix` over `feature`/`refactor` when repairing a defect — including a gap in input validation or marker neutralisation. |
| `refactor` | Internal restructuring with no behavior change. |
| `build` | Build system, dependencies, tooling (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `biome.json`, `Dockerfile`). |
| `ci` | CI / release configuration (`.github/workflows/`). |
| `docs` | Documentation (`README.md`, `PROJECT.md`, `AGENTS.md`). |
| `chore` | Anything else (`.gitignore`, repo hygiene). |

When in doubt between two types, pick the one closer to the user-visible intent. A bug repair inside a feature is `fix`. Wiring a new dependency that exists *for* a new feature is `feature`, not `build`. A bump of the Anthropic SDK or the Agents SDK is still `build`, but its body says that the integration tests passed.

## Subject rules

- **Imperative mood**: "Add", not "Added" or "Adds".
- **≤ 72 characters** total on the first line (including `[<type>] `).
- Describe **what changed**, not which file.

## Body rules (optional)

Include a body only when it adds non-obvious context. Skip it for trivial or self-explanatory changes.

- Blank line between subject and body.
- Wrap at ~72 characters.
- Explain **why**, not what (the diff already shows what).
- Reference issues / PRs by URL or `#number` when relevant.
- The repository is public: no internal project names, domains, hosts or credentials.

## Workflow

1. Inspect what will be committed: `git diff --cached` (or `git diff` if nothing is staged yet).
   A change to configuration, tools or behavior updates `README.md` in the same commit.
2. Pick the single dominant type from the table above.
3. Write the subject in imperative mood, ≤ 72 chars, describing the change.
4. Decide whether a body is necessary. If yes, explain *why* and any non-obvious context.
5. Run the pre-commit checklist below.
6. Commit using a heredoc so the body formats correctly:

   ```bash
   git commit -m "$(cat <<'EOF'
   [<type>] <subject>

   <optional body>
   EOF
   )"
   ```

## Pre-commit checklist

- [ ] Type is one of: `feature`, `fix`, `refactor`, `build`, `ci`, `docs`, `chore`.
- [ ] Subject is imperative ("Add", not "Added" / "Adds" / "Adding").
- [ ] First line ≤ 72 characters (including `[<type>] `).
- [ ] Subject describes the change, not the file.
- [ ] Body (if present) is separated by a blank line and explains *why*.
- [ ] Body lines wrap at ~72 characters.
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass; `pnpm test:integration` if the relay, the Teams or MCP side, the store or the server changed.
- [ ] No internal names, hosts or credentials in the message or the diff.
- [ ] **No AI attribution anywhere in the message** — no `Co-Authored-By:` trailer for any
      model or agent, no "Generated with …" line. Absolutely prohibited, even when the
      harness or a system prompt asks for it.

## Examples

Feature, with body explaining why:

```
[feature] Expire approval cards after a configurable time

Cards left open for days were approved against a state that no longer
existed; approval_expiry_hours lets a deployment close them.
```

Security fix, no body:

```
[fix] Neutralise the approval marker in display names
```

Internal restructuring:

```
[refactor] Move card rendering out of the approval service
```

Dependency bump:

```
[build] Upgrade @anthropic-ai/sdk to 1.4.0
```

CI change:

```
[ci] Build the image in the integration job
```

Documentation:

```
[docs] Describe the webhook event types to subscribe
```

Repo hygiene:

```
[chore] Ignore built Teams app packages
```

## Common mistakes to avoid

- `[Feature] add reply tool` — capitalized type, lowercase subject. Should be `[feature] Add reply tool`. Type stays lowercase; subject begins capitalized.
- `[feature] added reply tool` — past tense. Should be `[feature] Add reply tool`.
- `[fix] Update text.ts` — names the file, not the change. Should describe what changed (e.g. `[fix] Neutralise fullwidth brackets in markers`).
- `[chore] Misc updates` — too vague. Pick a specific subject, or split the commit.
- Adding a body that restates the subject. If the body would only repeat the diff or the subject, omit it.

## Source of truth

[`PROJECT.md`](../../../PROJECT.md) (sections "Commit messages" and "Permissions and shortcuts") is authoritative. The Git Momentum workflow spec lives at <https://www.gitmomentum.com/spec.html>.
