# figma-opencode

Figma for OpenCode in one plugin — the OpenCode equivalent of installing the official Claude `figma` plugin.

One package does two things when OpenCode loads it:

1. **Registers the Figma MCP server** — `https://mcp.figma.com/mcp` (remote, OAuth), no config editing.
2. **Registers all 16 official Figma agent skills** — bundled from Figma's own [mcp-server-guide](https://github.com/figma/mcp-server-guide) repo and served straight from the installed package.

No runtime dependencies. `@opencode/plugin` and `effect` are provided by the OpenCode host; this package is a zero-dep ESM module.

## Install

```sh
opencode plugin add figma-opencode
```

or add it to `opencode.json(c)` (global config: `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["figma-opencode"]
}
```

Restart OpenCode if it was running.

## One manual step: sign in

OAuth can't be automated. Once per machine:

```
/mcps  →  figma  →  Sign in
```

A browser window opens; approve access to your Figma account. After that the `figma` MCP tools work in every session.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "figma-opencode",
      "options": {
        "mcp": true,                            // register the Figma MCP server (default true)
        "mcpName": "figma",                     // name of the MCP entry (default "figma")
        "url": "https://mcp.figma.com/mcp",     // override the MCP endpoint
        "skills": true                          // register the bundled Figma skills (default true)
      }
    }
  ]
}
```

All options are optional. Example — use the **Figma desktop app** local server (Dev Mode MCP) instead of the remote one:

```jsonc
{
  "plugins": [
    {
      "package": "figma-opencode",
      "options": { "url": "http://127.0.0.1:3845/mcp" }
    }
  ]
}
```

## How it works

`setup(ctx)` runs when the plugin loads and performs two transforms:

```js
await ctx.mcp.transform((editor) => {
  editor.set("figma", { type: "remote", url: "https://mcp.figma.com/mcp" })
})

await ctx.skill.transform((editor) => {
  for (const skill of bundled) editor.add(skill)
})
```

Skill definitions are read from the bundled `skills/` directory at load time: `id` and `name` come from the directory/frontmatter, `description` from the skill's YAML frontmatter, `autoinvoke` is derived from `disable-model-invocation`, and `path` points at the bundled `SKILL.md` so relative `references/…` links inside skills keep working.

## Bundled skills

| Skill | Purpose |
| --- | --- |
| `figma-use` | Execute Figma Plugin API code in a file — mandatory before any `use_figma` write call |
| `figma-create-new-file` | Create new Figma Design, FigJam, or Slides files |
| `figma-generate-design` | Build full pages, screens, and composed UI in Figma from code or intent |
| `figma-design-to-code` | Implement Figma designs as code — mandatory before `get_design_context` |
| `figma-code-connect` | Create and maintain Figma Code Connect mappings |
| `figma-generate-library` | Build or extend design systems, variables, and component libraries in Figma |
| `figma-generate-diagram` | Create FigJam diagrams (flowcharts, architecture, sequence, ERD, …) |
| `figma-use-figjam` | FigJam-specific `use_figma` flows |
| `figma-use-motion` | Animate Figma nodes (keyframes, easing, animation styles) |
| `figma-implement-motion` | Implement Figma motion in production code |
| `figma-code-workflows` | Import HTML/project files into Figma; Design frames, Code Layers, Make |
| `figma-swiftui` | SwiftUI ↔ Figma translation in both directions |
| `figma-shaders` | Author shader effects and fills |
| `figma-spec` | Create, read, edit, review, or comment on Figma specs |
| `figma-generative-plugins` | Author generative Figma plugins |
| `figma-use-slides` | Figma Slides-specific `use_figma` flows |

## Uninstall

```sh
opencode plugin remove figma-opencode
```

If you previously copied the same skills manually into `~/.config/opencode/skills/figma-*`, delete those copies after installing this package so the skills aren't registered twice.

## License

Plugin code: MIT (see `LICENSE`).

The bundled skills under `skills/` are copied verbatim from [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) by Figma, Inc. That repository currently ships without a license file; the skills are redistributed here for convenience, with credit. If Figma objects, the skills can be dropped from the package without affecting the MCP registration.
