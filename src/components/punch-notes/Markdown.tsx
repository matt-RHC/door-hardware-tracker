/**
 * Minimal markdown renderer for AI-generated punch-notes summaries.
 *
 * The notes-summarizer prompt constrains the model to a small subset of
 * markdown (## / ### headings, - bullets, **bold**, paragraph breaks). A
 * full library like react-markdown would handle anything but adds a 30kb
 * client dependency for behavior we don't need. This 60-line renderer
 * covers the prompt's explicit grammar; anything outside it (tables,
 * code blocks, links) renders as the original markdown text — readable
 * but unstyled.
 */

interface Props {
  source: string
  className?: string
}

export function Markdown({ source, className = '' }: Props) {
  const blocks = parseBlocks(source)
  return (
    <div className={`markdown-summary text-[13px] text-primary leading-relaxed space-y-3 ${className}`}>
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  )
}

type Block =
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'p'; text: string }

function parseBlocks(source: string): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let currentList: string[] | null = null
  let currentParagraph: string[] | null = null

  const flushList = () => {
    if (currentList && currentList.length > 0) {
      blocks.push({ type: 'ul', items: currentList })
    }
    currentList = null
  }
  const flushParagraph = () => {
    if (currentParagraph && currentParagraph.length > 0) {
      blocks.push({ type: 'p', text: currentParagraph.join(' ') })
    }
    currentParagraph = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (line === '') {
      flushList()
      flushParagraph()
      continue
    }

    if (line.startsWith('## ')) {
      flushList()
      flushParagraph()
      blocks.push({ type: 'h2', text: line.slice(3).trim() })
      continue
    }
    if (line.startsWith('### ')) {
      flushList()
      flushParagraph()
      blocks.push({ type: 'h3', text: line.slice(4).trim() })
      continue
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/)
    if (bulletMatch) {
      flushParagraph()
      if (!currentList) currentList = []
      currentList.push(bulletMatch[1])
      continue
    }

    flushList()
    if (!currentParagraph) currentParagraph = []
    currentParagraph.push(line.trim())
  }
  flushList()
  flushParagraph()

  return blocks
}

function renderBlock(block: Block, key: number) {
  switch (block.type) {
    case 'h2':
      return (
        <h2 key={key} className="text-[15px] font-semibold text-primary mt-4 first:mt-0">
          {renderInline(block.text)}
        </h2>
      )
    case 'h3':
      return (
        <h3 key={key} className="text-[14px] font-semibold text-secondary mt-3">
          {renderInline(block.text)}
        </h3>
      )
    case 'ul':
      return (
        <ul key={key} className="list-disc list-outside pl-5 space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      )
    case 'p':
      return (
        <p key={key} className="text-[13px] text-primary">
          {renderInline(block.text)}
        </p>
      )
  }
}

/** Inline parser: just **bold**. Other inline syntax (italic, links) is
 *  not used by the prompt; if the model emits it, it shows as-is. */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const regex = /\*\*([^*]+)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(<strong key={key++} className="font-semibold">{match[1]}</strong>)
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}
