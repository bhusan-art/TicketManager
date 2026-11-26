import type { EmailJob } from '@ticketmanager/shared';

const footer = '\n\nIf you did not expect this email, you can ignore it.\n\nTicketManager';

export function inviteEmail(to: string, name: string, link: string): EmailJob {
  return {
    to,
    subject: 'Your TicketManager account',
    text:
      `Hi ${name},\n\nAn account has been created for you in TicketManager, the expense management app.\n\n` +
      `Set your password here (the link works for 7 days):\n${link}` +
      footer,
  };
}

export function resetEmail(to: string, name: string, link: string): EmailJob {
  return {
    to,
    subject: 'Reset your TicketManager password',
    text:
      `Hi ${name},\n\nWe received a request to reset your password.\n\n` +
      `Choose a new password here (the link works for 1 hour):\n${link}` +
      footer,
  };
}
