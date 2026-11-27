import '@chatscope/chat-ui-kit-styles/dist/default/styles.min.css';
import {
  Message,
  MessageList,
  MessageSeparator,
  type MessageModel,
} from '@chatscope/chat-ui-kit-react';
import {
  CHAT_MESSAGE_MAX,
  ROLE_LABELS,
  type ChatMessage,
  type ChatThread,
} from '@ticketmanager/shared';
import { MessagesSquare, Send } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useUser } from '../auth/AuthContext';
import { ApiError, apiGet, apiPost } from '../lib/api';
import { FormError } from './forms';

/** How often an open chat checks for new messages, in ms. */
export const CHAT_POLL_MS = 5000;

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Where a message sits in a run from the same author, for the bubble shape. */
function position(list: ChatMessage[], i: number): MessageModel['position'] {
  const same = (j: number) =>
    list[j] !== undefined &&
    list[j]!.author.id === list[i]!.author.id &&
    dayFormat.format(new Date(list[j]!.createdAt)) ===
      dayFormat.format(new Date(list[i]!.createdAt));
  const prev = same(i - 1);
  const next = same(i + 1);
  if (prev && next) return 'normal';
  if (prev) return 'last';
  if (next) return 'first';
  return 'single';
}

/**
 * The chat on a claim or advance: the employee and whoever reviews or pays it talk here. It
 * appears once the claim is submitted, and checks for new messages while it is on screen.
 * `path` is /vouchers/:id or /advances/:id.
 */
export function ClaimChat({ path, label = 'claim' }: { path: string; label?: string }) {
  const user = useUser();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastId = useRef<number | undefined>(undefined);

  const add = useCallback((more: ChatMessage[]) => {
    if (more.length === 0) return;
    setMessages((list) => {
      const seen = new Set(list.map((m) => m.id));
      const next = [...list, ...more.filter((m) => !seen.has(m.id))];
      lastId.current = next[next.length - 1]?.id;
      return next;
    });
  }, []);

  useEffect(() => {
    let active = true;

    async function load() {
      if (document.visibilityState === 'hidden') return;
      const after = lastId.current;
      try {
        const t = await apiGet<ChatThread>(
          `${path}/chat${after !== undefined ? `?after=${after}` : ''}`,
        );
        if (!active) return;
        setCanPost(t.canPost);
        add(t.messages);
        setLoaded(true);
      } catch {
        // A missed check is retried on the next tick.
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), CHAT_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [path, add]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      add([await apiPost<ChatMessage>(`${path}/chat`, { body })]);
      setDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the message');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded || !canPost) return null;

  return (
    <section className="card wide claim-chat" aria-label="Chat">
      <div className="claim-chat-head">
        <h2>
          <MessagesSquare size={18} aria-hidden /> Chat
        </h2>
        <span className="muted small">
          Ask or answer questions about this {label}. Everyone working on it can read along.
        </span>
      </div>
      <div className="claim-chat-list">
        <MessageList autoScrollToBottomOnMount autoScrollToBottom scrollBehavior="auto">
          {messages.length === 0 && (
            <MessageList.Content className="claim-chat-empty">
              No messages yet. Start the conversation below.
            </MessageList.Content>
          )}
          {messages.map((m, i) => {
            const mine = m.author.id === user.id;
            const pos = position(messages, i);
            const day = dayFormat.format(new Date(m.createdAt));
            const newDay =
              i === 0 || dayFormat.format(new Date(messages[i - 1]!.createdAt)) !== day;
            return (
              <Fragment key={m.id}>
                {newDay && <MessageSeparator content={day} />}
                <Message
                  model={{
                    type: 'custom',
                    direction: mine ? 'outgoing' : 'incoming',
                    position: pos,
                    sender: m.author.name,
                    sentTime: m.createdAt,
                  }}
                >
                  {!mine && (pos === 'single' || pos === 'first') && (
                    <Message.Header sender={`${m.author.name} · ${ROLE_LABELS[m.authorRole]}`} />
                  )}
                  <Message.CustomContent>
                    <span className="claim-chat-text">{m.body}</span>
                  </Message.CustomContent>
                  <Message.Footer sentTime={timeFormat.format(new Date(m.createdAt))} />
                </Message>
              </Fragment>
            );
          })}
        </MessageList>
      </div>
      <form className="claim-chat-compose" onSubmit={send} noValidate>
        <textarea
          aria-label="Message"
          placeholder="Write a message…"
          rows={2}
          maxLength={CHAT_MESSAGE_MAX}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
          <Send size={16} aria-hidden /> Send
        </button>
      </form>
      <FormError message={error} />
    </section>
  );
}
