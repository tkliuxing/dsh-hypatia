/**
 * Packaged skill registration.
 *
 * Skills are documentation the model can load on demand. They no longer carry
 * the automatic memory protocol - that moved into host code - so what remains
 * is guidance for explicit, user-driven knowledge-graph work.
 *
 * @module dsh-hypatia/skills
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Parse the small controlled frontmatter of a packaged SKILL.md.
 * Only the keys these skills use are supported: scalar values, double-quoted
 * strings, and booleans. Keep SKILL.md frontmatter inside that subset.
 */
export function parseSkillFile(file) {
  const raw = readFileSync(file, 'utf8')
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) throw new Error(`${file}: missing frontmatter block`)
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    }
    meta[kv[1]] = value
  }
  return { meta, content: raw.slice(match[0].length) }
}

/**
 * Register every packaged skill directory (`<name>/SKILL.md`).
 *
 * @param {object} ctx cordis context providing `skills`
 * @param {{skillsDir: string, warn: (msg: string) => void}} deps
 * @returns {number} how many skills were registered
 */
export function registerSkills(ctx, { skillsDir, warn }) {
  if (!existsSync(skillsDir)) {
    warn(`skills directory missing: ${skillsDir} - package is incomplete, reinstall the plugin`)
    return 0
  }
  let count = 0
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(skillsDir, entry.name)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue

    let parsed
    try {
      parsed = parseSkillFile(file)
    } catch (error) {
      warn(`${file}: ${error.message}, skipped`)
      continue
    }
    const { meta, content } = parsed
    if (!meta.name || !meta.description) {
      warn(`${file}: frontmatter requires name and description, skipped`)
      continue
    }

    ctx.skills.register({
      name: meta.name,
      description: meta.description,
      content,
      source: 'bundled',
      path: file,
      resourceBase: { kind: 'directory', path: dir },
      invocation: {
        modelInvocable: meta['disable-model-invocation'] !== 'true',
        userInvocable: meta['user-invocable'] !== 'false',
      },
    })
    count += 1
  }
  return count
}
