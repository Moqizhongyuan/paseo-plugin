import type { PluginContext } from "@getpaseo/plugin";
import { PromptTemplatesPanel } from "./src/features/prompt-templates/client";
import { ShortcutPanel } from "./src/features/shortcut/client";
import {
  createPromptTemplate,
  deletePromptTemplate,
  getPromptTemplate,
  listPromptTemplates,
  updatePromptTemplate,
} from "./src/features/prompt-templates/shared";
import {
  createPromptTemplate as createPromptTemplateHandler,
  deletePromptTemplate as deletePromptTemplateHandler,
  getPromptTemplate as getPromptTemplateHandler,
  listPromptTemplates as listPromptTemplatesHandler,
  updatePromptTemplate as updatePromptTemplateHandler,
} from "./src/features/prompt-templates/server";
import {
  getCurrentBranch,
  getShortcutBinding,
  saveShortcutBinding,
} from "./src/features/shortcut/shared";
import {
  getCurrentBranchHandler,
  getShortcutBinding as getShortcutBindingHandler,
  saveShortcutBinding as saveShortcutBindingHandler,
} from "./src/features/shortcut/server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(listPromptTemplates, listPromptTemplatesHandler);
  plugin.handle(getPromptTemplate, getPromptTemplateHandler);
  plugin.handle(createPromptTemplate, createPromptTemplateHandler);
  plugin.handle(updatePromptTemplate, updatePromptTemplateHandler);
  plugin.handle(deletePromptTemplate, deletePromptTemplateHandler);
  plugin.handle(getShortcutBinding, getShortcutBindingHandler);
  plugin.handle(saveShortcutBinding, saveShortcutBindingHandler);
  plugin.handle(getCurrentBranch, getCurrentBranchHandler);
  plugin.addWorkspacePanel({
    id: "prompt-templates",
    title: "提示词",
    icon: "NotebookPen",
    context: "workspace",
    Component: PromptTemplatesPanel,
  });
  plugin.addWorkspacePanel({
    id: "shortcut",
    title: "快捷命令",
    icon: "Command",
    context: "agent",
    Component: ShortcutPanel,
  });

  plugin.addCommandCenterItem({
    id: "open-shortcut",
    title: "打开快捷命令",
    icon: "Command",
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("shortcut");
    },
  });
  return () => {};
}
