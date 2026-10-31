/** Escape LIKE wildcards so user text such as "50%" or "a_b" is matched literally by Prisma's `contains`. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
