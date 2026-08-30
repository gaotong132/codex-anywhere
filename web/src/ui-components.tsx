import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { t } from './i18n';
import type { FileDownloadState } from './app-types';

type SidebarIconName = 'plus' | 'search' | 'panel-open' | 'panel-close';

export type CustomSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export function CustomSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = '',
}: {
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  const openMenu = (index = selectedIndex) => {
    if (disabled || !options.length) return;
    setActiveIndex(index);
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const move = (offset: number) => {
    if (!options.length) return;
    setActiveIndex((current) => (current + offset + options.length) % options.length);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu();
      else move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      openMenu(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else openMenu();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className={`custom-select${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-${activeIndex}` : undefined}
        title={selected?.label}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span>{selected?.label || ''}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="custom-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(node) => { optionRefs.current[index] = node; }}
              id={`${listboxId}-${index}`}
              key={option.value}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === selectedIndex}
              className={`custom-select-option${index === activeIndex ? ' active' : ''}${index === selectedIndex ? ' selected' : ''}`}
              title={option.label}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {index === selectedIndex && <i aria-hidden="true">✓</i>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TypewriterText({
  text,
  active,
  className = '',
  as = 'span',
  showCaret = true,
  completeContent,
  durationMs = 480,
  continuityKey,
  onComplete,
}: {
  text: string;
  active: boolean;
  className?: string;
  as?: 'span' | 'strong';
  showCaret?: boolean;
  completeContent?: ReactNode;
  durationMs?: number;
  continuityKey?: string;
  onComplete?: () => void;
}) {
  const [visibleText, setVisibleText] = useState(() => initialTypewriterText(text, active, continuityKey));
  const visibleTextRef = useRef(visibleText);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!active || reduceMotion) {
      visibleTextRef.current = text;
      setVisibleText(text);
      rememberTypewriterText(continuityKey, text);
      onCompleteRef.current?.();
      return undefined;
    }

    const update = resolveTypewriterUpdate(text, visibleTextRef.current);
    if (!update.animate) {
      visibleTextRef.current = update.from;
      setVisibleText(update.from);
      rememberTypewriterText(continuityKey, update.from);
      onCompleteRef.current?.();
      return undefined;
    }
    const current = update.from;
    const characters = Array.from(text);
    let index = Array.from(current).length;
    const remaining = characters.length - index;
    if (remaining <= 0) {
      onCompleteRef.current?.();
      return undefined;
    }

    const frameMs = 30;
    const frameCount = Math.max(1, Math.round(durationMs / frameMs));
    const charactersPerFrame = Math.max(1, Math.ceil(remaining / frameCount));
    let timer: ReturnType<typeof setInterval>;
    const reveal = () => {
      index = Math.min(characters.length, index + charactersPerFrame);
      const next = characters.slice(0, index).join('');
      visibleTextRef.current = next;
      setVisibleText(next);
      rememberTypewriterText(continuityKey, next);
      if (index >= characters.length) {
        clearInterval(timer);
        onCompleteRef.current?.();
      }
    };
    timer = setInterval(reveal, frameMs);
    reveal();
    return () => clearInterval(timer);
  }, [active, continuityKey, durationMs, text]);

  const typing = active && visibleText !== text;
  const Tag = as;
  return (
    <Tag className={`${className}${className ? ' ' : ''}typewriter-text${typing ? ' typing' : ''}`}>
      <span className="typewriter-copy">{!typing && completeContent ? completeContent : visibleText}</span>
      {typing && showCaret && <i className="typewriter-caret" aria-hidden="true" />}
    </Tag>
  );
}

const typewriterContinuity = new Map<string, string>();

export function seedTypewriterText(continuityKey: string, text: string) {
  rememberTypewriterText(continuityKey, text);
}

export function resolveTypewriterUpdate(text: string, current: string) {
  if (!text.startsWith(current)) return { from: text, animate: false };
  return { from: current, animate: current !== text };
}

function initialTypewriterText(text: string, active: boolean, continuityKey?: string) {
  if (!active) return text;
  const remembered = continuityKey ? typewriterContinuity.get(continuityKey) || '' : '';
  return resolveTypewriterUpdate(text, remembered).from;
}

function rememberTypewriterText(continuityKey: string | undefined, text: string) {
  if (!continuityKey) return;
  typewriterContinuity.delete(continuityKey);
  typewriterContinuity.set(continuityKey, text);
  if (typewriterContinuity.size <= 80) return;
  const oldest = typewriterContinuity.keys().next().value;
  if (oldest) typewriterContinuity.delete(oldest);
}

export function SidebarIcon({ name }: { name: SidebarIconName }) {
  if (name === 'plus') {
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
  }
  if (name === 'search') {
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m14.7 14.7 4.8 4.8" /></svg>;
  }
  if (name === 'panel-open') {
    return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
  }
  return <svg className="sidebar-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>;
}

export function DownloadIndicator({
  download,
  onCancel,
}: {
  download: FileDownloadState | null;
  onCancel: () => void;
}) {
  if (!download) return null;
  const progress = download.size > 0 ? Math.min(100, Math.round(download.received / download.size * 100)) : 0;
  return (
    <div className="download-status" role="status" aria-live="polite">
      <span>{t(`正在下载 ${download.name}`, `Downloading ${download.name}`)}</span>
      <strong>{download.size > 0 ? `${progress}%` : t('准备中', 'Preparing')}</strong>
      <progress value={download.received} max={Math.max(1, download.size)} />
      <button type="button" onClick={onCancel}>{t('取消下载', 'Cancel download')}</button>
    </div>
  );
}
