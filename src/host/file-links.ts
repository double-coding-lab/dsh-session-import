/**
 * Provider-level local-file link adaptation.
 *
 * Source tools disagree on how a file reference looks: Qoder writes
 * `[name](file:///D:/…)`, another tool may write a bare absolute path or a
 * workspace-relative one. The rules live in `providers/<id>/provider.json`;
 * this module only executes them.
 *
 * Output is DSH-native: assistant links become inline code so the closing
 * message's file-mention resolver can turn them into clickable chips, and the
 * same paths ride on the event for `deliverables/presented`.
 */
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FileLinkRule, SourceEvent, SourceFileReference } from '../shared/types.ts'

export interface FileLinkAdaptation {
  events: SourceEvent[]
  /** Accepted link occurrences. */
  links: number
  /** Distinct files carried by those links. */
  files: number
}

interface CodeRange {
  start: number
  end: number
}

export interface MarkdownLink {
  start: number
  end: number
  label: string
  href: string
}

interface AcceptedLink {
  eventIndex: number
  link: MarkdownLink
  path: string
}

/** Path separator differs by platform; DSH splits both when matching basenames. */
function basenamePortable(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** Accept POSIX, Windows drive, and UNC absolutes regardless of the host OS. */
function isAbsoluteAny(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** URL-style `/E:/…` is a Windows drive path with a leading slash. */
function hostAbsolute(path: string): string {
  return process.platform === 'win32' ? path.replace(/^\/+([A-Za-z]:[\\/])/u, '$1') : path
}

/** Fenced blocks and inline code must stay literal; links inside them are examples. */
function codeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm
  const fenceRanges: CodeRange[] = []
  let open: { marker: string; start: number } | undefined
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    const marker = match[1]!
    const end = match.index + match[0].length
    if (open === undefined) {
      open = { marker, start: match.index }
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      fenceRanges.push({ start: open.start, end })
      open = undefined
    }
  }
  if (open !== undefined) fenceRanges.push({ start: open.start, end: text.length })
  ranges.push(...fenceRanges)

  const inline = /(`+)([^`]*?)\1/g
  while ((match = inline.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (!fenceRanges.some(range => start >= range.start && start < range.end)) {
      ranges.push({ start, end })
    }
  }
  ranges.sort((left, right) => left.start - right.start)
  return ranges
}

function inRanges(position: number, ranges: readonly CodeRange[]): boolean {
  return ranges.some(range => position >= range.start && position < range.end)
}

/** Read `href` and the closing parenthesis from just after `](`. */
function parseDestination(text: string, from: number): { href: string; end: number } | undefined {
  let index = from
  while (index < text.length && /\s/u.test(text[index]!)) index += 1
  if (index >= text.length) return undefined

  let href: string
  if (text[index] === '<') {
    const close = text.indexOf('>', index + 1)
    if (close === -1) return undefined
    href = text.slice(index + 1, close)
    index = close + 1
  } else {
    const start = index
    let depth = 0
    while (index < text.length) {
      const char = text[index]!
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '(') {
        depth += 1
      } else if (char === ')') {
        if (depth === 0) break
        depth -= 1
      } else if (/\s/u.test(char) && depth === 0) {
        break
      }
      index += 1
    }
    href = text.slice(start, index)
  }

  // Optional title: `"…"`, `'…'`, or `(…)`.
  while (index < text.length && /\s/u.test(text[index]!)) index += 1
  const quote = text[index]
  if (quote === '"' || quote === "'" || quote === '(') {
    const closeQuote = quote === '(' ? ')' : quote
    const close = text.indexOf(closeQuote, index + 1)
    if (close !== -1) index = close + 1
  }
  while (index < text.length && text[index] !== ')') index += 1
  if (index >= text.length) return undefined
  return { href: href.trim(), end: index + 1 }
}

/** Inline markdown links outside code spans and fences. */
function scanMarkdownLinks(text: string, ranges: readonly CodeRange[]): MarkdownLink[] {
  const links: MarkdownLink[] = []
  let cursor = 0
  while (cursor < text.length) {
    const closeBracket = text.indexOf('](', cursor)
    if (closeBracket === -1) break
    cursor = closeBracket + 2
    if (inRanges(closeBracket, ranges)) continue

    const openBracket = text.lastIndexOf('[', closeBracket - 1)
    if (openBracket === -1 || inRanges(openBracket, ranges)) continue
    if (openBracket > 0 && (text[openBracket - 1] === '!' || text[openBracket - 1] === '\\')) continue
    const label = text.slice(openBracket + 1, closeBracket)
    if (label.includes('\n\n')) continue

    const destination = parseDestination(text, closeBracket + 2)
    if (destination === undefined) continue
    links.push({ start: openBracket, end: destination.end, label, href: destination.href })
    cursor = destination.end
  }
  return links
}

/** Inline markdown links outside code spans and fences. */
export function markdownLinksIn(text: string): MarkdownLink[] {
  return scanMarkdownLinks(text, codeRanges(text))
}

/** Resolve one markdown destination under one rule, or decline. */
function pathForHref(href: string, rule: FileLinkRule, cwd: string | undefined): string | undefined {
  if (href === '') return undefined
  let path: string | undefined

  if (rule.accept.includes('file-url')) {
    try {
      const url = new URL(href)
      if (url.protocol === 'file:') {
        url.search = ''
        url.hash = ''
        path = fileURLToPath(url)
      }
    } catch {
      // Not a URL; fall through to plain-path rules.
    }
  }

  if (path === undefined) {
    const stripped = href.replace(/[?#].*$/su, '')
    const decoded = decodeSafe(stripped)
    if (rule.accept.includes('absolute-path') && isAbsoluteAny(decoded)) {
      path = hostAbsolute(decoded)
    } else if (
      rule.accept.includes('relative-path') &&
      cwd !== undefined &&
      decoded !== '' &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)
    ) {
      path = resolve(cwd, decoded)
    }
  }

  if (path === undefined || path === '') return undefined
  if (path.endsWith('/') || path.endsWith('\\')) return undefined
  const extension = extname(path).toLowerCase()
  if (rule.extensions !== undefined && rule.extensions.length > 0) {
    const allowed = rule.extensions.map(item => item.toLowerCase())
    if (!allowed.includes(extension)) return undefined
  }
  return resolve(path)
}

function inlineCode(value: string): string {
  const runs = value.match(/`+/gu) ?? []
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  return `${fence}${value}${fence}`
}

/**
 * Rewrite provider-recognized local links into inline code and attach the
 * referenced files to each assistant event. Deterministic: the result depends
 * only on source text and provider rules, never on whether a file still exists.
 */
export function adaptFileLinks(
  events: SourceEvent[],
  rules: readonly FileLinkRule[] | undefined,
  cwd: string | undefined,
): FileLinkAdaptation {
  if (rules === undefined || rules.length === 0) {
    return { events, links: 0, files: 0 }
  }

  const accepted: AcceptedLink[] = []
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!
    if (event.kind !== 'assistant') continue
    const links = scanMarkdownLinks(event.text, codeRanges(event.text))
    for (const link of links) {
      for (const rule of rules) {
        if (rule.syntax !== 'markdown-link') continue
        const path = pathForHref(link.href, rule, cwd)
        if (path !== undefined) {
          accepted.push({ eventIndex, link, path })
          break
        }
      }
    }
  }

  if (accepted.length === 0) {
    return { events, links: 0, files: 0 }
  }

  const pathsByBasename = new Map<string, Set<string>>()
  for (const { path } of accepted) {
    const name = basenamePortable(path).toLowerCase()
    const paths = pathsByBasename.get(name) ?? new Set<string>()
    paths.add(path)
    pathsByBasename.set(name, paths)
  }

  const chipText = (path: string): string => {
    const name = basenamePortable(path)
    return (pathsByBasename.get(name.toLowerCase())?.size ?? 0) === 1 ? name : path
  }

  const byEvent = new Map<number, AcceptedLink[]>()
  for (const link of accepted) {
    const list = byEvent.get(link.eventIndex) ?? []
    list.push(link)
    byEvent.set(link.eventIndex, list)
  }

  const files = new Set<string>()
  const output = events.map((event, eventIndex) => {
    const links = byEvent.get(eventIndex)
    if (links === undefined || event.kind !== 'assistant') return event

    const referenced: SourceFileReference[] = []
    const seen = new Set<string>((event.files ?? []).map(file => file.path))
    for (const { path, link } of links) {
      if (seen.has(path)) continue
      seen.add(path)
      files.add(path)
      const name = basenamePortable(path)
      const label = link.label.replace(/\s+/gu, ' ').trim()
      referenced.push({
        path,
        ...(label !== '' && label !== name && label !== path ? { description: label } : {}),
      })
    }

    let text = ''
    let cursor = 0
    for (const { path, link } of [...links].sort((left, right) => left.link.start - right.link.start)) {
      text += event.text.slice(cursor, link.start) + inlineCode(chipText(path))
      cursor = link.end
    }
    text += event.text.slice(cursor)

    return {
      ...event,
      text,
      ...(event.files === undefined && referenced.length === 0
        ? {}
        : { files: [...(event.files ?? []), ...referenced] }),
    }
  })

  return { events: output, links: accepted.length, files: files.size }
}
