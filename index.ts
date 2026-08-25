import type { PluginContext } from "@getpaseo/plugin";
import { PromptTemplatesPanel } from "./src/features/prompt-templates/client";
import {
  createPromptTemplate,
  deletePromptTemplate,
  getPromptTemplate,
  listPromptTemplates,
  updatePromptTemplate,
} from "./src/features/prompt-templates/contract";
import {
  createPromptTemplate as createPromptTemplateHandler,
  deletePromptTemplate as deletePromptTemplateHandler,
  getPromptTemplate as getPromptTemplateHandler,
  listPromptTemplates as listPromptTemplatesHandler,
  updatePromptTemplate as updatePromptTemplateHandler,
} from "./src/features/prompt-templates/server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(listPromptTemplates, listPromptTemplatesHandler);
  plugin.handle(getPromptTemplate, getPromptTemplateHandler);
  plugin.handle(createPromptTemplate, createPromptTemplateHandler);
  plugin.handle(updatePromptTemplate, updatePromptTemplateHandler);
  plugin.handle(deletePromptTemplate, deletePromptTemplateHandler);
  plugin.addWorkspacePanel({
    id: "prompt-templates",
    title: "提示词",
    icon: "NotebookPen",
    context: "workspace",
    Component: PromptTemplatesPanel,
  });
  return () => {};
}
