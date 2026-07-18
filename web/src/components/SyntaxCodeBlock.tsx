import { useMemo, useState } from "react";
import { Check, Code2 } from "../icons";

interface SyntaxCodeBlockProps {
  code: string;
  language?: string;
}

type TokenKind = "comment" | "keyword" | "number" | "string" | "plain";
interface Token { kind: TokenKind; text: string }

const tokenPattern = /(\/\/.*$|#(?![0-9a-f]{3,8}\b).*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:async|await|break|case|catch|class|const|continue|default|do|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|of|return|switch|throw|true|try|type|undefined|while)\b|\b\d+(?:\.\d+)?\b)/gm;
const keywordPattern = /^(?:async|await|break|case|catch|class|const|continue|default|do|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|of|return|switch|throw|true|try|type|undefined|while)$/;

function tokenKind(text: string): TokenKind {
  if (text.startsWith("//") || text.startsWith("#")) return "comment";
  if (text.startsWith("\"") || text.startsWith("'")) return "string";
  if (keywordPattern.test(text)) return "keyword";
  if (/^\d/.test(text)) return "number";
  return "plain";
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of code.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: "plain", text: code.slice(cursor, start) });
    const text = match[0];
    tokens.push({ kind: tokenKind(text), text });
    cursor = start + text.length;
  }
  if (cursor < code.length) tokens.push({ kind: "plain", text: code.slice(cursor) });
  return tokens;
}

export default function SyntaxCodeBlock({ code, language = "text" }: SyntaxCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const bounded = code.slice(0, 20_000).split("\n").slice(0, 400).join("\n");
  const truncated = bounded.length < code.length;
  const tokens = useMemo(() => tokenize(bounded), [bounded]);

  async function copy(): Promise<void> {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(bounded);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="syntax-block">
      <header><span><Code2 size={12} />{language}</span><button type="button" onClick={() => void copy()}>{copied ? <><Check size={11} /> copied</> : "copy"}</button></header>
      <pre><code>{tokens.map((token, index) => <span key={index} className={`syntax-token syntax-token--${token.kind}`}>{token.text}</span>)}</code></pre>
      {truncated ? <footer>Preview truncated at 20,000 characters / 400 lines</footer> : null}
    </div>
  );
}
