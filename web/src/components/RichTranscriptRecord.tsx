import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import type {
  NormalizedTranscriptRecord,
  TranscriptContentBlock,
  TranscriptMessageRecord,
  TranscriptToolRecord,
} from "@harryaskham/pi-daemon/dashboard-contract";
import {
  AlertCircle,
  Bot,
  BrainCircuit,
  Check,
  Code2,
  FileCode2,
  GitBranch,
  MoreHorizontal,
  TerminalSquare,
  ToolCase,
  UserRound,
} from "../icons";
import { relativeTime } from "../time";

const SyntaxCodeBlock = lazy(() => import("./SyntaxCodeBlock"));

interface RichTranscriptRecordProps {
  record: NormalizedTranscriptRecord;
  streaming?: string;
  resolveBlob?(blobRef: string): string | undefined;
}

function safeImageSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  if (source.startsWith("blob:") || source.startsWith("/dash/v1/")) return source;
  return undefined;
}

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href, "https://dash.invalid");
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined;
    return href;
  } catch {
    return undefined;
  }
}

function InlineMarkdown({ text }: { text: string }) {
  const pattern = /(\`[^`\n]+\`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const value = match[0];
    if (value.startsWith("`")) nodes.push(<code key={start}>{value.slice(1, -1)}</code>);
    else if (value.startsWith("**")) nodes.push(<strong key={start}>{value.slice(2, -2)}</strong>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
      const href = link?.[2] ? safeHref(link[2]) : undefined;
      nodes.push(href ? <a key={start} href={href} target="_blank" rel="noreferrer noopener">{link?.[1]}</a> : value);
    }
    cursor = start + value.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function CollapsibleText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? 100_000 : 8_000;
  const bounded = text.slice(0, limit);
  return (
    <div className={className}>
      <p>{bounded}</p>
      {text.length > limit ? <button type="button" className="content-expand" onClick={() => setExpanded(true)}>Show bounded full content · {text.length.toLocaleString()} chars</button> : null}
    </div>
  );
}

function MarkdownBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? 100_000 : 12_000;
  const bounded = text.slice(0, limit);
  const blocks: ReactNode[] = [];
  const fence = /```([\w+-]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let blockIndex = 0;

  function renderProse(prose: string): void {
    const lines = prose.split("\n");
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      blocks.push(<p key={`p-${blockIndex++}`}><InlineMarkdown text={paragraph.join(" ")} /></p>);
      paragraph = [];
    };
    for (const line of lines) {
      if (line.trim().length === 0) {
        flush();
      } else if (/^#{1,4}\s/.test(line)) {
        flush();
        const content = line.replace(/^#{1,4}\s+/, "");
        blocks.push(<h4 key={`h-${blockIndex++}`}><InlineMarkdown text={content} /></h4>);
      } else if (/^[-*]\s/.test(line)) {
        flush();
        blocks.push(<div className="markdown-list-item" key={`li-${blockIndex++}`}><i /><span><InlineMarkdown text={line.replace(/^[-*]\s+/, "")} /></span></div>);
      } else if (/^>\s?/.test(line)) {
        flush();
        blocks.push(<blockquote key={`q-${blockIndex++}`}><InlineMarkdown text={line.replace(/^>\s?/, "")} /></blockquote>);
      } else {
        paragraph.push(line);
      }
    }
    flush();
  }

  for (const match of bounded.matchAll(fence)) {
    const start = match.index ?? 0;
    renderProse(bounded.slice(cursor, start));
    blocks.push(
      <Suspense key={`code-${blockIndex++}`} fallback={<pre className="code-loading">Loading bounded highlighter…</pre>}>
        <SyntaxCodeBlock language={match[1] || "text"} code={match[2] ?? ""} />
      </Suspense>,
    );
    cursor = start + match[0].length;
  }
  renderProse(bounded.slice(cursor));
  return <div className="markdown-body">{blocks}{text.length > limit ? <button type="button" className="content-expand" onClick={() => setExpanded(true)}>Show bounded full markdown · {text.length.toLocaleString()} chars</button> : null}</div>;
}

function usage(blocks: TranscriptContentBlock[]) {
  return blocks.find((block) => block.type === "usage");
}

function MessageBlock({
  block,
  resolveBlob,
}: {
  block: TranscriptContentBlock;
  resolveBlob?: (blobRef: string) => string | undefined;
}) {
  if (block.type === "usage") return null;
  if (block.type === "image") {
    const source = safeImageSource(resolveBlob?.(block.blobRef));
    return source ? (
      <figure className="message-image"><img src={source} loading="lazy" referrerPolicy="no-referrer" alt={block.alt ?? "Session attachment"} /><figcaption>{block.alt ?? block.mediaType}</figcaption></figure>
    ) : (
      <figure className="message-image message-image--placeholder"><FileCode2 size={20} /><figcaption>{block.alt ?? "Authorized image preview"}<small>{block.width && block.height ? `${block.width}×${block.height}` : block.mediaType}</small></figcaption></figure>
    );
  }
  if (block.type === "thinking") {
    return <details className="thinking-block"><summary><BrainCircuit size={13} /> Reasoning</summary><CollapsibleText text={block.text} /></details>;
  }
  if (block.type === "error") {
    return <div className="message-error" role="alert"><AlertCircle size={15} /><CollapsibleText text={block.text} /></div>;
  }
  return block.type === "markdown" ? <MarkdownBody text={block.text} /> : <CollapsibleText text={block.text} />;
}

function MessageRecord({ record, streaming, resolveBlob }: {
  record: TranscriptMessageRecord;
  streaming?: string;
  resolveBlob?: (blobRef: string) => string | undefined;
}) {
  const assistant = record.role !== "user";
  const thinking = record.content.some((block) => block.type === "thinking");
  const visualRole = thinking ? "thinking" : assistant ? "assistant" : "user";
  const usageBlock = usage(record.content);
  return (
    <article className={`message message--${visualRole} message--state-${record.state}`}>
      <div className="message__avatar" aria-hidden="true">
        {thinking ? <BrainCircuit size={15} /> : assistant ? <Bot size={15} /> : <UserRound size={15} />}
      </div>
      <div className="message__body">
        <header>
          <strong>{thinking ? "Reasoning" : record.role === "user" ? "You" : record.role === "system" ? "System" : "Pi"}</strong>
          <span className={`record-source record-source--${record.source}`}>{record.source}</span>
          {record.timestamp ? <time dateTime={record.timestamp}>{relativeTime(record.timestamp)}</time> : null}
        </header>
        {record.content.map((block, index) => <MessageBlock key={index} block={block} {...(resolveBlob ? { resolveBlob } : {})} />)}
        {streaming ? <p>{streaming}<span className="stream-caret" /></p> : null}
        {usageBlock?.type === "usage" ? <footer>{(usageBlock.inputTokens ?? 0).toLocaleString()} in · {(usageBlock.outputTokens ?? 0).toLocaleString()} out{usageBlock.cost !== undefined ? ` · $${usageBlock.cost.toFixed(4)}` : ""}</footer> : null}
      </div>
    </article>
  );
}

function argument(record: TranscriptToolRecord, key: string): string | undefined {
  const value = record.arguments?.[key];
  return typeof value === "string" ? value : undefined;
}

function toolTitle(record: TranscriptToolRecord): string {
  const path = argument(record, "path") ?? argument(record, "file") ?? argument(record, "cwd");
  const pattern = argument(record, "pattern") ?? argument(record, "query");
  if (record.toolName === "bash") return argument(record, "command") ?? "Run shell command";
  if (record.toolName === "read") return path ? `Read ${path}` : "Read file";
  if (record.toolName === "edit") return path ? `Edit ${path}` : "Apply edit";
  if (record.toolName === "write") return path ? `Write ${path}` : "Write file";
  if (["grep", "search"].includes(record.toolName)) return pattern ? `Search for ${pattern}` : "Search project";
  if (["find", "ls", "list"].includes(record.toolName)) return path ? `List ${path}` : "List files";
  return argument(record, "title") ?? record.toolName;
}

function toolText(record: TranscriptToolRecord): string {
  return record.content.map((block) => block.type === "image" ? block.alt ?? "Image output" : block.type === "usage" ? "" : block.text).filter(Boolean).join("\n");
}

function ToolOutput({ record }: { record: TranscriptToolRecord }) {
  const text = toolText(record);
  const isDiff = record.toolName === "edit" || /^[-+]{1}[^-+]/m.test(text);
  if (isDiff) {
    return <pre className="diff-output">{text.split("\n").slice(0, 400).map((line, index) => <span key={index} className={line.startsWith("+") ? "diff-line--add" : line.startsWith("-") ? "diff-line--remove" : ""}>{line || " "}{"\n"}</span>)}</pre>;
  }
  if (record.toolName === "bash" || record.toolName === "read" || ["grep", "search", "find", "ls", "list"].includes(record.toolName)) {
    return <Suspense fallback={<pre className="code-loading">Loading output…</pre>}><SyntaxCodeBlock language={record.toolName === "bash" ? "shell" : "text"} code={text} /></Suspense>;
  }
  return <pre className="generic-tool-output">{text.slice(0, 20_000)}</pre>;
}

function ToolRecord({ record }: { record: TranscriptToolRecord }) {
  const [expanded, setExpanded] = useState(record.state === "error" || record.state === "running");
  const title = toolTitle(record);
  const details = record.details;
  const durationMs = details && typeof details === "object" && !Array.isArray(details) && typeof details.durationMs === "number" ? details.durationMs : undefined;
  const icon = record.toolName === "bash" ? <TerminalSquare size={15} /> : ["edit", "write"].includes(record.toolName) ? <Code2 size={15} /> : <ToolCase size={15} />;
  return (
    <article className={`tool-card tool-card--${record.state} tool-card--${record.toolName}`}>
      <div className="tool-card__icon">{icon}</div>
      <div className="tool-card__copy">
        <header><strong>{title}</strong><span>{record.toolName}</span></header>
        <p>{toolText(record).slice(0, 180) || "No printable output"}</p>
        <footer>
          {record.state === "pending" || record.state === "running" ? <><i /> running</> : record.state === "error" ? <><AlertCircle size={12} /> attention</> : <><Check size={12} /> complete</>}
          {durationMs ? <time>{durationMs} ms</time> : null}
        </footer>
        {expanded ? <ToolOutput record={record} /> : null}
      </div>
      <button type="button" aria-label={`${expanded ? "Hide" : "Show"} details for ${title}`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><MoreHorizontal size={15} /></button>
    </article>
  );
}

function TimelineRecord({ record }: { record: Extract<NormalizedTranscriptRecord, { kind: "timeline" }> }) {
  const detail = typeof record.data?.detail === "string" ? record.data.detail : record.event;
  return <div className={`timeline-record timeline-record--${record.event}`}><i />{record.event === "compaction" ? <GitBranch size={12} /> : null}<strong>{record.label ?? record.event}</strong><span>{detail}</span></div>;
}

function SummaryRecord({ record }: { record: Extract<NormalizedTranscriptRecord, { kind: "summary" }> }) {
  const text = record.content.map((block) => block.type === "image" || block.type === "usage" ? "" : block.text).filter(Boolean).join("\n");
  return <article className="summary-card"><GitBranch size={15} /><div><strong>{record.summaryKind === "compaction" ? "Context compacted" : "Branch summary"}</strong><MarkdownBody text={text} /></div></article>;
}

function CustomRecord({ record }: { record: Extract<NormalizedTranscriptRecord, { kind: "custom" }> }) {
  return <article className={`custom-record${record.hidden ? " custom-record--hidden" : ""}`}><FileCode2 size={14} /><div><strong>{record.customType}</strong><p>{record.fallbackText ?? (record.hidden ? "Hidden custom entry" : "Custom extension entry")}</p></div></article>;
}

export function RichTranscriptRecord({ record, streaming, resolveBlob }: RichTranscriptRecordProps) {
  return useMemo(() => {
    if (record.kind === "message") return <MessageRecord record={record} {...(streaming ? { streaming } : {})} {...(resolveBlob ? { resolveBlob } : {})} />;
    if (record.kind === "tool") return <ToolRecord record={record} />;
    if (record.kind === "timeline") return <TimelineRecord record={record} />;
    if (record.kind === "summary") return <SummaryRecord record={record} />;
    return <CustomRecord record={record} />;
  }, [record, resolveBlob, streaming]);
}
