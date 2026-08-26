import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

const promptId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const promptTitle = z.string().trim().max(200);
const promptContent = z.string().max(1_000_000);

const promptSummary = z.object({
  id: promptId,
  title: z.string(),
  preview: z.string(),
  updatedAt: z.string(),
});

export const promptTemplate = promptSummary.extend({
  content: z.string(),
});

export type PromptSummary = z.infer<typeof promptSummary>;
export type PromptTemplate = z.infer<typeof promptTemplate>;

export const listPromptTemplates = defineRpc({
  name: "prompt-templates.list",
  input: z.object({}),
  output: z.object({ items: z.array(promptSummary) }),
});

export const getPromptTemplate = defineRpc({
  name: "prompt-templates.get",
  input: z.object({ id: promptId }),
  output: promptTemplate,
});

export const createPromptTemplate = defineRpc({
  name: "prompt-templates.create",
  input: z.object({ title: promptTitle, content: promptContent }),
  output: promptTemplate,
});

export const updatePromptTemplate = defineRpc({
  name: "prompt-templates.update",
  input: z.object({ id: promptId, title: promptTitle, content: promptContent }),
  output: promptTemplate,
});

export const deletePromptTemplate = defineRpc({
  name: "prompt-templates.delete",
  input: z.object({ id: promptId }),
  output: z.object({ deleted: z.boolean() }),
});
