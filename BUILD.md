# How `figma-opencode` was built

A complete, chronological record of how this plugin went from "I want the Claude `figma` plugin experience in OpenCode" to a published npm package with a verified installer — including every dead end, gotcha, and the exact commands and evidence used to prove it works.

**TL;DR:** an OpenCode v2 plugin is an npm package that default-exports `Plugin.define({ id, setup })`. `setup(ctx)` gets a context object whose domains can *transform* OpenCode's configuration — `ctx.mcp.transform()` registers MCP servers, `ctx.skill.transform()` registers skills. This package registers the remote Figma MCP server and 16 bundled Figma skills. It has zero runtime dependencies, because `@opencode/plugin` is injected by the host at runtime.

---

## 0. Starting point

The goal: the OpenCode equivalent of

```sh
claude plugin install figma@claude-plugins-official
```

The manual setup this package replaces:

1. A remote MCP entry in `~/.config/opencode/opencode.json`:

```json
{ "mcp": { "servers": { "figma": { "type": "remote", "url": "https://mcp.figma.com/mcp" } } } }
```

2. 16 skill directories (`figma-use`, `figma-generate-design`, …) copied from [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) into `~/.config/opencode/skills/`.

3. A one-time OAuth sign-in via `/mcps` → `figma`.

The wish: one npm package, one install command, no manual file copying ever again.

---

## 1. Research: how OpenCode v2 plugins actually work

### 1.1 Read the docs — and notice which docs are current

Two documentation sites exist:

- `https://opencode.ai/docs/plugins` — **v1** API: modules export functions returning a hooks object (`export const MyPlugin = async ({ project, client, $, ... }) => ({ "tool.execute.before": ... })`).
- `https://opencode.ai/v2/docs/build/plugins` — **v2** API. The package we targeted (OpenCode 2.0.32) uses this one.

The v2 docs give the shape:

```js
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "example",
  async setup(ctx) { ... },
})
```

Rules taken from the docs:

- Each module must have **one default export** with a unique `id` and a `setup` function.
- Config key is `plugins` (array). Entries can be package names, versioned/scoped specs, local paths, `file://` URLs, or `{ package, options }` objects.
- `ctx.options` receives the options object verbatim.
- Plugins are installed automatically with Bun and cached (on Windows: `~/.cache/opencode/npm/<pkg>@latest/<timestamp>/node_modules/<pkg>`).
- CLI management: `opencode plugin add | list | check | update | remove`.

### 1.2 Read the installed types, not just the docs

Docs lag behind code, so the source of truth was the actual runtime package. Installing `@opencode/plugin@2.0.32` (matching the OpenCode version) as a devDependency and reading its `dist/*.d.ts` gave the exact contracts:

```ts
// dist/promise/plugin.d.ts
export interface Context {
  readonly location: Location.Info
  readonly options: PluginOptions
  readonly mcp: MCPDomain
  readonly skill: SkillDomain
  // ...agent, command, event, provider, session, storage, tool, vcs, ...
}
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export declare function define(plugin: Plugin): Plugin
```

```ts
// dist/promise/mcp.d.ts
export interface MCPEditor {
  list(): readonly [string, DeepMutable<Mcp.ServerConfig>][]
  get(name: string): DeepMutable<Mcp.ServerConfig> | undefined
  set(name: string, config: Mcp.ServerConfig): void
  update(name: string, update: (config: DeepMutable<Mcp.ServerConfig>) => void): void
  remove(name: string): void
}
export interface MCPDomain {
  readonly transform: Transform<MCPEditor>
  readonly reload: () => Promise<void>
}
```

```ts
// dist/promise/skill.d.ts
export interface SkillEditor {
  list(): readonly DeepMutable<Skill.Info>[]
  get(id: string): DeepMutable<Skill.Info> | undefined
  add(skill: Skill.Info): void
  update(id: string, update: (skill: DeepMutable<Skill.Info>) => void): void
  remove(id: string): void
}
```

And the exact shapes being written:

```ts
// @opencode/schema/mcp — remote server config
{ type: "remote", url: string, headers?: Record<string,string>, oauth?: OAuthConfig | false, disabled?, ... }

// @opencode/schema/skill — Skill.Info
{ id, name, description?, autoinvoke?, path: AbsolutePath, content: string }

// dist/promise/registration.d.ts
export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>
```

`Transform` callbacks are **synchronous** — all I/O (reading skill files) must happen *before* calling `transform`.

### 1.3 Discover the constraint that shapes the architecture

Reading `dist/runtime.js` revealed something you can't find in the docs:

```js
const foreignPkgSuffix = String.raw`(?:node_modules[/\\](@opencode[/\\]plugin|effect)|...)`
// ...
build.onLoad({ filter: createForeignPackageFilter() }, (args) => {
  throw new Error(`Cannot load "${target}" from plugin node_modules: "${target}" is not provided by OpenCode; plugins must use the host's "effect" and "@opencode/plugin" modules.`)
})
```

**The host injects `@opencode/plugin` and `effect` as virtual modules.** If your plugin tries to resolve them from its own `node_modules`, the runtime throws. Consequences:

- These must **not** be `dependencies` or `peerDependencies` of the published package.
- They can be `devDependencies` for local type-checking; Bun installs of the published package simply won't fetch them.
- The plugin must not import anything else exotic — for a zero-dependency package this is a non-issue.

---

## 2. Design decisions

| Decision | Why |
| --- | --- |
| One default export, `id: "figma-opencode"` | v2 contract; id is what `plugins: ["-figma-opencode"]` disables |
| MCP registered via `ctx.mcp.transform` | No config file edits; works for any location the plugin loads in |
| Skills registered via `ctx.skill.transform` | Same — and skills ship *inside* the package, versioned together |
| Bundle all 16 skills verbatim | Matches the official skill set; no runtime downloads, works offline |
| Plain `index.js` (ESM), no build step | Bun loads TS fine, but JS removes a whole toolchain from the equation |
| Zero runtime dependencies | Only Node builtins (`fs`, `path`, `url`) are used |
| Options: `mcp`, `mcpName`, `url`, `skills` | `url` allows switching to the desktop Dev Mode server; `mcpName` proved invaluable for testing (see §5) |

---

## 3. Writing the plugin

The entire plugin is ~130 lines of `index.js`. Structure:

```js
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

const here = dirname(fileURLToPath(import.meta.url))
const skillsDirectory = join(here, "skills")

const defaultMcp = { name: "figma", url: "https://mcp.figma.com/mcp" }
```

### 3.1 A 20-line frontmatter parser instead of a YAML dependency

Skill files use simple single-line frontmatter. Scanning all 16 files first proved the shape was uniform — only `name`, `description`, and `disable-model-invocation` keys, zero multi-line values:

```
figma-code-connect keys=[name,description,disable-model-invocation] continuations=0
figma-code-workflows keys=[name,description,disable-model-invocation] continuations=0
...
```

So a hand-rolled parser is sufficient:

```js
function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return {}
  const end = markdown.indexOf("\n---", 3)
  if (end === -1) return {}

  const fields = {}
  let key
  for (const line of markdown.slice(3, end).split(/\r?\n/)) {
    if (!line.trim()) continue
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (entry) { key = entry[1]; fields[key] = entry[2]; continue }
    if (key && /^\s/.test(line)) fields[key] += ` ${line.trim()}`  // folded continuation
  }
  return fields
}
```

One subtlety: YAML quoted values (`description: "…"`) need unquoting and `\"` unescaping:

```js
function text(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  return quoted ? trimmed.slice(1, -1).replace(/\\"/g, '"') : trimmed
}
```

### 3.2 Loading skills into `Skill.Info` records

```js
function loadSkills() {
  if (!existsSync(skillsDirectory)) return []
  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(skillsDirectory, entry.name, "SKILL.md")
      if (!existsSync(path)) return []
      const content = readFileSync(path, "utf8")
      const frontmatter = parseFrontmatter(content)
      const description = text(frontmatter.description)
      return [{
        id: entry.name,
        name: text(frontmatter.name) ?? entry.name,
        ...(description === undefined ? {} : { description }),
        autoinvoke: text(frontmatter["disable-model-invocation"]) !== "true",
        path,
        content,
      }]
    })
}
```

Key details:

- `id` = directory name, `autoinvoke` = inverse of `disable-model-invocation`.
- `path` points at the **bundled** `SKILL.md`. This matters: relative links inside skills (`references/gotchas.md`) resolve against the directory containing `SKILL.md`, so the whole skill tree (95 files, `references/` included) is shipped, not just markdown.
- `description` key is omitted entirely when absent rather than set to `undefined` — cheap insurance against strict schema decoding.

### 3.3 The setup function

```js
export default Plugin.define({
  id: "figma-opencode",
  async setup(ctx) {
    const options = ctx.options ?? {}

    if (options.mcp !== false) {
      const name = typeof options.mcpName === "string" ? options.mcpName : defaultMcp.name
      const url = typeof options.url === "string" ? options.url : defaultMcp.url
      await ctx.mcp.transform((editor) => {
        editor.set(name, { type: "remote", url })
      })
    }

    if (options.skills !== false) {
      const skills = loadSkills()          // I/O first — transform is synchronous
      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill)
      })
    }
  },
})
```

That's the whole plugin. Everything else is packaging and proof.

---

## 4. Packaging

### 4.1 Bundling the skills

```powershell
Copy-Item -Recurse -Force "$env:TEMP\figma-mcp-guide\skills" .   # 16 dirs, 95 files, 1.5 MB
```

(PowerShell gotcha: `Copy-Item -Recurse "src\*" "dest\"` fails with *"Container cannot be copied onto existing leaf item"* when destination children already exist — copy the parent directory instead of a wildcard.)

### 4.2 `package.json`

```jsonc
{
  "name": "figma-opencode",
  "version": "0.1.1",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js" },
  "files": ["index.js", "skills", "README.md", "LICENSE"],
  "devDependencies": { "@opencode/plugin": "^2.0.32" }   // types only — NOT a runtime dep
}
```

`files` keeps the published tarball tight: 99 files, 461 kB (1.6 MB unpacked). `devDependencies` are never installed for consumers, which satisfies the §1.3 constraint.

### 4.3 Release workflow

`.github/workflows/publish.yml` publishes on GitHub Release with npm provenance:

```yaml
permissions: { contents: read, id-token: write }
steps:
  - run: npm publish --provenance --access public
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Requires a repo secret `NPM_TOKEN` (npm granular token, *Read and write* + *bypass 2FA*) — or switch to npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no token).

---

## 5. Testing — proving an agent plugin actually works

Plugin bugs are invisible: OpenCode swallows setup errors into a log file. Every layer was verified with observable evidence.

### 5.1 A scratch project with a discriminating option

```jsonc
// C:\...\Temp\opencode\figma-plugin-test\opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file:///C:/Users/MUSHFIQ/figma-opencode",
      "options": { "mcpName": "figma-plugin-test" } }
  ]
}
```

`mcpName: "figma-plugin-test"` exists nowhere else in the machine's config — if that name appears, *the plugin ran*. (The machine already had a `figma` MCP entry from manual setup, so the default name couldn't discriminate.)

```powershell
cd $test; opencode mcp list
# ⚠ figma-plugin-test  needs authentication     ← plugin registered it; needs_auth is expected
```

### 5.2 Log evidence

Server logs live in `~/.local/share/opencode/log/opencode.log`:

```text
msg="loading plugin" id="C:\\Users\\MUSHFIQ\\figma-opencode"
    entrypoint=file:///C:/Users/MUSHFIQ/figma-opencode/index.js
msg="mcp connect failed" server=figma-plugin-test status.status=needs_auth
    status.error="MCP server \"https://mcp.figma.com/mcp\" requires a login before it can register a client"
```

No plugin errors, correct entrypoint path, MCP registered. Also proof of the §1.3 constraint being satisfied: the local dev copy *has* `node_modules/@opencode/plugin` installed (devDependency) and the host still served it correctly.

### 5.3 Load-testing the exact npm artifact

`npm pack` → extract → point the test project at the extracted directory (which has **no** `node_modules` at all):

```powershell
npm pack --silent                              # figma-opencode-0.1.1.tgz
tar -xzf figma-opencode-0.1.1.tgz -C $extract
# plugins: [ "file:///.../figma-pkg-extract/package" ]
opencode mcp list                               # ⚠ figma-plugin-test  needs authentication ✓
```

This simulates a real npm install: entry resolved through `package.json → exports`, host-provided imports, zero local deps.

### 5.4 Proving skills register — the probe trick

`opencode api get /api/skill` lists skills **per location** (query param `location=<directory>`), but only materializes them for locations that have had a real session; fresh servers return `data: []`. Worse, after a prompt, the global file-based skills (`~/.config/opencode/skills/figma-*`) and the plugin skills have **identical ids** — so a plain "list your skills" answer couldn't prove the plugin's copies registered.

Solution: drop a uniquely named probe skill into the package's `skills/` directory and run a **fresh** server (the background service caches location state from before the probe existed):

```powershell
# added: skills/figma-probe/SKILL.md  (description contains marker ZQPROBE9942)
cd $test
opencode run --standalone "Do not call any tools. Look at your available skills (the skill tool lists them). Output ONLY the ids of skills whose id starts with 'figma-', one per line, nothing else."
```

Output:

```
figma-code-connect
...
figma-probe        ← exists ONLY inside the package's skills/ dir
...
figma-use-slides
```

Probe visible ⇒ the plugin read its bundled skills directory at setup and registered them. Done. (Then deleted the probe.)

### 5.5 Dead ends worth knowing

| Attempt | Result |
| --- | --- |
| `opencode api get /api/skill --standalone` | `data: []` — skills materialize only for locations with sessions |
| `--param directory=<path>` | Ignored; the query param is named `location` (found by grepping `@opencode/client` for `path: \`/api/skill\``) |
| `--param location=<path>` | Returned the service's default location anyway — the background service is bound to where it started |
| `POST /api/session` to force materialization | Session created, `data: []` still — skills load on prompt, not on session creation |
| Re-running `opencode run` after adding the probe | Probe missing — background service had cached plugin state from before the probe; `--standalone` fixed it |

---

## 6. Publishing

```powershell
git init && git add -A && git commit -m "figma-opencode 0.1.0 …"
gh repo create figma-opencode --public --source . --remote origin --push
npm publish --access public
```

Real-world auth friction, for the record:

- `npm publish` → `E403 … Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`
- After the account re-auth: `EOTP … Open this URL in your browser to authenticate` (npm's web-auth OTP flow) — works fine in an interactive terminal, fails in non-interactive shells.

Solutions: paste an `--otp=<code>`, or long-term, a granular access token with *bypass 2FA* (also stored as `NPM_TOKEN` for the release workflow), or npm Trusted Publishing via GitHub OIDC.

---

## 7. Gotcha summary

| Gotcha | Symptom | Fix |
| --- | --- | --- |
| Shipping `@opencode/plugin` as a real dependency | Runtime throw: *"Cannot load … from plugin node_modules"* | devDependency only; host provides it |
| v1 API confusion | Hooks-based examples don't apply | v2: `Plugin.define({ id, setup })` + `ctx.<domain>.transform` |
| Async work inside `transform` | Transform is synchronous | Read files before calling it |
| Skill `path` pointing at a temp copy | `references/…` links break | Ship full skill trees; `path` = real bundled file |
| Skill `id` patterns | Schema rejects `Bad_ID` | `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| Testing with the default MCP name | Can't tell plugin vs pre-existing config | `mcpName` option |
| Cached background-service location | Plugin changes not reflected in tests | `--standalone` (fresh server) |
| Global file skills masking plugin skills | Can't prove registration | Probe skill with a unique name |
| PowerShell `Copy-Item -Recurse src\*` | *"Container cannot be copied onto existing leaf item"* | Copy the parent dir, not the wildcard |

---

## 8. Repo map

```
figma-opencode/
├── index.js                     # the entire plugin (~130 lines)
├── package.json                 # ESM, files whitelist, devDep only
├── skills/                      # 16 Figma skills, 95 files, verbatim from figma/mcp-server-guide
├── README.md                    # user-facing docs
├── BUILD.md                     # this file
├── LICENSE                      # MIT (plugin code) + bundled-skills notice
└── .github/workflows/publish.yml  # npm publish on release, with provenance
```

## 9. Rebuild-from-scratch checklist

```powershell
# 1. scaffold
mkdir figma-opencode; cd figma-opencode; npm init -y
npm i -D "@opencode/plugin@2.0.32"          # types only

# 2. vendor skills
git clone --depth 1 https://github.com/figma/mcp-server-guide.git $env:TEMP\figma-mcp-guide
Copy-Item -Recurse -Force "$env:TEMP\figma-mcp-guide\skills" .

# 3. write index.js (see §3), package.json (see §4.2), README, LICENSE

# 4. test
npm pack --silent
tar -xzf figma-opencode-*.tgz -C $env:TEMP\pkg-test
# scratch project: plugins: [{ package: "file:///…/pkg-test/package", options: { mcpName: "probe" } }]
opencode mcp list                             # expect: probe  needs authentication
opencode run --standalone "list your figma-* skills"   # expect: 16 ids

# 5. publish
git init; git add -A; git commit -m "figma-opencode 0.1.0"
gh repo create figma-opencode --public --source . --remote origin --push
npm publish --access public
```
