'use client';

import { fmtSize } from '../../../lib/format';
import { cn } from '../../../lib/cn';
import type { FilesValue } from './types';

export function FilesTable({ files }: { files: FilesValue }) {
  if (!files || (typeof files === 'object' && !Array.isArray(files) && 'error' in files)) {
    return (
      <span className="field-hint italic">
        {(files && typeof files === 'object' && 'error' in files && files.error) || 'no files'}
      </span>
    );
  }
  if (!Array.isArray(files) || files.length === 0) {
    return <span className="field-hint italic">empty</span>;
  }
  return (
    <div className="grid gap-0">
      {files.map((f, i) => (
        <div
          key={f.name}
          className={cn(
            'grid grid-cols-[1fr_auto_auto] gap-2.5 py-1.5 text-[11px]',
            i < files.length - 1 && 'border-b border-dashed border-separator-strong',
          )}
        >
          <span className={cn('break-all', f.isDir ? 'text-vermilion' : 'text-ink')}>
            {f.isDir ? '📁 ' : ''}{f.name}
          </span>
          <span className="mono-num text-muted">{fmtSize(f.size)}</span>
          <span className="mono-num text-muted">
            {f.mtime ? new Date(f.mtime).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}


