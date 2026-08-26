import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { z } from "zod";
import {
  getCurrentBranch as getCurrentBranchContract,
  getShortcutBinding as getShortcutBindingContract,
  saveShortcutBinding as saveShortcutBindingContract,
} from "./shared";

const execFileAsync = promisify(execFile);
const storageDirectory = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugins",
  "paseo-plugin",
);
const storageFile = join(storageDirectory, "shortcut-bindings.json");

type ShortcutBindings = Record<string, string>;
type GetShortcutBindingInput = z.infer<typeof getShortcutBindingContract.input>;
type SaveShortcutBindingInput = z.infer<typeof saveShortcutBindingContract.input>;
type GetCurrentBranchInput = z.infer<typeof getCurrentBranchContract.input>;

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readBindings(): Promise<ShortcutBindings> {
  try {
    const raw = await readFile(storageFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => key.length > 0 && typeof value === "string" && value.trim().length > 0,
      ),
    );
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

async function writeBindings(bindings: ShortcutBindings) {
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(storageFile, `${JSON.stringify(bindings, null, 2)}\n`, "utf8");
}

export async function getShortcutBinding({ agentId }: GetShortcutBindingInput) {
  const bindings = await readBindings();
  return { branch: bindings[agentId] ?? null };
}

export async function saveShortcutBinding({ agentId, branch }: SaveShortcutBindingInput) {
  const bindings = await readBindings();
  const normalizedBranch = branch.trim();
  bindings[agentId] = normalizedBranch;
  await writeBindings(bindings);
  return { branch: normalizedBranch };
}

export async function getCurrentBranchHandler({ directory }: GetCurrentBranchInput) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, "branch", "--show-current"], {
      encoding: "utf8",
    });
    const currentBranch = stdout.trim();
    return { branch: currentBranch || null };
  } catch {
    return { branch: null };
  }
}
