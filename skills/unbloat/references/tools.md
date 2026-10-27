# Evidence tools by ecosystem

Use what the project already has: a script in its package manifest, a configured linter, or a dev dependency.
A tool that isn't there needs the user's OK first, even as a one-off run (`npx`, `uvx`, `go run`). Every
result is a lead to verify, never a delete list.

| Ecosystem | Unused code, files, exports | Unused dependencies | Notes |
|---|---|---|---|
| JavaScript / TypeScript | [knip](https://knip.dev) | knip | Has plugins for most frameworks' entry points. depcheck and ts-prune are no longer maintained, and knip replaces them. |
| Python | [vulture](https://github.com/jendrikseipp/vulture), ruff `F401`/`F841` | [deptry](https://github.com/fpgmaas/deptry) | vulture often flags dynamic uses (attributes, `getattr`, frameworks). Start at `--min-confidence 80`. |
| Go | [deadcode](https://pkg.go.dev/golang.org/x/tools/cmd/deadcode), staticcheck `U1000` | `go mod tidy` (diff only) | deadcode starts only from `main` packages; add `-test` so test-only code counts as used. |
| Rust | compiler `dead_code` warnings, clippy | [cargo-machete](https://github.com/bnjbvr/cargo-machete), cargo-udeps | cargo-machete misses deps used only by build scripts or renamed crates. |
| Swift | compiler warnings, a build with each target | — | Periphery is archived. Check `#if` branches, Objective-C runtime use, and Codable or protocol synthesis by hand. |
| Java / Kotlin | IDE inspections, detekt (Kotlin) | Gradle dependency-analysis plugin | Reflection, DI containers and annotations make static results unreliable. |
| Any language | `git grep -n`, compiler and linter warnings | the lockfile diff | Grep the name as a string too, in config, templates and other repositories. |
| No tools installed | for each top-level name, `git grep -cw NAME` (a count of 1 is a lead); Python's own `ast` module lists definitions to compare with references | each manifest entry grepped for its import | Needs nothing installed. Finds leads only, so check every trap in the catalog. |
| Duplication | [jscpd](https://github.com/kucherenko/jscpd) | — | Token-based and works in many languages. Copies in tests and fixtures are often fine. |
| Docs links | `unbloat-check` (links inside the repo), [lychee](https://github.com/lycheeverse/lychee) (external URLs) | — | lychee needs network access; run it with `--offline` to check only local links. |

For an unused export, also check whether the package is published. If it is, the export is part of its public
API, and removing it is the owner's call.
