import {
  DEFAULT_NOTIFICATION_SETTINGS,
  notificationSettingsSchema,
  type NotificationSettings,
} from '@ticketmanager/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { settings } from '../db/schema.js';

export const NOTIFICATION_SETTINGS_KEY = 'notifications';

export async function getNotificationSettings(db: DbOrTx): Promise<NotificationSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, NOTIFICATION_SETTINGS_KEY));
  const parsed = notificationSettingsSchema.safeParse({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...((row?.value as object | undefined) ?? {}),
  });
  return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_SETTINGS;
}
