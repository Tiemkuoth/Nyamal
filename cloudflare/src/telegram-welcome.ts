export interface TelegramWelcomeMember {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramTextMentionEntity {
  type: "text_mention";
  offset: number;
  length: number;
  user: TelegramWelcomeMember;
}

export interface TelegramWelcomeValues {
  name: string;
  join_context: string;
  member_list: string;
  community: string;
  rules: string;
  links: string;
  questions: string;
}

export interface RenderedTelegramWelcome {
  text: string;
  entities: TelegramTextMentionEntity[];
}

const PLACEHOLDERS = new Set([
  "name", "join_context", "member_list", "community", "rules", "links", "questions",
]);

export function welcomeMemberName(member: TelegramWelcomeMember): string {
  const firstName = cleanName(member.first_name);
  if (firstName) return firstName;
  const lastName = cleanName(member.last_name);
  if (lastName) return lastName;
  const username = cleanName(member.username);
  return username ? username.replace(/^@/, "") : "";
}

export function validWelcomeTemplate(template: string, required: "name" | "member_list"): boolean {
  const placeholders = [...template.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
  return placeholders.every((placeholder) => PLACEHOLDERS.has(placeholder))
    && placeholders.includes(required);
}

export function renderTelegramWelcome(
  template: string,
  members: TelegramWelcomeMember[],
  values: TelegramWelcomeValues,
  mentionMembers: boolean,
): RenderedTelegramWelcome {
  const uniqueMembers = dedupeMembers(members);
  const entities: TelegramTextMentionEntity[] = [];
  let rawText = "";
  let cursor = 0;
  const sourceTemplate = uniqueMembers.length === 1 && !welcomeMemberName(uniqueMembers[0])
    ? template.replace(/,\s*\{name\}/g, "").replace(/\s*\{name\}/g, "")
    : template;
  const pattern = /\{([a-z_]+)\}/g;
  for (const match of sourceTemplate.matchAll(pattern)) {
    const index = match.index ?? 0;
    rawText += sourceTemplate.slice(cursor, index);
    const token = match[1];
    if (token === "member_list") {
      const rendered = memberList(uniqueMembers, mentionMembers);
      const offset = rawText.length;
      rawText += rendered.text;
      entities.push(...rendered.entities.map((entity) => ({ ...entity, offset: entity.offset + offset })));
    } else {
      const member = uniqueMembers[0];
      const label = token === "name" ? (member ? welcomeMemberName(member) : "") : values[token as keyof TelegramWelcomeValues];
      const start = rawText.length;
      rawText += label;
      if (token === "name" && mentionMembers && member && welcomeMemberName(member)) {
        entities.push({ type: "text_mention", offset: start, length: label.length, user: member });
      }
    }
    cursor = index + match[0].length;
  }
  rawText += sourceTemplate.slice(cursor);

  const leadingWhitespace = rawText.length - rawText.trimStart().length;
  const text = rawText.trim();
  const entitiesInText = entities
    .filter((entity) => entity.offset >= leadingWhitespace && entity.offset + entity.length <= leadingWhitespace + text.length)
    .map((entity) => ({ ...entity, offset: entity.offset - leadingWhitespace }));
  return { text, entities: entitiesInText };
}

export function splitTelegramWelcome(
  template: string,
  members: TelegramWelcomeMember[],
  values: TelegramWelcomeValues,
  mentionMembers: boolean,
  maximumLength = 3900,
): RenderedTelegramWelcome[] {
  const uniqueMembers = dedupeMembers(members);
  if (!uniqueMembers.length) throw new Error("Cannot welcome a batch with no members");
  if (uniqueMembers.length === 1) {
    const rendered = renderTelegramWelcome(template, uniqueMembers, values, mentionMembers);
    if (rendered.text.length > maximumLength) throw new Error("Welcome template exceeds Telegram's message limit");
    return [rendered];
  }

  const messages: RenderedTelegramWelcome[] = [];
  let group: TelegramWelcomeMember[] = [];
  for (const member of uniqueMembers) {
    const candidate = [...group, member];
    const rendered = renderTelegramWelcome(template, candidate, values, mentionMembers);
    if (rendered.text.length > maximumLength && group.length) {
      messages.push(renderTelegramWelcome(template, group, values, mentionMembers));
      group = [member];
      const single = renderTelegramWelcome(template, group, values, mentionMembers);
      if (single.text.length > maximumLength) throw new Error("Welcome template exceeds Telegram's message limit");
    } else if (rendered.text.length > maximumLength) {
      throw new Error("Welcome template exceeds Telegram's message limit");
    } else {
      group = candidate;
    }
  }
  if (group.length) messages.push(renderTelegramWelcome(template, group, values, mentionMembers));
  return messages;
}

function memberList(
  members: TelegramWelcomeMember[],
  mentionMembers: boolean,
): { text: string; entities: TelegramTextMentionEntity[] } {
  const labels = members.map((member) => welcomeMemberName(member) || "a new member");
  const entities: TelegramTextMentionEntity[] = [];
  let text = "";
  for (let index = 0; index < members.length; index++) {
    const separator = index === 0 ? "" : index === members.length - 1 ? " and " : ", ";
    text += separator;
    const offset = text.length;
    text += labels[index];
    const member = members[index];
    if (mentionMembers && Number.isSafeInteger(member.id) && member.id > 0) {
      entities.push({ type: "text_mention", offset, length: labels[index].length, user: member });
    }
  }
  return { text, entities };
}

function dedupeMembers(members: TelegramWelcomeMember[]): TelegramWelcomeMember[] {
  const seen = new Set<number>();
  return members.filter((member) => {
    if (!Number.isSafeInteger(member.id) || member.id < 1 || seen.has(member.id)) return false;
    seen.add(member.id);
    return true;
  });
}

function cleanName(value: string | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
