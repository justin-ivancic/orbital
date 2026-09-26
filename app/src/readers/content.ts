/**
 * Turns chapter files into safe, reader-styled HTML. Saved web pages can carry
 * scripts, trackers, forms and site styling; only the text structure is kept.
 */

const droppedElements = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'NOSCRIPT',
  'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'OPTION', 'LINK', 'META', 'BASE',
  'TITLE', 'HEAD', 'SVG', 'MATH', 'AUDIO', 'VIDEO', 'CANVAS', 'DIALOG', 'NAV',
])

const allowedElements = new Set([
  'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SUB',
  'SUP', 'SMALL', 'MARK', 'SPAN', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE',
  'BLOCKQUOTE', 'Q', 'CITE', 'PRE', 'CODE', 'KBD', 'SAMP', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'COLGROUP', 'COL', 'FIGURE',
  'FIGCAPTION', 'IMG', 'A', 'RUBY', 'RT', 'RP', 'ABBR', 'TIME', 'DEL', 'INS',
])

const allowedAttributes: Record<string, Set<string>> = {
  '*': new Set(['title', 'lang', 'dir', 'id']),
  A: new Set(['href', 'name']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
  TD: new Set(['colspan', 'rowspan']),
  TH: new Set(['colspan', 'rowspan']),
  OL: new Set(['start', 'reversed']),
  TIME: new Set(['datetime']),
}

const safeHref = (value: string) => {
  const trimmed = value.trim()

  if (trimmed.startsWith('#')) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

const safeImageSource = (value: string) => {
  const trimmed = value.trim()

  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(trimmed)) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

const sanitizeNode = (node: Node, doc: Document): Node[] => {
  if (node.nodeType === Node.TEXT_NODE) {
    return [doc.createTextNode(node.textContent ?? '')]
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return []
  }

  const element = node as Element
  const tag = element.tagName.toUpperCase()

  if (droppedElements.has(tag)) {
    return []
  }

  const children = [...element.childNodes].flatMap((child) => sanitizeNode(child, doc))

  if (!allowedElements.has(tag)) {
    // Unknown wrappers (font, center, custom elements) keep their content.
    return children
  }

  const clean = doc.createElement(tag.toLowerCase())
  const allowed = new Set([...allowedAttributes['*'], ...(allowedAttributes[tag] ?? [])])

  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()

    if (!allowed.has(name)) {
      continue
    }

    if (name === 'href') {
      const href = safeHref(attribute.value)

      if (href) {
        clean.setAttribute('href', href)

        if (!href.startsWith('#')) {
          clean.setAttribute('target', '_blank')
          clean.setAttribute('rel', 'noreferrer noopener')
        }
      }
      continue
    }

    if (name === 'src') {
      const source = safeImageSource(attribute.value)

      if (source) {
        clean.setAttribute('src', source)
        clean.setAttribute('loading', 'lazy')
        clean.setAttribute('referrerpolicy', 'no-referrer')
      }
      continue
    }

    clean.setAttribute(name, attribute.value.slice(0, 200))
  }

  if (tag === 'IMG' && !clean.getAttribute('src')) {
    return []
  }

  children.forEach((child) => clean.appendChild(child))
  return [clean]
}

export type ParsedChapter = {
  title: string | null
  html: string
}

/** Extracts and sanitises the readable part of an HTML chapter. */
export const sanitizeChapterHtml = (rawHtml: string): ParsedChapter => {
  const parsed = new DOMParser().parseFromString(rawHtml, 'text/html')
  const root =
    parsed.querySelector('main.chapter, [role="main"], main, article, .chapter-content, #chapter-content, body') ??
    parsed.body
  const title = parsed.querySelector('title')?.textContent?.trim() || root?.querySelector('h1')?.textContent?.trim() || null
  const output = document.implementation.createHTMLDocument('')
  const container = output.createElement('div')

  if (root) {
    ;[...root.childNodes].flatMap((child) => sanitizeNode(child, output)).forEach((child) => container.appendChild(child))
  }

  return { title, html: container.innerHTML.trim() }
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const renderMarkdownInline = (value: string) =>
  escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')

export const plainTextToHtml = (value: string) => {
  const blocks = value.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)

  if (blocks.every((block) => block.trim() === '')) {
    return ''
  }

  return blocks.map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, '<br />')}</p>`).join('')
}

export const markdownToHtml = (value: string) => {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  const paragraph: string[] = []
  let listType: 'ul' | 'ol' | null = null
  let inCodeBlock = false
  let codeLines: string[] = []

  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${renderMarkdownInline(paragraph.join(' ').trim())}</p>`)
      paragraph.length = 0
    }
  }

  const closeList = () => {
    if (listType) {
      output.push(`</${listType}>`)
      listType = null
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (/^```/.test(trimmed)) {
      if (inCodeBlock) {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        codeLines = []
        inCodeBlock = false
      } else {
        flushParagraph()
        closeList()
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    if (!trimmed) {
      flushParagraph()
      closeList()
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeList()
      output.push(`<h${heading[1].length}>${renderMarkdownInline(heading[2])}</h${heading[1].length}>`)
      continue
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/)
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/)

    if (unordered || ordered) {
      flushParagraph()
      const type = unordered ? 'ul' : 'ol'

      if (listType !== type) {
        closeList()
        output.push(`<${type}>`)
        listType = type
      }

      output.push(`<li>${renderMarkdownInline((unordered ?? ordered)![1])}</li>`)
      continue
    }

    const quote = trimmed.match(/^>\s?(.+)$/)
    if (quote) {
      flushParagraph()
      closeList()
      output.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`)
      continue
    }

    paragraph.push(trimmed)
  }

  if (inCodeBlock) {
    output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  }

  flushParagraph()
  closeList()
  return output.join('')
}
