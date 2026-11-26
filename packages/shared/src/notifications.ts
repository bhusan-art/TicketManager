import { z } from 'zod';
import type { Ref } from './auth.js';
import type { Role } from './roles.js';

/** What a notification is about. The link opens it. */
export const NOTIFICATION_ENTITIES = ['voucher', 'advance'] as const;
export type NotificationEntity = (typeof NOTIFICATION_ENTITIES)[number];

/** One entry in someone's notification centre. */
export interface AppNotification {
  id: string;
  title: string;
  body: string | null;
  /** App path, e.g. /expenses/…, or null. */
  link: string | null;
  entityType: NotificationEntity | null;
  entityId: string | null;
  /** The role to act in; the app switches to it when the notification is opened. */
  role: Role | null;
  actor: Ref | null;
  createdAt: string;
  readAt: string | null;
}

export const notificationListQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
});

export const markNotificationsReadSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);

// ---- Email delivery log ----

export const EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  pending: 'Waiting to send',
  sent: 'Sent',
  failed: 'Failed',
};

export const EMAIL_KINDS = ['invite', 'password_reset', 'notification', 'follow_up'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];
export const EMAIL_KIND_LABELS: Record<EmailKind, string> = {
  invite: 'Invitation',
  password_reset: 'Password reset',
  notification: 'Notification',
  follow_up: 'Follow-up',
};

/** The worker gives up after this many tries and marks the email failed. */
export const EMAIL_MAX_ATTEMPTS = 6;

/** One row of the delivery log Admins see. */
export interface EmailDelivery {
  id: string;
  kind: EmailKind;
  to: string[];
  cc: string[];
  subject: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
}

export const emailLogQuerySchema = z.object({
  status: z.enum(EMAIL_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
});

// ---- Settings ----

export const notificationSettingsSchema = z.object({
  /** In-app notifications are always on; this turns workflow emails on or off. */
  emailEnabled: z.boolean(),
  /** How long an employee waits before sending (another) follow-up reminder. */
  followUpCooldownHours: z.number().int().min(1).max(720),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  emailEnabled: true,
  followUpCooldownHours: 24,
};

// ---- Follow-ups ----

export const followUpSchema = z.object({
  message: z.string().trim().max(500).optional(),
});

/** Whether the employee can nudge whoever holds their claim or advance now. */
export interface FollowUpState {
  /** Who it is waiting on, e.g. "Priya Sharma" or "Accounts". Null when nobody needs nudging. */
  waitingOn: string | null;
  canSend: boolean;
  /** When the cooldown ends, if it hasn't. */
  nextAllowedAt: string | null;
  lastSentAt: string | null;
  cooldownHours: number;
}
