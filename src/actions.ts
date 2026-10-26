import { z } from "zod";

/**
 * The action vocabulary a bug-reproduction agent is allowed to drive the
 * browser with. Everything is validated before it reaches Playwright so a
 * malformed model response can never half-execute.
 */
const gotoAction = z.object({
  action: z.literal("goto"),
  url: z.string().min(1),
});

const clickAction = z.object({
  action: z.literal("click"),
  role: z.string().min(1),
  name: z.string().min(1),
});

const fillAction = z.object({
  action: z.literal("fill"),
  role: z.string().min(1),
  name: z.string().min(1),
  value: z.string(),
});

const pressAction = z.object({
  action: z.literal("press"),
  key: z.string().min(1),
});

export const actionSchema = z.discriminatedUnion("action", [
  gotoAction,
  clickAction,
  fillAction,
  pressAction,
]);

export type Action = z.infer<typeof actionSchema>;

/**
 * A contradiction between the expected and the observed behaviour of one
 * element. `name` is optional because unnamed elements (e.g. `role=status`)
 * are addressed by role alone. Kept independent of the agent actions so
 * emit-test can reuse it.
 */
export const assertionSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1).optional(),
  expected: z.string(),
  actual: z.string(),
});

export type Assertion = z.infer<typeof assertionSchema>;

const reason = z.string().min(1);

export const assertFailActionSchema = assertionSchema.extend({
  action: z.literal("assert_fail"),
  reason,
});

export const giveUpActionSchema = z.object({
  action: z.literal("give_up"),
  reason,
});

/** What the model may emit on one turn: a browser action, an assertion or a surrender. */
export const agentActionSchema = z.discriminatedUnion("action", [
  gotoAction.extend({ reason }),
  clickAction.extend({ reason }),
  fillAction.extend({ reason }),
  pressAction.extend({ reason }),
  assertFailActionSchema,
  giveUpActionSchema,
]);

export type AgentAction = z.infer<typeof agentActionSchema>;