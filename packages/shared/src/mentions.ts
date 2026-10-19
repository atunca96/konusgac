// Mentions travel inside message content as <@userId>; the client writes @username and
// converts it before sending, and turns it back into @username when editing.

export const USER_MENTION = /<@(\d{1,20})>/g;
export const EVERYONE_MENTION = /(^|[\s(])@everyone(?=$|[\s.,!?:;)])/;

export function mentionedUserIds(content: string): string[] {
  return [...new Set([...content.matchAll(USER_MENTION)].map((m) => m[1]!))];
}

export function mentionsEveryone(content: string): boolean {
  return EVERYONE_MENTION.test(content);
}

// Text used for searching: mentions removed, lower-cased with Turkish rules (İ→i, I→ı).
export function searchText(content: string): string {
  return content.replace(USER_MENTION, ' ').toLocaleLowerCase('tr');
}
