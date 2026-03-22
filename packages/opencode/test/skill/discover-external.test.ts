import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { discoverExternalSkills } from "../../src/skill/discover-external"
import { Instance } from "../../src/project/instance"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "skill-discover-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe("discoverExternalSkills", () => {
  // Helper to run discovery with tempDir as both worktree and Instance.directory
  async function discover(worktree?: string) {
    return Instance.provide({
      directory: worktree ?? tempDir,
      fn: () => discoverExternalSkills(worktree ?? tempDir),
    })
  }

  // --- Claude Code commands ---

  test("discovers Claude Code command with frontmatter", async () => {
    await mkdir(path.join(tempDir, ".claude", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".claude", "commands", "review.md"),
      `---
name: review
description: Review the code changes
---

Please review the following code changes: $ARGUMENTS
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "review")
    expect(skill).toBeDefined()
    expect(skill!.description).toBe("Review the code changes")
    expect(skill!.content).toContain("$ARGUMENTS")
  })

  test("derives name from filename when no frontmatter name", async () => {
    await mkdir(path.join(tempDir, ".claude", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".claude", "commands", "test-cmd.md"),
      `# Test Command

Run the tests for $ARGUMENTS
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "test-cmd")
    expect(skill).toBeDefined()
    expect(skill!.description).toBe("")
    expect(skill!.content).toContain("$ARGUMENTS")
  })

  test("preserves nested command path as name", async () => {
    await mkdir(path.join(tempDir, ".claude", "commands", "team"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".claude", "commands", "team", "review.md"),
      `---
description: Team review command
---

Review for team: $ARGUMENTS
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "team/review")
    expect(skill).toBeDefined()
    expect(skill!.description).toBe("Team review command")
  })

  // --- Codex skills ---

  test("discovers Codex skill from .codex/skills/", async () => {
    await mkdir(path.join(tempDir, ".codex", "skills", "my-skill"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".codex", "skills", "my-skill", "SKILL.md"),
      `---
name: my-codex-skill
description: A skill from Codex CLI
---

# Codex Skill

Do the codex thing.
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "my-codex-skill")
    expect(skill).toBeDefined()
    expect(skill!.description).toBe("A skill from Codex CLI")
  })

  // --- Gemini skills ---

  test("discovers Gemini skill from .gemini/skills/", async () => {
    await mkdir(path.join(tempDir, ".gemini", "skills", "gem-skill"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini", "skills", "gem-skill", "SKILL.md"),
      `---
name: gem-skill
description: A Gemini CLI skill
---

# Gemini Skill

Instructions for the Gemini skill.
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "gem-skill")
    expect(skill).toBeDefined()
    expect(skill!.description).toBe("A Gemini CLI skill")
  })

  // --- Gemini TOML commands ---

  test("discovers Gemini TOML command and converts {{args}} to $ARGUMENTS", async () => {
    await mkdir(path.join(tempDir, ".gemini", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini", "commands", "deploy.toml"),
      `description = "Deploy the application"
prompt = "Deploy the app to {{ args }} environment"
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "deploy")
    expect(skill).toBeDefined()
    expect(skill!.description).toBe("Deploy the application")
    expect(skill!.content).toBe("Deploy the app to $ARGUMENTS environment")
    expect(skill!.content).not.toContain("{{")
  })

  test("skips Gemini TOML command without prompt field", async () => {
    await mkdir(path.join(tempDir, ".gemini", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini", "commands", "bad.toml"),
      `description = "Missing prompt field"
`,
    )

    const { skills } = await discover()
    expect(skills.find((s) => s.name === "bad")).toBeUndefined()
  })

  // --- Deduplication ---

  test("first discovered skill wins on name conflict", async () => {
    // Claude Code command (discovered first)
    await mkdir(path.join(tempDir, ".claude", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".claude", "commands", "deploy.md"),
      `---
name: deploy
description: Claude deploy
---

Claude deploy content
`,
    )

    // Gemini TOML command with same name
    await mkdir(path.join(tempDir, ".gemini", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini", "commands", "deploy.toml"),
      `description = "Gemini deploy"
prompt = "Gemini deploy content"
`,
    )

    const { skills } = await discover()
    const deploySkills = skills.filter((s) => s.name === "deploy")
    expect(deploySkills.length).toBe(1)
    expect(deploySkills[0].description).toBe("Claude deploy")
  })

  // --- Missing directories ---

  test("returns empty result for missing directories", async () => {
    const { skills, sources } = await discover()
    expect(skills).toEqual([])
    expect(sources).toEqual([])
  })

  // --- Malformed files ---

  test("skips malformed frontmatter gracefully", async () => {
    await mkdir(path.join(tempDir, ".codex", "skills", "bad-skill"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".codex", "skills", "bad-skill", "SKILL.md"),
      `---
name: [invalid yaml
description: broken
---

Content
`,
    )

    // Should not throw
    const { skills } = await discover()
    // The malformed skill should be skipped
    expect(skills.find((s) => s.name === "invalid yaml")).toBeUndefined()
  })

  test("skips SKILL.md without required frontmatter fields", async () => {
    await mkdir(path.join(tempDir, ".codex", "skills", "no-meta"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".codex", "skills", "no-meta", "SKILL.md"),
      `# No Frontmatter

Just content without metadata.
`,
    )

    const { skills } = await discover()
    expect(skills).toEqual([])
  })

  // --- Multiple sources ---

  test("discovers skills from multiple tools simultaneously", async () => {
    // Claude Code command
    await mkdir(path.join(tempDir, ".claude", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".claude", "commands", "cc-cmd.md"),
      `---
name: cc-cmd
description: Claude Code command
---

Claude Code command content
`,
    )

    // Codex skill
    await mkdir(path.join(tempDir, ".codex", "skills", "codex-skill"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".codex", "skills", "codex-skill", "SKILL.md"),
      `---
name: codex-skill
description: Codex skill
---

Codex skill content
`,
    )

    // Gemini skill
    await mkdir(path.join(tempDir, ".gemini", "skills", "gem-skill"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini", "skills", "gem-skill", "SKILL.md"),
      `---
name: gem-skill
description: Gemini skill
---

Gemini skill content
`,
    )

    // Gemini TOML command
    await mkdir(path.join(tempDir, ".gemini", "commands"), { recursive: true })
    await writeFile(
      path.join(tempDir, ".gemini", "commands", "gem-cmd.toml"),
      `description = "Gemini TOML command"
prompt = "Run {{args}}"
`,
    )

    const { skills, sources } = await discover()
    expect(skills.length).toBe(4)
    expect(skills.find((s) => s.name === "cc-cmd")).toBeDefined()
    expect(skills.find((s) => s.name === "codex-skill")).toBeDefined()
    expect(skills.find((s) => s.name === "gem-skill")).toBeDefined()
    expect(skills.find((s) => s.name === "gem-cmd")).toBeDefined()
    expect(sources.length).toBeGreaterThan(0)
  })

  // --- Worktree edge cases ---

  test("skips project scan when worktree is /", async () => {
    // Should not throw and should return empty (no dirs at /)
    const result = await Instance.provide({
      directory: tempDir,
      fn: () => discoverExternalSkills("/"),
    })
    expect(result.skills).toEqual([])
  })

  // --- Location tracking ---

  test("sets correct location path for discovered skills", async () => {
    await mkdir(path.join(tempDir, ".claude", "commands"), { recursive: true })
    const cmdPath = path.join(tempDir, ".claude", "commands", "my-cmd.md")
    await writeFile(
      cmdPath,
      `---
name: my-cmd
description: Test location
---

Content here
`,
    )

    const { skills } = await discover()
    const skill = skills.find((s) => s.name === "my-cmd")
    expect(skill).toBeDefined()
    expect(skill!.location).toBe(cmdPath)
  })
})
