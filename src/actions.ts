import { z } from "zod";

/**
 * The action vocabulary a bug-reproduction agent is allowed to drive the
 * browser with. Everything is validated before it reaches Playwright so a
 * malformed model response can never half-execute.
 */
export const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    url: z.string().min(1),
  }),
  z.object({
    action: z.literal("click"),
    role: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({
    action: z.literal("fill"),
    role: z.string().min(1),
    name: z.string().min(1),
    value: z.string(),
  }),
  z.object({
    action: z.literal("press"),
    key: z.string().min(1),
  }),
]);

export type Action = z.infer<typeof actionSchema>;