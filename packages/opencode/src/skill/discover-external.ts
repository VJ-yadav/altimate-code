// altimate_change start — auto-discover skills/commands from external AI tool configs
import path from "path"
import { pathToFileURL } from "url"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { ConfigMarkdown } from "../config/markdown"
import { Glob } from "../util/glob"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Skill } from "./skill"

const log = Log.create({ service: "skill.discover" })

interface ExternalSkillSource {
  tool: string
  dir: string
  pattern: string
  scope: "project" | "home" | "both"
  format: "skill-md" | "command-md" | "command-toml"
}

const SOURCES: ExternalSkillSource[] = [
  { tool: "claude-code", dir: ".claude", pattern: "commands/**/*.md", scope: "both", format: "command-md" },
  { tool: "codex", dir: ".codex", pattern: "skills/**/SKILL.md", scope: "both", format: "skill-md" },
  { tool: "gemini", dir: ".gemini", pattern: "skills/**/SKILL.md", scope: "both", format: "skill-md" },
  { tool: "gemini", dir: ".gemini", pattern: "commands/**/*.toml", scope: "both", format: "command-toml" },
]

/**
 * Parse a standard SKILL.md file (Codex, Gemini) using ConfigMarkdown.parse().
 * Returns a Skill.Info or undefined if the file is malformed.
 */
async function transformSkillMd(filePath: string): Promise<Skill.Info | undefined> {
  const md = await ConfigMarkdown.parse(filePath).catch((err) => {
    log.debug("failed to parse external skill", { path: filePath, err })
    return undefined
  })
  if (!md) return undefined

  const parsed = Skill.Info.pick({ name: true, description: true }).safeParse(md.data)
  if (!parsed.success) return undefined

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    location: filePath,
    content: md.content,
  }
}

/**
 * Parse a Claude Code command markdown file (.claude/commands/*.md).
 * Supports optional YAML frontmatter with name/description.
 * Name derived from path relative to `commands/` root if not in frontmatter.
 * Nested paths are preserved: `team/review.md` → `team/review`.
 */
async function transformCommandMd(filePath: string, commandsRoot: string): Promise<Skill.Info | undefined> {
  const md = await ConfigMarkdown.parse(filePath).catch((err) => {
    log.debug("failed to parse command markdown", { path: filePath, err })
    return undefined
  })
  if (!md) return undefined

  // Derive name from frontmatter or path relative to the commands/ root
  const frontmatter = md.data as Record<string, unknown>
  let name: string
  if (typeof frontmatter.name === "string" && frontmatter.name.trim()) {
    name = frontmatter.name.trim()
  } else {
    // e.g. /home/user/.claude/commands/team/review.md → team/review
    const rel = path.relative(commandsRoot, filePath)
    name = rel.replace(/\.md$/i, "").replace(/\\/g, "/")
  }

  const description = typeof frontmatter.description === "string" ? frontmatter.description : ""

  return {
    name,
    description,
    location: filePath,
    content: md.content,
  }
}

/**
 * Parse a Gemini CLI command TOML file (.gemini/commands/*.toml).
 * Expects `prompt` field for content, optional `description`.
 * Converts `{{args}}` / `{{ args }}` → `$ARGUMENTS`.
 */
async function transformCommandToml(filePath: string): Promise<Skill.Info | undefined> {
  try {
    const mod = await import(pathToFileURL(filePath).href, { with: { type: "toml" } })
    const data = (mod.default || mod) as Record<string, unknown>

    if (typeof data.prompt !== "string" || !data.prompt.trim()) {
      log.debug("TOML command missing prompt field", { path: filePath })
      return undefined
    }

    const name = path.basename(filePath, ".toml")
    const description = typeof data.description === "string" ? data.description : ""
    // Convert Gemini's {{args}} / {{ args }} placeholder to $ARGUMENTS
    const content = data.prompt.replace(/\{\{\s*args\s*\}\}/g, "$ARGUMENTS")

    return {
      name,
      description,
      location: filePath,
      content,
    }
  } catch (err) {
    log.debug("failed to parse TOML command", { path: filePath, err })
    return undefined
  }
}

/**
 * Scan a single directory for skills/commands matching a source pattern.
 */
async function scanSource(
  root: string,
  source: ExternalSkillSource,
): Promise<Skill.Info[]> {
  const baseDir = path.join(root, source.dir)
  if (!(await Filesystem.isDir(baseDir))) return []

  const matches = await Glob.scan(source.pattern, {
    cwd: baseDir,
    absolute: true,
    include: "file",
    dot: true,
    symlink: true,
  }).catch(() => [] as string[])

  const results: Skill.Info[] = []
  for (const match of matches) {
    let skill: Skill.Info | undefined
    switch (source.format) {
      case "skill-md":
        skill = await transformSkillMd(match)
        break
      case "command-md":
        skill = await transformCommandMd(match, path.join(baseDir, "commands"))
        break
      case "command-toml":
        skill = await transformCommandToml(match)
        break
    }
    if (skill) results.push(skill)
  }
  return results
}

/**
 * Discover skills and commands from external AI tool configs
 * (Claude Code, Codex CLI, Gemini CLI).
 *
 * Searches both home directory and project directory (walking up from CWD to worktree root).
 * Returns discovered skills and contributing source labels.
 */
export async function discoverExternalSkills(worktree: string): Promise<{
  skills: Skill.Info[]
  sources: string[]
}> {
  log.info("Discovering skills/commands from external AI tool configs...")
  const allSkills: Skill.Info[] = []
  const sources: string[] = []
  const seen = new Set<string>()
  const homedir = Global.Path.home

  const addSkills = (skills: Skill.Info[], sourceLabel: string) => {
    let added = 0
    for (const skill of skills) {
      if (seen.has(skill.name)) continue
      seen.add(skill.name)
      allSkills.push(skill)
      added++
    }
    if (added > 0) sources.push(sourceLabel)
  }

  for (const source of SOURCES) {
    // Project-scoped: walk from Instance.directory up to worktree root
    if ((source.scope === "project" || source.scope === "both") && worktree !== "/") {
      for await (const foundDir of Filesystem.up({
        targets: [source.dir],
        start: Instance.directory,
        stop: worktree,
      })) {
        const root = path.dirname(foundDir)
        const skills = await scanSource(root, source)
        addSkills(skills, `${source.dir}/${source.pattern} (project)`)
      }
    }

    // Home-scoped: scan home directory (skip if home === worktree to avoid duplicates)
    if ((source.scope === "home" || source.scope === "both") && homedir !== worktree) {
      const skills = await scanSource(homedir, source)
      addSkills(skills, `~/${source.dir}/${source.pattern}`)
    }
  }

  if (allSkills.length > 0) {
    log.info(`Discovered ${allSkills.length} skill(s)/command(s) from ${sources.join(", ")}: ${allSkills.map((s) => s.name).join(", ")}`)
  } else {
    log.info("No external skills/commands found")
  }

  return { skills: allSkills, sources }
}

/** Stored after skill merge — only contains skills that were actually new. */
let _lastDiscovery: { skillNames: string[]; sources: string[] } | null = null

/** Called from skill.ts after merge with only the names that were actually added. */
export function setSkillDiscoveryResult(skillNames: string[], sources: string[]) {
  if (skillNames.length > 0) {
    _lastDiscovery = { skillNames, sources }
  }
}

/** Returns and clears the last discovery result (for one-time notification). */
export function consumeSkillDiscoveryResult() {
  const result = _lastDiscovery
  _lastDiscovery = null
  return result
}
// altimate_change end
