'use client';

import { useState } from 'react';
import { useCopyToClipboard } from 'usehooks-ts';

interface CodeBlockProps {
  children: string;
  lang?: string;
}

export default function CodeBlock({ children, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [, copyToClipboard] = useCopyToClipboard();
  const text = String(children).trim();

  const copy = async () => {
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const label = (lang || 'sh').toUpperCase();

  return (
    <pre className="bs-code" data-lang={lang || 'sh'}>
      <span className="bs-code-lang" aria-hidden="true">{label}</span>
      <button
        type="button"
        className="bs-copy"
        data-copied={copied ? 'true' : 'false'}
        onClick={copy}
        aria-label="Copy to clipboard"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <code>{text}</code>
    </pre>
  );
}
