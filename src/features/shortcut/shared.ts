import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

const agentId = z.string().trim().min(1).max(200);
const branch = z.string().trim().min(1).max(200);

export const getShortcutBinding = defineRpc({
  name: "shortcut.binding.get",
  input: z.object({ agentId }),
  output: z.object({ branch: z.string().nullable() }),
});

export const saveShortcutBinding = defineRpc({
  name: "shortcut.binding.save",
  input: z.object({ agentId, branch }),
  output: z.object({ branch: z.string() }),
});

export const getCurrentBranch = defineRpc({
  name: "shortcut.git.current-branch",
  input: z.object({ directory: z.string().trim().min(1) }),
  output: z.object({ branch: z.string().nullable() }),
});
