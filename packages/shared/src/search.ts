import { z } from 'zod';

/** The search box in the top bar: claims, advances and (for admins) people. */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
});

export const SEARCH_LIMIT = 6;

export interface SearchHit {
  id: string;
  /** e.g. the claim's purpose, or a person's name. */
  title: string;
  /** e.g. "EXP-2026-00012 · Rahul Das". */
  subtitle: string;
  /** Where to open it in the app. */
  path: string;
  amountPaise?: number;
  /** An approval or advance status, for the status pill. */
  status?: string;
}

export interface SearchResponse {
  claims: SearchHit[];
  advances: SearchHit[];
  people: SearchHit[];
}
