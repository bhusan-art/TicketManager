import { z } from 'zod';
import type { Ref } from './auth.js';
import type { Role } from './roles.js';

/** Longest chat message, in characters. */
export const CHAT_MESSAGE_MAX = 2000;
/** How many of the latest messages a chat loads at once. */
export const CHAT_PAGE = 200;

/** One message in the chat on a claim or advance. */
export interface ChatMessage {
  id: number;
  author: Ref;
  /** The role the author wrote in, e.g. accounts. */
  authorRole: Role;
  body: string;
  createdAt: string;
}

/** The chat on a claim or advance, oldest message first. */
export interface ChatThread {
  messages: ChatMessage[];
  /** False until the claim or advance has been submitted. */
  canPost: boolean;
}

export const postChatMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a message')
    .max(CHAT_MESSAGE_MAX, `Keep it under ${CHAT_MESSAGE_MAX} characters`),
});

export const chatQuerySchema = z.object({
  /** Only messages newer than this id, for polling. */
  after: z.coerce.number().int().min(0).optional(),
});
