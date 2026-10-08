import { z } from 'zod';

/** Largest page the server returns; a larger `page_size` is capped (api-contract §18). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** `page` and `page_size` query parameters: 1-based, page size capped at MAX_PAGE_SIZE. */
export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_PAGE_SIZE)
    .transform((n) => Math.min(n, MAX_PAGE_SIZE)),
};

export interface Page {
  page: number;
  page_size: number;
}

/** `LIMIT`/`OFFSET` values for a page. */
export function limitOffset({ page, page_size }: Page): { limit: number; offset: number } {
  return { limit: page_size, offset: (page - 1) * page_size };
}

/** The `meta` of a paged list response, without `request_id`. */
export function pageMeta({ page, page_size }: Page, totalItems: number) {
  return { page, page_size, total_items: totalItems, total_pages: Math.ceil(totalItems / page_size) };
}
