'use client';

/**
 * A message body, rendered (PLAN.md §3.5 H5/H6, §11.6, §12.1).
 *
 * Every branch below emits React children. There is no `dangerouslySetInnerHTML`
 * in this file and there must never be one: the tokenizer's whole contract is
 * that it hands back data for React to escape, and one innerHTML would undo it.
 *
 * A blocked host is rendered as text with a warning rather than hidden. Hiding
 * it would leave a reader wondering what someone said; showing it un-clickable
 * tells them exactly what was sent and refuses to be the thing that opens it.
 */
import { ShieldAlert } from 'lucide-react';
import { tokenizeMessage } from '@/lib/chat/linkify';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function MessageText({
  body,
  onSeek,
}: {
  body: string;
  /** Null when this client may not steer playback — the timestamp is then text. */
  onSeek: ((seconds: number) => void) | null;
}) {
  const tokens = tokenizeMessage(body);

  return (
    <span className="whitespace-pre-wrap break-words">
      {tokens.map((token, index) => {
        // Index keys: tokens have no identity of their own, and the list is
        // rebuilt wholesale whenever the body changes — which is never, because
        // a message body is immutable once sent.
        const key = `${token.kind}-${index}`;

        if (token.kind === 'text') return <span key={key}>{token.text}</span>;

        if (token.kind === 'link') {
          return (
            <a
              key={key}
              href={token.href}
              target="_blank"
              // `noopener` for the opener capability, `noreferrer` so the
              // destination never learns which room this came from, `nofollow`
              // so we are not a link farm (§3.5 H5).
              rel="noopener noreferrer nofollow"
              className="text-accent-text underline decoration-border-strong underline-offset-2 hover:decoration-current"
            >
              {token.text}
            </a>
          );
        }

        if (token.kind === 'blocked') {
          return (
            <Tooltip key={key}>
              <TooltipTrigger asChild>
                <span className="inline-flex items-baseline gap-1 rounded-sm bg-danger-subtle px-1 text-danger">
                  <ShieldAlert
                    size={12}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="translate-y-0.5"
                  />
                  <span className="break-all">{token.text}</span>
                  <span className="sr-only">
                    Link not clickable: {token.host} is on the blocked list.
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {token.host} is a known link-logging or phishing host. Not clickable.
              </TooltipContent>
            </Tooltip>
          );
        }

        if (onSeek === null) {
          return (
            <span key={key} className="text-secondary">
              {token.text}
            </span>
          );
        }

        return (
          <button
            key={key}
            type="button"
            onClick={() => onSeek(token.seconds)}
            aria-label={`Seek the room to ${token.text.slice(1)}`}
            className="rounded-sm px-0.5 text-accent-text underline decoration-border-strong underline-offset-2 transition-colors duration-120 ease-standard hover:bg-accent-subtle hover:decoration-current"
          >
            {token.text}
          </button>
        );
      })}
    </span>
  );
}
