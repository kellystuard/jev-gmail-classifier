# ADR-0018: Protect `main` with automatic gates and no required review

- **Status:** Accepted (2026-09-27)
- **Date:** 2026-09-27
- **Deciders:** Kelly Stuard, E2 developer agent
- **Supersedes:** the branch-protection bullet of [ADR-0015](0015-git-workflow-and-releases.md). The rest of ADR-0015 stands.
- **Related:** [Engineering Standards §10](../engineering-standards.md#10-git-ci-and-releases), [Solution Design §11](../solution-design.md#11-build-and-deployment), issues #56 (the maintainer's answer, option 1), #52 (the `ci` check) and #55 (release PRs)

## Context

ADR-0015 says branch protection on `main` requires signed commits, passing CI, and a CODEOWNERS review. `.github/CODEOWNERS` is `* @kellystuard`, and he is the only human on the project.

The PM and developer agents open and merge PRs with the maintainer's own `gh` token. GitHub never lets a PR's author approve their own PR, so a required review would block every agent PR. The only way past it is the admin bypass, which defeats the rule.

The maintainer's token is also a bypass actor on the "Protect main" ruleset. So any rule holds only while nobody uses the bypass.

## Decision

The "Protect main" ruleset (id `23959277`, updated in place) requires:

- a pull request, with **no approving review** (`required_approving_review_count: 0`, `require_code_owner_review: false`);
- the `ci` status check from GitHub Actions (`integration_id: 15368`), without requiring branches to be up to date with `main`;
- signed commits;
- squash merges only.

It still blocks deletion and force-pushes to `main`. The repository allows only squash merges, and the squash commit's title is the PR title.

Nobody merges with the admin bypass (no `gh pr merge --admin`), human or agent.

## Consequences

- **Agent PRs merge without waiting on the maintainer.** The automatic gates are CI, signatures and squash-only. The PM checks them before merging.
- **Review is by choice, not enforced.** The maintainer reviews through the `needs: maintainer` label and whenever he chooses to look.
- **The gates depend on discipline.** The maintainer's token can bypass them, so a bypass merge would skip every rule.
- **`ci` is the only required check, matched by name.** Renaming the `ci` job means changing the ruleset in the same PR, or every PR is blocked. Adding or dropping a Node version doesn't touch the ruleset.
- **Release PRs need CI dispatched first.** release-please's PRs don't start CI by themselves, so `ci` must be run on their head commit before merging ([Engineering Standards §10](../engineering-standards.md#10-git-ci-and-releases)).
- **Squash commits pass the signature rule.** GitHub signs the squash commits it creates, so squash-merged PRs from agents, Dependabot and release-please all pass.

## Alternatives Considered

- **Require one approval and a CODEOWNERS review, with the maintainer approving each PR:** this doesn't work while agents use his token, because he can't approve PRs he authored. Even with a separate identity, he would approve 100+ v1 PRs, and every merge would wait on him.
- **A separate agent identity (a GitHub App or a machine user) plus a required CODEOWNERS review:** this keeps ADR-0015 as written, and agents lose the admin bypass. It is the most setup: an app or account, its credentials and signing, and still one approval per PR. This is the path if agents later move off the maintainer's account.
