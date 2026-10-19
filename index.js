import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

const here = dirname(fileURLToPath(import.meta.url))
const skillsDirectory = join(here, "skills")

const defaultMcp = {
  name: "figma",
  url: "https://mcp.figma.com/mcp",
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return {}

  const end = markdown.indexOf("\n---", 3)
  if (end === -1) return {}

  const fields = {}
  let key

  for (const line of markdown.slice(3, end).split(/\r?\n/)) {
    if (!line.trim()) continue

    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (entry) {
      key = entry[1]
      fields[key] = entry[2]
      continue
    }

    if (key && /^\s/.test(line)) fields[key] += ` ${line.trim()}`
  }

  return fields
}

function text(value) {
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed

  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))

  return quoted ? trimmed.slice(1, -1).replace(/\\"/g, '"') : trimmed
}

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

      return [
        {
          id: entry.name,
          name: text(frontmatter.name) ?? entry.name,
          ...(description === undefined ? {} : { description }),
          autoinvoke: text(frontmatter["disable-model-invocation"]) !== "true",
          path,
          content,
        },
      ]
    })
}

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
      const skills = loadSkills()

      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill)
      })
    }
  },
})
