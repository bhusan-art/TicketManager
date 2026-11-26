import { describe, expect, it } from 'vitest';
import { createUserSchema, loginSchema, passwordSchema } from './index.js';

describe('passwordSchema', () => {
  it('accepts a password meeting every rule', () => {
    expect(passwordSchema.safeParse('Expense#2026').success).toBe(true);
  });

  it('lists each rule a weak password breaks', () => {
    const result = passwordSchema.safeParse('short');
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.message)).toEqual([
      'At least 8 characters',
      'One uppercase letter',
      'One number',
      'One special character',
    ]);
  });
});

describe('emails', () => {
  it('are trimmed and lowercased', () => {
    expect(loginSchema.parse({ email: ' Rahul@Company.COM ', password: 'x' }).email).toBe(
      'rahul@company.com',
    );
  });
});

describe('createUserSchema', () => {
  it('turns blank optional text into null and defaults sendInvite', () => {
    const parsed = createUserSchema.parse({
      email: 'a@b.co',
      name: 'A',
      employeeCode: '  ',
      roles: ['employee'],
    });
    expect(parsed.employeeCode).toBeNull();
    expect(parsed.sendInvite).toBe(true);
  });

  it('needs at least one known role', () => {
    expect(createUserSchema.safeParse({ email: 'a@b.co', name: 'A', roles: [] }).success).toBe(
      false,
    );
    expect(createUserSchema.safeParse({ email: 'a@b.co', name: 'A', roles: ['ceo'] }).success).toBe(
      false,
    );
  });
});
